/**
 * Hit testing: what is under a point of the lanes view.
 *
 * The test runs against the last {@link LanesFramePlan}, never against the model directly, so what
 * is picked is always what was drawn: a merged run is hit as a run, a bar thinner than the merge
 * gap as part of the run it joined. Finding the row is a binary search on the planned rows, finding
 * the run in it another on the run edges, and an idle stretch comes from the lane's busy list, so a
 * test costs the same at 50,000 spans as at 50. Reuse one {@link HitResult} for every pointer move
 * to avoid garbage.
 *
 * Headless: no DOM, no browser globals.
 */

import { pxPerMs } from '../../../kit/geometry/camera1d.ts';
import type { SpanMask } from '../../../core/span-set.ts';
import { idleGapAt, type IdleGap } from './summary.ts';
import {
  LaneRowKind,
  contentY as toContentY,
  createLaneRow,
  laneAt,
  overflowTop,
  rowInLane,
  viewY,
} from './layout.ts';
import type { LanesFramePlan } from './plan.ts';

/** What a point is over. */
export enum HitPart {
  /** Nothing: outside the view, below the last lane, or empty room inside a busy stretch. */
  None = 0,
  /** The time ruler. */
  Ruler = 1,
  /** A lane's header in the gutter; a click toggles the lane. */
  Header = 2,
  /** A bar of one span (or up to {@link RUN_TOLERANCE} px beside it). */
  Bar = 3,
  /** A merged run of several spans. */
  Run = 4,
  /** The summary row of a collapsed lane. */
  Summary = 5,
  /** The overflow row of a capped lane; its "+N rows" button is `button`. */
  Overflow = 6,
  /** Empty room in a lane between two busy stretches. */
  IdleGap = 7,
}

/** How far beside a run still counts as the run, px; keeps thin bars clickable. */
export const RUN_TOLERANCE = 3;
/** Width of the "+N rows" button at the left of an overflow row, px. */
export const OVERFLOW_BUTTON_WIDTH = 96;

