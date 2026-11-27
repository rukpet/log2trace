/**
 * LanesFramePlan: everything a painter needs to draw one frame of the lanes view, as numbers.
 *
 * The plan is built for the lanes in view from the stack of lanes, the camera and the scroll
 * position. It decides what is drawn: which runs of bars survive level-of-detail merging, where a
 * label fits, what each lane header says, which summary and overflow paths to draw and where the
 * ruler ticks are. The DOM painter only turns the plan into elements, and the hit test reads the
 * same plan, so drawing and picking always agree.
 *
 * Level of detail (per visible track, i.e. per level row of a lane):
 *
 * - items of a track are sorted and disjoint, so the first one that can be on screen is found by
 *   binary search on the item ends, and the walk stops at the first item that starts after the window;
 * - an item whose pixel gap to the run being built is under `mergeGap` joins that run; a run of one
 *   item is a normal bar, a longer one a merged bar;
 * - a run keeps its first item, item count, dominant kind (by pixel width) and OR-ed flags;
 * - if the frame has more than {@link MAX_BARS} runs, `mergeGap` doubles and the frame is planned
 *   again, so the element count of a frame is bounded however many spans there are.
 *
 * Only tracks in the vertical viewport (plus overscan) are planned. The plan is a set of
 * preallocated typed arrays that are rewritten in place every frame: no allocation while zooming and
 * panning, apart from the short label, stats and path strings. Painters must read the arrays from the
 * plan object each frame rather than keep references, because they are replaced when the plan has to
 * grow.
 *
 * Collapsed lanes and overflow rows are drawn as summaries: an area of the in-flight count (the
 * maximum per pixel column) and a path of error ticks, one string each. With a filter only matched
 * spans count, so the summary shows where the matches cluster.
 *
 * Headless: no DOM, no browser globals.
 */

import { pxPerMs, type Camera1D } from '../../../kit/geometry/camera1d.ts';
import { barExtent, createBarExtent, lowerBound } from '../../../kit/geometry/extent.ts';
import { niceTicks } from '../../../kit/geometry/ticks.ts';
import type { SpanIndex } from '../../../core/span-index.ts';
import type { SpanMask } from '../../../core/span-set.ts';
import { LaneKind, matchedSteps, type LaneModel } from './lanes.ts';
import {
  LaneMode,
  clampScroll,
  lanesIn,
  laneHeight,
  levelTop,
  overflowTop,
  viewY,
  type LaneStack,
  type LanesLayout,
} from './layout.ts';
import { sampleColumns, stepsOfRows, type Steps } from './summary.ts';

/** Most runs (bars, merged or not) in one frame; chrome (headers, summaries, ticks) comes on top. */
export const MAX_BARS = 2500;
/** Pixel gap under which two items of a track are merged into one run, before the budget doubles it. */
export const MERGE_GAP_PX = 2;
/** Narrowest single bar that gets a label, px. */
export const LABEL_MIN_WIDTH = 40;
/** Space between a bar's edge and its label text, px. */
export const LABEL_PADDING = 4;
/** Length of an error tick in a summary row, px. */
export const ERROR_TICK_PX = 8;

/** Bits of {@link LanesFramePlan.runFlags}. */
export enum RunFlag {
  /** Some span of the run ended with an error. */
  Error = 1,
  /** A filter is active and no span of the run matched it: draw it dimmed. */
  Dimmed = 2,
  /** A span is selected and some span of the run is its ancestor or part of its subtree. */
  Related = 4,
  /** A span is selected and no span of the run is related to it: draw it faded. */
  Faded = 8,
  /** The run is a ghost: the call seen from the caller, on a peer lane. */
  Ghost = 16,
  /** The run holds more than one span. */
  Merged = 32,
  /** The first bar of the run starts left of the plot. */
  ClippedLeft = 64,
  /** Some bar of the run ends right of the plot. */
  ClippedRight = 128,
  /** Some span of the run is in the selection. */
  Selected = 256,
  /** Some span of the run is in the hover. */
  Hovered = 512,
}

