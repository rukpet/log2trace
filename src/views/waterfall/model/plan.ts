/**
 * FramePlan: everything a painter needs to draw one frame, as numbers.
 *
 * The plan is built for the rows in view from the row projection, the camera
 * and the scroll position. It decides what is drawn (which bars are visible,
 * how wide, which event markers survive, where each duration label goes), so
 * the Canvas and DOM painters, which only turn the plan into pixels or
 * elements, always agree.
 *
 * The plan is a set of preallocated typed arrays that are rewritten in place
 * every frame: no allocation while zooming and panning (apart from the short
 * duration strings). Painters must read the arrays from the plan object each
 * frame rather than keep references, because they are replaced when the plan has
 * to grow.
 *
 * Headless: no DOM, no browser globals.
 */

import type { Camera1D } from '../../../kit/geometry/camera1d.ts';
import { clampScrollTop, visibleRange, type RowRange } from '../../../kit/geometry/virtual-list.ts';
import { formatDuration } from '../../../core/format.ts';
import type { SpanIndex } from '../../../core/span-index.ts';
import type { SpanMask } from '../../../core/span-set.ts';
import { barExtent, createBarExtent, eventMarkers, MAX_EVENT_MARKERS } from './bars.ts';
import { listMetrics, rowTop, type WaterfallLayout } from './layout.ts';
import { chevronOf, type RowProjection } from './rows.ts';

/** Where the duration text of a bar goes. */
export enum LabelMode {
  /** No room: do not draw it. */
  Hidden = 0,
  /** Inside the bar, at its left edge. */
  Inside = 1,
  /** Just right of the bar. */
  Right = 2,
  /** Just left of the bar. */
  Left = 3,
}

/** Bits of {@link FramePlan.flags}. */
export enum RowFlag {
  /** The row is only the ancestor of a filter match: draw it dimmed. */
  Context = 1,
  /** The span ended with an error. */
  Error = 2,
  /** The bar starts left of the plot. */
  ClippedLeft = 4,
  /** The bar ends right of the plot. */
  ClippedRight = 8,
  /** Some part of the bar is inside the plot: draw it. */
  BarVisible = 16,
}

/** Gap between a bar and its duration text, px. */
export const LABEL_PADDING = 4;
/** Rows a new plan has room for before it has to grow. */
export const DEFAULT_PLAN_ROWS = 128;

/** What {@link buildFramePlan} reads. */
export interface PlanInput {
  /** The loaded trace. */
  readonly index: SpanIndex;
  /** The rows shown. */
  readonly projection: RowProjection;
  /** Collapsed spans, for the chevrons. */
  readonly collapsed: SpanMask | null;
  /** View geometry. */
  readonly layout: WaterfallLayout;
  /** The visible time window, sized to the plot. */
  readonly camera: Camera1D;
  /** Scroll position of the rows, px; clamped to the scrollable range. */
  readonly scrollTop: number;
  /** Rows to plan beyond the visible ones, above and below. Default 0. */
  readonly overscan?: number;
  /** Plan these rows instead of the visible ones (for export or tests). Clamped to the rows that exist. */
  readonly rows?: RowRange;
  /** Width of a text in the label font, px. */
  readonly measureText: (text: string) => number;
}

/** The numbers for one frame. Row `j` below is the `j`-th planned row, which is waterfall row `firstRow + j`. */
export class FramePlan {
  /** Number of rows planned. */
  count = 0;
  /** Waterfall row of the first planned row. */
  firstRow = 0;
  /** The scroll position the plan was made for, after clamping. */
  scrollTop = 0;
  /** Rows the arrays have room for. */
  capacity = 0;

  /** Table row of the span. */
  idx = new Int32Array(0);
  /** Top edge of the row in view coordinates, px. */
  y = new Float32Array(0);
  /** Left edge of the bar, plot px (clipped to just outside the plot). */
  barX0 = new Float32Array(0);
  /** Right edge of the bar, plot px (clipped to just outside the plot). */
  barX1 = new Float32Array(0);
  /** Span kind, as in the table (index into the palette). */
  kind = new Uint8Array(0);
  /** OR of {@link RowFlag} bits. */
  flags = new Uint8Array(0);
  /** A {@link views/waterfall/model/rows.Chevron | Chevron} value. */
  chevron = new Uint8Array(0);
  /** A {@link LabelMode} value. */
  labelMode = new Uint8Array(0);
  /** Left edge of the duration text, plot px; meaningful unless the label is hidden. */
  labelX = new Float32Array(0);
  /** Duration text of each bar. */
  durationText: string[] = [];
  /** Event markers of row `j` are `evX[evOff[j] … evOff[j + 1] - 1]`; `count + 1` entries. */
  evOff = new Int32Array(1);
  /** Event marker positions, plot px. */
  evX = new Float32Array(0);