/** The answer of {@link hitTest}; reuse one object. */
export interface HitResult {
  part: HitPart;
  /** Lane id, or -1 for none. */
  lane: number;
  /** Level of a bar, a run or an idle gap row, else -1. */
  level: number;
  /** Index of the run in the plan for a {@link HitPart.Bar} or {@link HitPart.Run}, else -1. */
  run: number;
  /** First item of the bar or run (an index into `LaneModel.itemRow`), else -1. */
  item: number;
  /** Items in the run (1 for a bar), else 0. */
  count: number;
  /** Table row of a bar's span, or of the first span of a run; -1 for the other parts. */
  row: number;
  /** Whether the bar or run is a ghost (the call seen from the caller). */
  ghost: boolean;
  /** Time under the pointer, ms; for the plot parts only (0 otherwise). */
  t: number;
  /** For an {@link HitPart.IdleGap}: when the previous busy stretch ended, ms. */
  gapFrom: number;
  /** For an {@link HitPart.IdleGap}: when the next busy stretch starts, ms. */
  gapTo: number;
  /** For an {@link HitPart.Overflow}: whether the pointer is over the button rather than the chart. */
  button: boolean;
  /** Box to attach a tooltip to, in view coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An empty result to pass to {@link hitTest}. */
export function createHitResult(): HitResult {
  return {
    part: HitPart.None, lane: -1, level: -1, run: -1, item: -1, count: 0, row: -1, ghost: false,
    t: 0, gapFrom: 0, gapTo: 0, button: false, x: 0, y: 0, w: 0, h: 0,
  };
}

function setBox(out: HitResult, x: number, y: number, w: number, h: number): void {
  out.x = x;
  out.y = y;
  out.w = w;
  out.h = h;
}

const scratchRow = createLaneRow();
const scratchGap: IdleGap = { from: 0, to: 0 };

/**
 * The index of the planned row whose band contains view y, or -1; `rowY` is ascending, so a binary
 * search finds the last row that starts at or above `y`.
 */
function plannedRowAt(plan: LanesFramePlan, rowHeight: number, y: number): number {
  let lo = 0;
  let hi = plan.rowCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (plan.rowY[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo <= hi && plan.rowY[lo] <= y && y < plan.rowY[lo] + rowHeight ? lo : -1;
}

/**
 * The run of a planned row nearest to plot x, within {@link RUN_TOLERANCE} px; its index in the
 * plan, or -1. A run the point is inside beats one the point is only near.
 */
function runAt(plan: LanesFramePlan, row: number, px: number): number {
  const from = plan.rowRunOff[row];
  const to = plan.rowRunOff[row + 1];
  // last run that starts at or before px + tolerance
  let lo = from;
  let hi = to - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (plan.runX0[mid] <= px + RUN_TOLERANCE) lo = mid;
    else hi = mid - 1;
  }
  let best = -1;
  let bestDistance = RUN_TOLERANCE + 1;
  for (let r = Math.max(from, lo - 1); r <= lo && r < to; r++) {
    const distance = px < plan.runX0[r] ? plan.runX0[r] - px : px > plan.runX1[r] ? px - plan.runX1[r] : 0;
    if (distance <= RUN_TOLERANCE && distance < bestDistance) {
      best = r;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Find what is at a point of the view, as drawn by `plan`.
 *
 * @param plan - The last plan; a plan that was never built hits nothing.
 * @param x - Horizontal position in the view, px.
 * @param y - Vertical position in the view, px.
 * @param out - Receives the result; every field is overwritten.
 * @returns `out`.
 */
export function hitTest(plan: LanesFramePlan, x: number, y: number, out: HitResult): HitResult {
  out.part = HitPart.None;
  out.lane = -1;
  out.level = -1;
  out.run = -1;
  out.item = -1;
  out.count = 0;
  out.row = -1;
  out.ghost = false;
  out.t = 0;
  out.gapFrom = 0;
  out.gapTo = 0;
  out.button = false;
  setBox(out, 0, 0, 0, 0);

  const { model, layout, stack } = plan;
  if (model === null || layout === null || stack === null) return out;
  if (!(x >= 0 && x < layout.width) || !(y >= 0 && y < layout.height)) return out;

  if (y < layout.headerHeight) {
    out.part = HitPart.Ruler;
    setBox(out, layout.plotLeft, 0, layout.plotWidth, layout.headerHeight);
    if (x >= layout.plotLeft) out.t = plan.t0 + (Math.min(x - layout.plotLeft, plan.plotWidth) * (plan.t1 - plan.t0)) / Math.max(plan.plotWidth, 1);
    return out;
  }

  const content = toContentY(layout, y, plan.scrollTop);
  const k = laneAt(stack, content);
  if (k < 0) return out;
  const lane = stack.lane[k];
  const laneTop = stack.top[k];
  out.lane = lane;

  if (x < layout.plotLeft) {
    out.part = HitPart.Header;
    setBox(out, 0, viewY(layout, laneTop, plan.scrollTop), layout.plotLeft, stack.top[k + 1] - laneTop);
    return out;
  }

  const px = x - layout.plotLeft;
  const scale = pxPerMs({ t0: plan.t0, t1: plan.t1, total: 0, widthPx: plan.plotWidth });
  out.t = scale > 0 ? plan.t0 + px / scale : plan.t0;

  const row = rowInLane(stack, layout, k, content - laneTop, scratchRow);
  if (row.kind === LaneRowKind.Summary) {
    out.part = HitPart.Summary;
    setBox(out, layout.plotLeft, viewY(layout, laneTop, plan.scrollTop), layout.plotWidth, layout.summaryHeight);
    return out;
  }
  if (row.kind === LaneRowKind.Overflow) {
    out.part = HitPart.Overflow;
    out.button = px < OVERFLOW_BUTTON_WIDTH;
    setBox(out, layout.plotLeft, viewY(layout, overflowTop(stack, layout, k), plan.scrollTop), layout.plotWidth, layout.summaryHeight);
    return out;
  }

  // A level row: a run, else an idle stretch of the lane.
  const rowTop = viewY(layout, laneTop + row.level * layout.rowHeight, plan.scrollTop);
  out.level = row.level;
  const planned = plannedRowAt(plan, layout.rowHeight, rowTop + layout.rowHeight / 2);
  if (planned >= 0) {
    const run = runAt(plan, planned, px);
    if (run >= 0) {
      const items = plan.runItems[run];
      out.part = items === 1 ? HitPart.Bar : HitPart.Run;
      out.run = run;
      out.item = plan.runFirst[run];
      out.count = items;
      out.row = model.itemRow[out.item];
      out.ghost = model.itemGhost[out.item] === 1;
      setBox(out, layout.plotLeft + plan.runX0[run], rowTop + layout.barInset, plan.runX1[run] - plan.runX0[run], layout.barHeight);
      return out;
    }
  }
  if (idleGapAt(model.busy[lane], out.t, scratchGap)) {
    out.part = HitPart.IdleGap;
    out.gapFrom = scratchGap.from;
    out.gapTo = scratchGap.to;
    const x0 = Math.max(0, (scratchGap.from - plan.t0) * scale);
    const x1 = Math.min(plan.plotWidth, (scratchGap.to - plan.t0) * scale);
    setBox(out, layout.plotLeft + x0, rowTop, Math.max(0, x1 - x0), layout.rowHeight);
  }
  return out;
}

/**
 * The table rows of the items of a run: the spans a click on it selects, with the longest one first
 * in `primary`.
 *
 * @param plan - The plan the run is in.
 * @param run - Index of the run.
 * @returns The rows in time order, and the longest of them.
 */
export function rowsOfRun(plan: LanesFramePlan, run: number): { readonly rows: number[]; readonly primary: number } {
  const model = plan.model;
  if (model === null) return { rows: [], primary: -1 };
  const { start, end } = model.index.table;
  const rows: number[] = [];
  let primary = -1;
  let longest = -1;
  const first = plan.runFirst[run];
  for (let i = first; i < first + plan.runItems[run]; i++) {
    const row = model.itemRow[i];
    rows.push(row);
    const length = end[row] - start[row];
    if (length > longest) {
      longest = length;
      primary = row;
    }
  }
  return { rows, primary };
}

/**
 * The spans a lane has in flight at time `t`: its local roots (the requests), or for a peer lane
 * its calls, that contain `t` give or take `tolerance` ms. With a filter only matched spans count.
 *
 * @param tolerance - How far from `t` a span may end or start and still count, ms; a pixel's worth for a click.
 * @returns The rows in table order, and the longest of them (-1 for none).
 */
export function rowsInFlight(
  plan: LanesFramePlan,
  lane: number,
  t: number,
  matched: SpanMask | null,
  tolerance = 0,
): { readonly rows: number[]; readonly primary: number } {
  const model = plan.model;
  if (model === null) return { rows: [], primary: -1 };
  const { start, end } = model.index.table;
  const rows: number[] = [];
  let primary = -1;
  let longest = -1;
  for (let k = model.countedOff[lane]; k < model.countedOff[lane + 1]; k++) {
    const row = model.countedRow[k];
    if (matched !== null && matched.bits[row] !== 1) continue;
    if (start[row] > t + tolerance || Math.max(end[row], start[row]) < t - tolerance) continue;
    rows.push(row);
    const length = end[row] - start[row];
    if (length > longest) {
      longest = length;
      primary = row;
    }
  }
  return { rows, primary };
}