/** What a summary slot of the plan is. */
export enum SummaryKind {
  /** The summary row of a collapsed lane: every span of the lane. */
  Collapsed = 0,
  /** The overflow row of a capped lane: the levels it hides. */
  Overflow = 1,
}

/** Rows (lanes) a new plan has room for before it has to grow; runs always have room for {@link MAX_BARS}. */
export const DEFAULT_PLAN_ROWS = 64;

// -----------------------------------------------------------------------------
// Selection masks
// -----------------------------------------------------------------------------

/** What the plan and the interaction need to know about a selection, as one byte per table row. */
export interface SelectionMasks {
  /** 1 for a selected row. */
  readonly selected: Uint8Array;
  /** 1 for a row that is an ancestor of a selected row or inside the subtree of one (the selected rows included). */
  readonly related: Uint8Array;
  /** Number of selected rows. */
  readonly count: number;
  /** Earliest start of the selected rows, ms. */
  readonly start: number;
  /** Latest end of the selected rows, ms. */
  readonly end: number;
}

/** A row mask with 1 at each of `rows`. */
export function markRows(index: SpanIndex, rows: Iterable<number>): Uint8Array {
  const mask = new Uint8Array(index.table.length);
  for (const row of rows) mask[row] = 1;
  return mask;
}

/**
 * Work out the causal tree of a selection: ancestors through the `parent` chain, descendants as the
 * pre-order range `[row, subtreeEnd)`. Costs `O(rows + selected × depth)`.
 */
export function selectionMasks(index: SpanIndex, rows: readonly number[]): SelectionMasks {
  const { parent, subtreeEnd, start, end, length } = index.table;
  const selected = new Uint8Array(length);
  const related = new Uint8Array(length);
  const diff = new Int32Array(length + 1);
  let first = Infinity;
  let last = -Infinity;
  let count = 0;
  for (const row of rows) {
    if (selected[row] === 1) continue;
    selected[row] = 1;
    count++;
    diff[row]++;
    diff[subtreeEnd[row]]--;
    for (let q = parent[row]; q >= 0 && related[q] === 0; q = parent[q]) related[q] = 1;
    if (start[row] < first) first = start[row];
    const e = end[row] > start[row] ? end[row] : start[row];
    if (e > last) last = e;
  }
  let running = 0;
  for (let r = 0; r < length; r++) {
    running += diff[r];
    if (running > 0) related[r] = 1;
  }
  return { selected, related, count, start: count > 0 ? first : 0, end: count > 0 ? last : 0 };
}

// -----------------------------------------------------------------------------
// Summaries
// -----------------------------------------------------------------------------

/**
 * The in-flight step functions the summary rows draw, cached.
 *
 * Without a filter these are the precomputed `LaneModel.steps`; with one they are built per lane
 * on first use and kept until the mask or the model changes, so a frame never rebuilds them. The
 * overflow row of a capped lane counts the levels it hides (`maxRows` and above).
 */
export class SummarySource {
  readonly model: LaneModel;
  private mask: SpanMask | null = null;
  private maxRows = 0;
  private matched: (Steps | undefined)[];
  private hidden: (Steps | undefined)[];

  constructor(model: LaneModel) {
    this.model = model;
    this.matched = new Array<Steps | undefined>(model.laneCount);
    this.hidden = new Array<Steps | undefined>(model.laneCount);
  }

  private sync(mask: SpanMask | null, maxRows: number): void {
    if (mask !== this.mask) {
      this.mask = mask;
      this.matched.fill(undefined);
      this.hidden.fill(undefined);
    }
    if (maxRows !== this.maxRows) {
      this.maxRows = maxRows;
      this.hidden.fill(undefined);
    }
  }

  /** In-flight count of a lane (what `LaneModel.steps` holds), counting only matched spans when `mask` is set. */
  steps(lane: number, mask: SpanMask | null): Steps {
    if (mask === null) return this.model.steps[lane];
    this.sync(mask, this.maxRows);
    return (this.matched[lane] ??= matchedSteps(this.model, lane, mask));
  }