  /**
   * @param rows - Rows to have room for at the start.
   */
  constructor(rows: number = DEFAULT_PLAN_ROWS) {
    this.reserve(rows);
  }

  /** Make sure the arrays can hold `rows` rows. Existing contents are not kept. */
  reserve(rows: number): void {
    if (rows <= this.capacity) return;
    let capacity = Math.max(this.capacity, 16);
    while (capacity < rows) capacity *= 2;
    this.capacity = capacity;
    this.idx = new Int32Array(capacity);
    this.y = new Float32Array(capacity);
    this.barX0 = new Float32Array(capacity);
    this.barX1 = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.chevron = new Uint8Array(capacity);
    this.labelMode = new Uint8Array(capacity);
    this.labelX = new Float32Array(capacity);
    this.durationText = new Array<string>(capacity).fill('');
    this.evOff = new Int32Array(capacity + 1);
    this.evX = new Float32Array(capacity * MAX_EVENT_MARKERS);
  }
}

const scratchExtent = createBarExtent();

/**
 * Decide where the duration text of a bar goes: inside the bar when it fits, else beside it on
 * the side that has room, else nowhere.
 */
function placeLabel(plan: FramePlan, j: number, x0: number, x1: number, plotWidth: number, textWidth: number): void {
  if (textWidth + 2 * LABEL_PADDING <= x1 - x0) {
    plan.labelMode[j] = LabelMode.Inside;
    plan.labelX[j] = x0 + LABEL_PADDING;
  } else if (x1 + LABEL_PADDING + textWidth <= plotWidth) {
    plan.labelMode[j] = LabelMode.Right;
    plan.labelX[j] = x1 + LABEL_PADDING;
  } else if (x0 - LABEL_PADDING - textWidth >= 0) {
    plan.labelMode[j] = LabelMode.Left;
    plan.labelX[j] = x0 - LABEL_PADDING - textWidth;
  } else {
    plan.labelMode[j] = LabelMode.Hidden;
    plan.labelX[j] = 0;
  }
}

/**
 * Fill `plan` for the rows in view.
 *
 * @param plan - The plan to rewrite; grown if the rows do not fit.
 * @param input - The state to plan from.
 */
export function buildFramePlan(plan: FramePlan, input: PlanInput): void {
  const { index, projection, layout, camera } = input;
  const { table } = index;
  const metrics = listMetrics(layout, projection.count);
  const scrollTop = clampScrollTop(metrics, input.scrollTop);
  plan.scrollTop = scrollTop;

  let range: RowRange;
  if (input.rows !== undefined) {
    range = { first: Math.max(0, input.rows.first), last: Math.min(projection.count - 1, input.rows.last) };
  } else {
    range = visibleRange(metrics, scrollTop, input.overscan ?? 0);
  }
  if (range.last < range.first) {
    plan.count = 0;
    plan.firstRow = 0;
    plan.evOff[0] = 0;
    return;
  }

  const rows = range.last - range.first + 1;
  plan.reserve(rows);
  plan.count = rows;
  plan.firstRow = range.first;

  const plotWidth = layout.plotWidth;
  let markers = 0;
  for (let j = 0; j < rows; j++) {
    const row = range.first + j;
    const span = projection.rows[row];
    const start = table.start[span];
    const end = table.end[span];
    const extent = barExtent(camera, start, end, scratchExtent);

    plan.idx[j] = span;
    plan.y[j] = rowTop(layout, row, scrollTop);
    plan.kind[j] = table.kind[span];
    plan.chevron[j] = chevronOf(index, projection, input.collapsed, row);
    plan.barX0[j] = extent.x0;
    plan.barX1[j] = extent.x1;

    let flags = 0;
    if (projection.context[row] === 1) flags |= RowFlag.Context;
    if (table.status[span] === 2) flags |= RowFlag.Error;
    if (extent.visible) flags |= RowFlag.BarVisible;
    if (extent.clippedLeft) flags |= RowFlag.ClippedLeft;
    if (extent.clippedRight) flags |= RowFlag.ClippedRight;
    plan.flags[j] = flags;

    const text = formatDuration(Math.max(0, end - start));
    plan.durationText[j] = text;
    if (extent.visible) {
      placeLabel(plan, j, extent.x0, extent.x1, plotWidth, input.measureText(text));
    } else {
      plan.labelMode[j] = LabelMode.Hidden;
      plan.labelX[j] = 0;
    }

    plan.evOff[j] = markers;
    markers += eventMarkers(table, span, camera, extent, plan.evX, markers, MAX_EVENT_MARKERS);
  }
  plan.evOff[rows] = markers;
}
