/**
 * Layout: the fixed geometry of the lanes view and how lanes stack up vertically.
 *
 * The view is a label column (the gutter) on the left, a time plot on the right, a ruler band on
 * top and a scrolling stack of lanes below. The ruler and the gutter stay put while the lanes
 * scroll. Everything is in CSS pixels in view coordinates (origin at the top-left corner of the
 * surface), except "content" coordinates, which start at the top of the first lane (scrolling
 * changes the offset between the two).
 *
 * Two pieces:
 *
 * - {@link LanesLayout} is the geometry of one view size ({@link computeLayout}), the same for
 *   every lane.
 * - {@link LaneStack} is the vertical arrangement of the lanes that are shown: which lanes (peer
 *   lanes can be hidden), in which order, and how tall each is for its {@link LaneMode}. Heights are
 *   prefix sums, so finding the lane under a y coordinate is a binary search ({@link laneAt}).
 *
 * A lane is one of three things on screen: `collapsed` (one summary row), `capped` (its first
 * `maxRows` levels, plus an overflow row when it has more) or `full` (every level). Rebuilding the
 * stack costs `O(lanes)`; it never repacks anything.
 *
 * Headless: no DOM, no browser globals.
 */

import { clampScrollTop, maxScrollTop, type ListMetrics } from '../../../kit/geometry/virtual-list.ts';
import { LaneKind, type LaneModel } from './lanes.ts';

/** Sizes that can be configured. Use {@link resolveMetrics} to fill in defaults and drop bad values. */
export interface LanesMetrics {
  /** Height of one level row including the gap below the bar, px. */
  readonly rowHeight: number;
  /** Height of a span bar, px; the bar is centred in its row. */
  readonly barHeight: number;
  /** Height of the summary row of a collapsed lane and of the overflow row of a capped one, px. */
  readonly summaryHeight: number;
  /** Height of the time ruler above the lanes, px. */
  readonly headerHeight: number;
  /** Wanted width of the label column, px; it never takes more than half of the view. */
  readonly gutterWidth: number;
  /** Space kept free right of the plot so that the last tick label fits, px. */
  readonly plotPaddingRight: number;
  /** Level rows a capped lane shows before its overflow row; a whole number of at least 1. */
  readonly maxRows: number;
}

/** The defaults: 16 px bars in 18 px rows, 24 px summaries, a 40 px ruler, a 220 px label column, 16 rows per capped lane. */
export const DEFAULT_METRICS: LanesMetrics = Object.freeze({
  rowHeight: 18,
  barHeight: 16,
  summaryHeight: 24,
  headerHeight: 40,
  gutterWidth: 220,
  plotPaddingRight: 24,
  maxRows: 16,
});

/** Left padding of the gutter, px. */
export const GUTTER_PADDING = 8;
/** Width of the box a lane's chevron is drawn in, px. */
export const CHEVRON_SIZE = 16;

/** How a lane is shown. The numbers index the `modes` array of a view state. */
export enum LaneMode {
  /** One summary row: the in-flight count over time, as an area. */
  Collapsed = 0,
  /** The first `maxRows` levels, and an overflow row for the rest. */
  Capped = 1,
  /** Every level. */
  Full = 2,
}

/** The names of the modes, as saved in view state (`LANE_MODE_NAMES[LaneMode.Capped] === 'capped'`). */
export const LANE_MODE_NAMES: readonly ('collapsed' | 'capped' | 'full')[] = ['collapsed', 'capped', 'full'];

/** A mode from its saved name, or `undefined` for anything else. */
export function parseLaneMode(name: unknown): LaneMode | undefined {
  const mode = LANE_MODE_NAMES.indexOf(name as 'collapsed');
  return mode < 0 ? undefined : (mode as LaneMode);
}