  /** In-flight count of the levels a capped lane hides, that is every item on level `maxRows` and above. */
  overflow(lane: number, maxRows: number, mask: SpanMask | null): Steps {
    this.sync(mask, maxRows);
    return (this.hidden[lane] ??= this.buildOverflow(lane, maxRows, mask));
  }

  private buildOverflow(lane: number, maxRows: number, mask: SpanMask | null): Steps {
    const m = this.model;
    const t = m.index.table;
    const from = m.laneTrackOff[lane] + maxRows;
    const to = m.laneTrackOff[lane + 1];
    if (from >= to) return stepsOfRows(m.itemRow, 0, 0, t.start, t.end);
    return stepsOfRows(m.itemRow, m.trackItemOff[from], m.trackItemOff[to], t.start, t.end, mask?.bits ?? null);
  }
}

/** Percentage of the trace a lane is busy, a whole number; 0 for none, and 1 for anything below one percent but busy. */
export function laneBusyPercent(model: LaneModel, lane: number): number {
  const extent = model.index.table.extentMs;
  if (!(extent > 0) || !(model.busyMs[lane] > 0)) return 0;
  return Math.max(1, Math.min(100, Math.round((model.busyMs[lane] / extent) * 100)));
}

/** The stats readout of a lane header: `412 spans · 38% busy · peak 8 · 3 errors`. */
export function laneStatsText(model: LaneModel, lane: number): string {
  const spans = model.spanCount[lane];
  const parts = [`${spans} ${spans === 1 ? 'span' : 'spans'}`, `${laneBusyPercent(model, lane)}% busy`, `peak ${model.peak[lane]}`];
  const errors = model.errorCount[lane];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  return parts.join(' · ');
}

/** Height of the area a summary draws, in a row of `height` px: a 2 px margin above, 1 px below. */
function areaHeight(height: number): number {
  return Math.max(1, height - 3);
}

/**
 * The SVG path data of an in-flight area: a step outline of the maximum count per pixel column, closed
 * along the bottom of a row `height` px tall. Counts are scaled to `peak`, so the shape is stable while
 * zooming. Empty when nothing is in flight in the window.
 *
 * @param steps - The count over time.
 * @param camera - The window; one column per pixel of its width.
 * @param height - Height of the row, px.
 * @param peak - Count that fills the row.
 * @param scratch - Receives the per-column counts; needs one entry per column.
 */
export function areaPath(steps: Steps, camera: Camera1D, height: number, peak: number, scratch: Int32Array): string {
  const columns = Math.max(1, Math.floor(camera.widthPx));
  if (peak <= 0 || sampleColumns(steps, camera.t0, camera.t1, columns, scratch) === 0) return '';
  const base = height - 1;
  const room = areaHeight(height);
  const yOf = (count: number): number => (count <= 0 ? base : base - Math.min(room, Math.max(1, Math.round((count / peak) * room))));

  let d = `M0 ${base}`;
  let previous = -1;
  for (let c = 0; c < columns; c++) {
    const count = scratch[c];
    if (count === previous) continue;
    d += c === 0 ? `V${yOf(count)}` : `H${c}V${yOf(count)}`;
    previous = count;
  }
  return `${d}H${columns}V${base}Z`;
}

/**
 * The SVG path data of the error ticks of a lane in the window: a short vertical stroke at the start
 * of each failed span, one per pixel column.
 *
 * @param model - The lanes.
 * @param lane - Lane id.
 * @param camera - The window.
 * @param mask - Only matched spans count when set (a filter's `SpanMask.bits`).
 * @param minLevel - Only spans on this level or above count: 0 for a collapsed lane, `maxRows` for its overflow row.
 */
export function errorPath(model: LaneModel, lane: number, camera: Camera1D, mask: Uint8Array | null, minLevel: number): string {
  const { errorOff, errorRow, errorStart } = model;
  const levels = model.kind[lane] === LaneKind.Peer ? model.ghostLevelOfRow : model.levelOfRow;
  const scale = pxPerMs(camera);
  const to = errorOff[lane + 1];
  let d = '';
  let lastX = NaN;
  for (let k = lowerBound(errorStart, errorOff[lane], to, camera.t0); k < to; k++) {
    if (errorStart[k] > camera.t1) break;
    const row = errorRow[k];
    if (mask !== null && mask[row] !== 1) continue;
    if (minLevel > 0 && levels[row] < minLevel) continue;
    const x = Math.round((errorStart[k] - camera.t0) * scale);
    if (x === lastX) continue;
    lastX = x;
    d += `M${x} 0V${ERROR_TICK_PX}`;
  }
  return d;
}

// -----------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------

/** What {@link buildLanesPlan} reads. */
export interface PlanInput {
  readonly model: LaneModel;
  readonly layout: LanesLayout;
  /** The lanes shown, in order, with their heights. */
  readonly stack: LaneStack;
  /** The visible time window, sized to the plot. */
  readonly camera: Camera1D;
  /** Scroll position of the lanes, px; clamped to the scrollable range. */
  readonly scrollTop: number;
  /** Rows to plan beyond the visible ones, above and below. Default 0. */
  readonly overscan?: number;
  /** The spans that passed the filter, or `null` for no filter. */
  readonly matched: SpanMask | null;
  /** The selection, or `null` for none. */
  readonly selection: SelectionMasks | null;
  /** One byte per row for the hovered spans, or `null`. */
  readonly hovered: Uint8Array | null;
  /** The step functions the summaries draw. */
  readonly summaries: SummarySource;
  /** The text cut to fit `maxWidth` px (with an ellipsis), or an empty string when nothing fits: `TextMeter.fit` with the label font. */
  readonly fitText: (text: string, maxWidth: number) => string;
  /** First merge gap to try, px; default {@link MERGE_GAP_PX}. The budget may double it. */
  readonly mergeGap?: number;
}

/**
 * The numbers for one frame.
 *
 * Runs are in drawing order: by planned row (top to bottom), left to right inside a row. Rows are
 * the level rows that are in view; summaries and headers are listed separately.
 */
export class LanesFramePlan {
  // What the plan was made from: the hit test and painter read these so they agree with the frame.
  model: LaneModel | null = null;
  layout: LanesLayout | null = null;
  stack: LaneStack | null = null;
  /** Start of the window, ms. */
  t0 = 0;
  /** End of the window, ms. */
  t1 = 0;
  /** Width of the plot, px. */
  plotWidth = 0;
  /** The scroll position the plan was made for, after clamping. */
  scrollTop = 0;
  /** Merge gap the frame ended up with, px (above {@link MERGE_GAP_PX} when the budget was hit). */
  mergeGap = MERGE_GAP_PX;
  /** Total height of the lanes, px. */
  contentHeight = 0;

  // Runs.
  /** Number of runs. */
  runCount = 0;
  /** Left edge of the run, plot px, clipped to just outside the plot. */
  runX0 = new Float32Array(MAX_BARS);
  /** Right edge of the run, plot px, clipped to just outside the plot. */
  runX1 = new Float32Array(MAX_BARS);
  /** Top of the run's row, view px (the bar is `layout.barInset` below it). */
  runY = new Float32Array(MAX_BARS);
  /** Track of the run (`LaneModel.laneTrackOff[lane] + level`). */
  runTrack = new Int32Array(MAX_BARS);
  /** First item of the run (an index into `LaneModel.itemRow` and friends); the run covers `runItems` consecutive items. */
  runFirst = new Int32Array(MAX_BARS);
  /** Number of items in the run: 1 for a plain bar. */
  runItems = new Int32Array(MAX_BARS);
  /** Dominant span kind of the run, by pixel width. */
  runKind = new Uint8Array(MAX_BARS);
  /** OR of {@link RunFlag} bits. */
  runFlags = new Uint16Array(MAX_BARS);