/** Fill in the defaults and replace anything that is not a usable size. */
export function resolveMetrics(overrides: Partial<LanesMetrics> = {}): LanesMetrics {
  const pick = (value: number | undefined, fallback: number, min: number): number =>
    value !== undefined && Number.isFinite(value) && value >= min ? value : fallback;

  const rowHeight = pick(overrides.rowHeight, DEFAULT_METRICS.rowHeight, 1);
  const barHeight = Math.min(pick(overrides.barHeight, DEFAULT_METRICS.barHeight, 1), rowHeight);
  return {
    rowHeight,
    barHeight,
    summaryHeight: pick(overrides.summaryHeight, DEFAULT_METRICS.summaryHeight, 1),
    headerHeight: pick(overrides.headerHeight, DEFAULT_METRICS.headerHeight, 0),
    gutterWidth: pick(overrides.gutterWidth, DEFAULT_METRICS.gutterWidth, 0),
    plotPaddingRight: pick(overrides.plotPaddingRight, DEFAULT_METRICS.plotPaddingRight, 0),
    maxRows: Math.floor(pick(overrides.maxRows, DEFAULT_METRICS.maxRows, 1)),
  };
}

/** The geometry for one view size, from {@link computeLayout}. */
export interface LanesLayout {
  /** Width of the view, px. */
  readonly width: number;
  /** Height of the view, px. */
  readonly height: number;
  readonly rowHeight: number;
  readonly barHeight: number;
  /** Distance from the top of a level row to the top of its bar, px. */
  readonly barInset: number;
  /** Height of a summary or overflow row. */
  readonly summaryHeight: number;
  /** Height of the ruler; the lanes start right below it. */
  readonly headerHeight: number;
  /** Height of the area the lanes scroll in. */
  readonly bodyHeight: number;
  /** Width of the label column. */
  readonly gutterWidth: number;
  /** Where the plot starts; equals `gutterWidth`. */
  readonly plotLeft: number;
  /** Width of the time axis, px: the camera is sized to it. 0 when the view is too small. */
  readonly plotWidth: number;
  /** Level rows a capped lane shows. */
  readonly maxRows: number;
}

/**
 * Compute the layout for a view size.
 *
 * @param metrics - Configured sizes.
 * @param width - Width of the view, px; anything not finite and positive counts as 0.
 * @param height - Height of the view, px.
 */
export function computeLayout(metrics: LanesMetrics, width: number, height: number): LanesLayout {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  const gutterWidth = Math.min(metrics.gutterWidth, Math.floor(w / 2));
  return {
    width: w,
    height: h,
    rowHeight: metrics.rowHeight,
    barHeight: metrics.barHeight,
    barInset: (metrics.rowHeight - metrics.barHeight) / 2,
    summaryHeight: metrics.summaryHeight,
    headerHeight: metrics.headerHeight,
    bodyHeight: Math.max(0, h - metrics.headerHeight),
    gutterWidth,
    plotLeft: gutterWidth,
    plotWidth: Math.max(0, w - gutterWidth - metrics.plotPaddingRight),
    maxRows: metrics.maxRows,
  };
}

/**
 * The lanes that are shown, from top to bottom, and where each one is.
 *
 * Position `k` (`0 … count - 1`) is the `k`-th shown lane; `lane[k]` is its lane id in the
 * {@link LaneModel}. Content y of position `k` starts at `top[k]`; `top[count]` is the content
 * height. Instances never change.
 */
export interface LaneStack {
  /** Number of lanes shown. */
  readonly count: number;
  /** Lane id at each position. */
  readonly lane: Int32Array;
  /** Position of each lane id, or -1 when it is hidden. */
  readonly positionOfLane: Int32Array;
  /** Content y of the top of each position; `count + 1` entries, the last is {@link LaneStack.contentHeight}. */
  readonly top: Float64Array;
  /** {@link LaneMode} of each position. */
  readonly mode: Uint8Array;
  /** Level rows each position shows (0 when collapsed). */
  readonly levels: Int32Array;
  /** Levels each position hides behind its overflow row (0 when it has no overflow row). */
  readonly hidden: Int32Array;
  /** Total height of the lanes, px. */
  readonly contentHeight: number;
  /** The mode of every lane id (also of hidden lanes) this stack was made from. */
  readonly modes: Uint8Array;
}

/** A mode for every lane: the starting point of a view. */
export function defaultModes(model: LaneModel, mode: LaneMode = LaneMode.Capped): Uint8Array {
  return new Uint8Array(model.laneCount).fill(mode);
}

/**
 * Stack the shown lanes.
 *
 * A collapsed lane is one summary row tall. Any other lane is its level rows tall; a capped lane
 * with more than `maxRows` levels shows `maxRows` of them and an overflow row of summary height.
 *
 * @param model - The lanes.
 * @param layout - Row and summary heights and `maxRows`.
 * @param order - Lane ids in display order (`orderLanes`, or `LaneModel.order`).
 * @param showPeers - Whether lanes of kind {@link LaneKind.Peer} are shown.
 * @param modes - {@link LaneMode} of every lane id.
 */
export function stackLanes(
  model: LaneModel,
  layout: LanesLayout,
  order: Int32Array,
  showPeers: boolean,
  modes: Uint8Array,
): LaneStack {
  const lane = new Int32Array(order.length);
  let count = 0;
  for (let p = 0; p < order.length; p++) {
    if (showPeers || model.kind[order[p]] !== LaneKind.Peer) lane[count++] = order[p];
  }

  const positionOfLane = new Int32Array(model.laneCount).fill(-1);
  const top = new Float64Array(count + 1);
  const mode = new Uint8Array(count);
  const levels = new Int32Array(count);
  const hidden = new Int32Array(count);
  let y = 0;
  for (let k = 0; k < count; k++) {
    const id = lane[k];
    positionOfLane[id] = k;
    top[k] = y;
    const m = modes[id] as LaneMode;
    mode[k] = m;
    if (m === LaneMode.Collapsed) {
      y += layout.summaryHeight;
      continue;
    }
    const all = Math.max(1, model.levelCount[id]);
    const shown = m === LaneMode.Capped ? Math.min(all, layout.maxRows) : all;
    levels[k] = shown;
    hidden[k] = all - shown;
    y += shown * layout.rowHeight + (hidden[k] > 0 ? layout.summaryHeight : 0);
  }
  top[count] = y;
  return { count, lane: lane.subarray(0, count), positionOfLane, top, mode, levels, hidden, contentHeight: y, modes };
}

/** Height of the lane at position `k`, px. */
export function laneHeight(stack: LaneStack, k: number): number {
  return stack.top[k + 1] - stack.top[k];
}

/**
 * The position of the lane at content y, by binary search; -1 above the first lane, below the last
 * one, or when there are no lanes.
 */