  // Planned rows: the level rows in view.
  /** Number of planned level rows. */
  rowCount = 0;
  /** Rows the row arrays have room for. */
  rowCapacity = 0;
  /** Lane id of each planned row. */
  rowLane = new Int32Array(0);
  /** Level of each planned row inside its lane. */
  rowLevel = new Int32Array(0);
  /** Top of each planned row, view px; ascending. */
  rowY = new Float32Array(0);
  /** The runs of planned row `j` are `rowRunOff[j] … rowRunOff[j + 1] - 1`, sorted by `runX0`; `rowCount + 1` entries. */
  rowRunOff = new Int32Array(1);

  // Labels.
  /** Number of labels. */
  labelCount = 0;
  /** Run each label is on. */
  labelRun = new Int32Array(MAX_BARS);
  /** Left edge of the text, plot px. */
  labelX = new Float32Array(MAX_BARS);
  /** Room for the text, px. */
  labelWidth = new Float32Array(MAX_BARS);
  /** The (cut) text of each label. */
  labelText: string[] = new Array<string>(MAX_BARS).fill('');

  // Lane headers.
  /** Number of headers: the lanes that intersect the viewport, in order. */
  headerCount = 0;
  /** Lane id of each header. */
  headerLane = new Int32Array(0);
  /** Top of the lane, view px (may be above the body for a lane scrolled partly out). */
  headerY = new Float32Array(0);
  /** Height of the lane, px. */
  headerHeight = new Float32Array(0);
  /** {@link LaneMode} of the lane. */
  headerMode = new Uint8Array(0);
  /** Name of the lane. */
  headerName: string[] = [];
  /** The stats readout of the lane (see {@link laneStatsText}). */
  headerStats: string[] = [];

  // Summaries.
  /** Number of summary slots. */
  summaryCount = 0;
  /** Lane id of each summary. */
  summaryLane = new Int32Array(0);
  /** {@link SummaryKind} of each summary. */
  summaryKind = new Uint8Array(0);
  /** Top of the row, view px. */
  summaryY = new Float32Array(0);
  /** Height of the row, px. */
  summaryH = new Float32Array(0);
  /** For an overflow row, how many levels it hides; 0 for a collapsed lane. */
  summaryHidden = new Int32Array(0);
  /** Path data of the area (in the row's own coordinates, `0 … plotWidth` by `0 … height`); empty when nothing is in flight. */
  summaryPath: string[] = [];
  /** Path data of the error ticks; empty when there are none. */
  summaryErrors: string[] = [];

  // Ruler.
  /** Number of ruler ticks. */
  tickCount = 0;
  /** Plot px of each tick. */
  tickX = new Float32Array(16);
  /** Label of each tick. */
  tickLabel: string[] = new Array<string>(16).fill('');

  /** Per-column scratch for the summaries. */
  columns = new Int32Array(0);

  /** Make sure the row arrays can hold `rows` planned rows. Existing contents are not kept. */
  reserveRows(rows: number): void {
    if (rows <= this.rowCapacity) return;
    let capacity = Math.max(this.rowCapacity, DEFAULT_PLAN_ROWS);
    while (capacity < rows) capacity *= 2;
    this.rowCapacity = capacity;
    this.rowLane = new Int32Array(capacity);
    this.rowLevel = new Int32Array(capacity);
    this.rowY = new Float32Array(capacity);
    this.rowRunOff = new Int32Array(capacity + 1);
  }

  /** Make sure the header and summary arrays can hold `lanes` lanes. Existing contents are not kept. */
  reserveLanes(lanes: number): void {
    if (lanes <= this.headerLane.length) return;
    let capacity = Math.max(this.headerLane.length, 16);
    while (capacity < lanes) capacity *= 2;
    this.headerLane = new Int32Array(capacity);
    this.headerY = new Float32Array(capacity);
    this.headerHeight = new Float32Array(capacity);
    this.headerMode = new Uint8Array(capacity);
    this.headerName = new Array<string>(capacity).fill('');
    this.headerStats = new Array<string>(capacity).fill('');
    this.summaryLane = new Int32Array(capacity);
    this.summaryKind = new Uint8Array(capacity);
    this.summaryY = new Float32Array(capacity);
    this.summaryH = new Float32Array(capacity);
    this.summaryHidden = new Int32Array(capacity);
    this.summaryPath = new Array<string>(capacity).fill('');
    this.summaryErrors = new Array<string>(capacity).fill('');
  }

  /** Make sure the tick arrays can hold `ticks` ticks. Existing contents are not kept. */
  reserveTicks(ticks: number): void {
    if (ticks <= this.tickX.length) return;
    this.tickX = new Float32Array(ticks);
    this.tickLabel = new Array<string>(ticks).fill('');
  }
}

const extent = createBarExtent();
/** Item flag bits while a run is built. */
const AGG_ERROR = 1;
const AGG_MATCHED = 2;
const AGG_RELATED = 4;
const AGG_SELECTED = 8;
const AGG_HOVERED = 16;
/** Kinds above this are counted as 0 when finding the dominant kind of a run. */
const KIND_SLOTS = 8;
const kindWidth = new Float64Array(KIND_SLOTS);

/** Write run `n`. */
function writeRun(
  plan: LanesFramePlan,
  n: number,
  input: PlanInput,
  y: number,
  track: number,
  first: number,
  items: number,
  x0: number,
  x1: number,
  agg: number,
  clipped: number,
  kind: number,
): void {
  let flags = clipped;
  if (items > 1) flags |= RunFlag.Merged;
  if (agg & AGG_ERROR) flags |= RunFlag.Error;
  if (input.matched !== null && !(agg & AGG_MATCHED)) flags |= RunFlag.Dimmed;
  if (input.selection !== null) flags |= agg & AGG_RELATED ? RunFlag.Related : RunFlag.Faded;
  if (agg & AGG_SELECTED) flags |= RunFlag.Selected;
  if (agg & AGG_HOVERED) flags |= RunFlag.Hovered;
  if (input.model.itemGhost[first] === 1) flags |= RunFlag.Ghost;

  if (items > 1) {
    let best = 0;
    for (let k = 1; k < KIND_SLOTS; k++) if (kindWidth[k] > kindWidth[best]) best = k;
    kind = best;
  }
  plan.runX0[n] = x0;
  plan.runX1[n] = x1;
  plan.runY[n] = y;
  plan.runTrack[n] = track;
  plan.runFirst[n] = first;
  plan.runItems[n] = items;
  plan.runKind[n] = kind;
  plan.runFlags[n] = flags;
}

/**
 * Plan the runs of every planned row with one merge gap.
 *
 * @param hard - Drop runs beyond the budget instead of giving up (the last resort when even a gap wider than the plot does not fit).
 * @returns Whether everything fit in {@link MAX_BARS} runs.
 */