export function laneAt(stack: LaneStack, contentY: number): number {
  if (!(contentY >= 0) || !(contentY < stack.contentHeight)) return -1;
  let lo = 0;
  let hi = stack.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (stack.top[mid] <= contentY) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** What a row of a lane is. */
export enum LaneRowKind {
  /** A level row: `level` says which. */
  Level = 0,
  /** The summary row of a collapsed lane. */
  Summary = 1,
  /** The overflow row of a capped lane. */
  Overflow = 2,
}

/** A row inside a lane; reuse one object. */
export interface LaneRow {
  kind: LaneRowKind;
  /** Level of a {@link LaneRowKind.Level} row, else -1. */
  level: number;
}

/** An empty row to pass to {@link rowInLane}. */
export function createLaneRow(): LaneRow {
  return { kind: LaneRowKind.Summary, level: -1 };
}

/**
 * Which row of the lane at position `k` is at `offset` px below the lane's top.
 *
 * @param stack - The stacked lanes.
 * @param layout - Geometry.
 * @param k - Position of the lane.
 * @param offset - Distance from the top of the lane, px; clamped into the lane.
 * @param out - Receives the row.
 */
export function rowInLane(stack: LaneStack, layout: LanesLayout, k: number, offset: number, out: LaneRow): LaneRow {
  out.level = -1;
  if (stack.mode[k] === LaneMode.Collapsed) {
    out.kind = LaneRowKind.Summary;
    return out;
  }
  const level = Math.floor(Math.max(0, offset) / layout.rowHeight);
  if (level < stack.levels[k]) {
    out.kind = LaneRowKind.Level;
    out.level = level;
  } else {
    out.kind = LaneRowKind.Overflow;
  }
  return out;
}

/** Content y of the top of a level row of the lane at position `k`. */
export function levelTop(stack: LaneStack, layout: LanesLayout, k: number, level: number): number {
  return stack.top[k] + level * layout.rowHeight;
}

/** Content y of the top of the overflow row of the lane at position `k` (only meaningful when it has one). */
export function overflowTop(stack: LaneStack, layout: LanesLayout, k: number): number {
  return stack.top[k] + stack.levels[k] * layout.rowHeight;
}

/** Top edge of a content y in view coordinates, for the given scroll position. */
export function viewY(layout: LanesLayout, contentY: number, scrollTop: number): number {
  return layout.headerHeight + contentY - scrollTop;
}

/** The content y under a view y, for the given scroll position. */
export function contentY(layout: LanesLayout, y: number, scrollTop: number): number {
  return y - layout.headerHeight + scrollTop;
}

/** The scroll geometry for the stacked lanes: the content is one tall row, so the virtual-list clamps apply. */
export function listMetrics(layout: LanesLayout, stack: LaneStack): ListMetrics {
  return { rowHeight: 1, rowCount: Math.ceil(stack.contentHeight), viewportHeight: layout.bodyHeight };
}

/** Bring a scroll position into the range the content allows. */
export function clampScroll(layout: LanesLayout, stack: LaneStack, scrollTop: number): number {
  return clampScrollTop(listMetrics(layout, stack), scrollTop);
}

/** Largest scroll position. */
export function maxScroll(layout: LanesLayout, stack: LaneStack): number {
  return maxScrollTop(listMetrics(layout, stack));
}

/**
 * The scroll position that brings the stretch `top … top + height` (content y) into view.
 *
 * With `nearest` nothing moves when it is already fully visible; a stretch above the viewport is
 * aligned to its top edge, one below to its bottom edge (taller than the viewport: to the top).
 * With `center` it is put in the middle. The result is always within the scrollable range.
 */
export function scrollToRange(
  layout: LanesLayout,
  stack: LaneStack,
  scrollTop: number,
  top: number,
  height: number,
  align: 'nearest' | 'center',
): number {
  const current = clampScroll(layout, stack, scrollTop);
  if (align === 'center') return clampScroll(layout, stack, top + (height - layout.bodyHeight) / 2);
  if (top < current) return clampScroll(layout, stack, top);
  if (top + height > current + layout.bodyHeight) {
    return clampScroll(layout, stack, Math.min(top + height - layout.bodyHeight, top));
  }
  return current;
}

/**
 * The positions of the lanes that intersect the content stretch `from … to`, inclusive;
 * `last < first` when there are none.
 */
export function lanesIn(stack: LaneStack, from: number, to: number): { first: number; last: number } {
  if (stack.count === 0 || !(to >= from) || to < 0 || from >= stack.contentHeight) return { first: 0, last: -1 };
  return { first: laneAt(stack, Math.max(0, from)), last: laneAt(stack, Math.min(to, stack.contentHeight - 1e-6)) };
}

/** The track an item is on: binary search of {@link LaneModel.trackItemOff}. */
export function trackOfItem(model: LaneModel, item: number): number {
  const off = model.trackItemOff;
  let lo = 0;
  let hi = off.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (off[mid] <= item) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The lane a track belongs to: binary search of {@link LaneModel.laneTrackOff}. */
export function laneOfTrack(model: LaneModel, track: number): number {
  const off = model.laneTrackOff;
  let lo = 0;
  let hi = off.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (off[mid] <= track) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