function planRuns(plan: LanesFramePlan, input: PlanInput, gap: number, hard: boolean): boolean {
  const { model, camera } = input;
  const { itemStart, itemEnd, itemRow, trackItemOff, laneTrackOff } = model;
  const { kind: kinds, status } = model.index.table;
  const matched = input.matched === null ? null : input.matched.bits;
  const related = input.selection === null ? null : input.selection.related;
  const selected = input.selection === null ? null : input.selection.selected;
  const hovered = input.hovered;
  const { t0, t1 } = camera;

  let n = 0;
  for (let j = 0; j < plan.rowCount; j++) {
    plan.rowRunOff[j] = n;
    const track = laneTrackOff[plan.rowLane[j]] + plan.rowLevel[j];
    const to = trackItemOff[track + 1];
    const y = plan.rowY[j];

    let open = false;
    let first = 0;
    let items = 0;
    let x0 = 0;
    let x1 = 0;
    let agg = 0;
    let clipped = 0;
    let firstKind = 0;
    for (let i = lowerBound(itemEnd, trackItemOff[track], to, t0); i < to; i++) {
      if (itemStart[i] > t1) break;
      barExtent(camera, itemStart[i], itemEnd[i], extent);

      if (open && extent.x0 - x1 >= gap) {
        if (n >= MAX_BARS && !hard) return false;
        if (n < MAX_BARS) writeRun(plan, n++, input, y, track, first, items, x0, x1, agg, clipped, firstKind);
        open = false;
      }

      const row = itemRow[i];
      const k = kinds[row] < KIND_SLOTS ? kinds[row] : 0;
      if (!open) {
        open = true;
        first = i;
        items = 0;
        x0 = extent.x0;
        x1 = extent.x1;
        agg = 0;
        clipped = extent.clippedLeft ? RunFlag.ClippedLeft : 0;
        firstKind = k;
        kindWidth.fill(0);
      } else if (extent.x1 > x1) {
        x1 = extent.x1;
      }
      if (extent.clippedRight) clipped |= RunFlag.ClippedRight;
      items++;
      kindWidth[k] += extent.x1 - extent.x0;
      if (status[row] === 2) agg |= AGG_ERROR;
      if (matched !== null && matched[row] === 1) agg |= AGG_MATCHED;
      if (related !== null && related[row] === 1) agg |= AGG_RELATED;
      if (selected !== null && selected[row] === 1) agg |= AGG_SELECTED;
      if (hovered !== null && hovered[row] === 1) agg |= AGG_HOVERED;
    }
    if (open) {
      if (n >= MAX_BARS && !hard) return false;
      if (n < MAX_BARS) writeRun(plan, n++, input, y, track, first, items, x0, x1, agg, clipped, firstKind);
    }
  }
  plan.rowRunOff[plan.rowCount] = n;
  plan.runCount = n;
  return true;
}

/** Choose the labels: single bars wide enough, with their text cut to fit. */
function planLabels(plan: LanesFramePlan, input: PlanInput): void {
  const { model } = input;
  const table = model.index.table;
  const width = plan.plotWidth;
  let n = 0;
  for (let r = 0; r < plan.runCount; r++) {
    if (plan.runItems[r] !== 1) continue;
    const left = Math.max(plan.runX0[r], 0);
    const right = Math.min(plan.runX1[r], width);
    const room = right - left - 2 * LABEL_PADDING;
    if (right - left < LABEL_MIN_WIDTH) continue;
    const row = model.itemRow[plan.runFirst[r]];
    const text = input.fitText(table.names[table.nameId[row]], room);
    if (text === '') continue;
    plan.labelRun[n] = r;
    plan.labelX[n] = left + LABEL_PADDING;
    plan.labelWidth[n] = room;
    plan.labelText[n] = text;
    n++;
  }
  plan.labelCount = n;
}

/**
 * Fill `plan` for the lanes in view.
 *
 * @param plan - The plan to rewrite; arrays that are too small are replaced.
 * @param input - The state to plan from.
 */
export function buildLanesPlan(plan: LanesFramePlan, input: PlanInput): void {
  const { model, layout, stack, camera } = input;
  const scrollTop = clampScroll(layout, stack, input.scrollTop);
  plan.model = model;
  plan.layout = layout;
  plan.stack = stack;
  plan.t0 = camera.t0;
  plan.t1 = camera.t1;
  plan.plotWidth = camera.widthPx;
  plan.scrollTop = scrollTop;
  plan.contentHeight = stack.contentHeight;
  plan.mergeGap = input.mergeGap ?? MERGE_GAP_PX;
  plan.runCount = 0;
  plan.rowCount = 0;
  plan.labelCount = 0;
  plan.headerCount = 0;
  plan.summaryCount = 0;
  plan.tickCount = 0;

  // The ruler is there even when no lane is.
  const ticks = niceTicks(camera.t0, camera.t1, camera.widthPx);
  plan.reserveTicks(ticks.ticks.length);
  const scale = pxPerMs(camera);
  for (let k = 0; k < ticks.ticks.length; k++) {
    plan.tickX[k] = (ticks.ticks[k].value - camera.t0) * scale;
    plan.tickLabel[k] = ticks.ticks[k].label;
  }
  plan.tickCount = ticks.ticks.length;

  const overscanPx = Math.max(0, input.overscan ?? 0) * layout.rowHeight;
  const from = scrollTop - overscanPx;
  const to = scrollTop + layout.bodyHeight + overscanPx;
  const lanes = lanesIn(stack, from, to);
  if (lanes.last < lanes.first) {
    plan.rowRunOff[0] = 0;
    return;
  }

  const laneCount = lanes.last - lanes.first + 1;
  plan.reserveLanes(laneCount);
  plan.reserveRows(laneCount + Math.ceil((to - from) / layout.rowHeight) + 2);

  // Headers, summary slots and the level rows in view.
  const matched = input.matched;
  const maxRows = layout.maxRows;
  let rows = 0;
  let summaries = 0;
  for (let k = lanes.first; k <= lanes.last; k++) {
    const lane = stack.lane[k];
    const h = plan.headerCount++;
    plan.headerLane[h] = lane;
    plan.headerY[h] = viewY(layout, stack.top[k], scrollTop);
    plan.headerHeight[h] = laneHeight(stack, k);
    plan.headerMode[h] = stack.mode[k];
    plan.headerName[h] = model.names[lane];
    plan.headerStats[h] = laneStatsText(model, lane);

    if (stack.mode[k] === LaneMode.Collapsed) {
      const s = summaries++;
      plan.summaryLane[s] = lane;
      plan.summaryKind[s] = SummaryKind.Collapsed;
      plan.summaryY[s] = viewY(layout, stack.top[k], scrollTop);
      plan.summaryH[s] = layout.summaryHeight;
      plan.summaryHidden[s] = 0;
      continue;
    }

    const first = Math.max(0, Math.floor((from - stack.top[k]) / layout.rowHeight));
    const last = Math.min(stack.levels[k] - 1, Math.floor((to - stack.top[k]) / layout.rowHeight));
    for (let level = first; level <= last; level++) {
      plan.rowLane[rows] = lane;
      plan.rowLevel[rows] = level;
      plan.rowY[rows] = viewY(layout, levelTop(stack, layout, k, level), scrollTop);
      rows++;
    }
    if (stack.hidden[k] > 0) {
      const top = overflowTop(stack, layout, k);
      if (top < to && top + layout.summaryHeight > from) {
        const s = summaries++;
        plan.summaryLane[s] = lane;
        plan.summaryKind[s] = SummaryKind.Overflow;
        plan.summaryY[s] = viewY(layout, top, scrollTop);
        plan.summaryH[s] = layout.summaryHeight;
        plan.summaryHidden[s] = stack.hidden[k];
      }
    }
  }
  plan.rowCount = rows;
  plan.summaryCount = summaries;

  // Runs, within the budget.
  if (camera.widthPx > 0) {
    let gap = plan.mergeGap;
    const widest = camera.widthPx + 4;
    while (!planRuns(plan, input, gap, gap > widest)) gap *= 2;
    plan.mergeGap = gap;
    planLabels(plan, input);
  } else {
    plan.rowRunOff.fill(0, 0, rows + 1);
  }

  // Summary paths.
  const columns = Math.max(1, Math.floor(camera.widthPx));
  if (summaries > 0 && plan.columns.length < columns) plan.columns = new Int32Array(columns);
  const mask = matched === null ? null : matched.bits;
  for (let s = 0; s < summaries; s++) {
    const lane = plan.summaryLane[s];
    const overflow = plan.summaryKind[s] === SummaryKind.Overflow;
    const steps = overflow ? input.summaries.overflow(lane, maxRows, matched) : input.summaries.steps(lane, matched);
    plan.summaryPath[s] = camera.widthPx > 0 ? areaPath(steps, camera, plan.summaryH[s], steps.peak, plan.columns) : '';
    plan.summaryErrors[s] = camera.widthPx > 0 ? errorPath(model, lane, camera, mask, overflow ? maxRows : 0) : '';
  }
}
