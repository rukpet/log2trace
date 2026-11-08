/**
 * SequencePlan: preallocated typed arrays describing one visible frame of the sequence diagram.
 *
 * Headless: no DOM, no browser globals.
 */

import { formatDuration, formatOffset, type SpanSet } from '../../../core.ts';
import { visibleRange } from '../../../kit/geometry/virtual-list.ts';
import {
  ACT_W,
  CANVAS_PAD_X,
  CANVAS_PAD_Y,
  MAX_NEST,
  SELF_LOOP_W,
  activationBoxX,
  lifelineCenterX,
  stepRowY,
  type SequenceLayout,
} from './layout.ts';
import { ParticipantKind } from './participants.ts';
import { StepFlag, StepKind, type SequenceSteps } from './steps.ts';

/** Visual state flags on a visible step row, activation, or lifeline column in the frame plan. */
export const enum PlanStateFlag {
  None = 0,
  Hovered = 1,
  Selected = 2,
  Dimmed = 4,
  Error = 8,
}

/** Arrowhead style in the frame plan. */
export const enum ArrowHeadKind {
  None = 0,
  /** Solid filled triangle (`Call`, `Found`, `SelfCall`, `Fold`). */
  Filled = 1,
  /** Open chevron (`Async`, `Return`). */
  Open = 2,
}

/** Everything a painter needs to draw one frame of the sequence diagram. */
export class SequencePlan {
  /** Monotonic stamp incremented when step projection or layout changes. */
  sceneStamp = 0;

  /** Layout geometry used to build this frame. */
  layout: SequenceLayout | null = null;
  /** Projected steps used to build this frame. */
  steps: SequenceSteps | null = null;
  /** Current scroll offsets in CSS px. */
  scrollTop = 0;
  scrollLeft = 0;

  // --- Visible Lifelines (Columns) ---
  /** Number of visible columns (`0 .. layout.columnCount`). */
  columnCount = 0;
  /** Participant id for each column (`0 .. columnCount - 1`). */
  colParticipant = new Int32Array(16);
  /** Center X in content coordinates for each column (`0 .. columnCount - 1`). */
  colCenterX = new Float64Array(16);
  /** `PlanStateFlag` bitmask for each column header (`0 .. columnCount - 1`). */
  colState = new Uint8Array(16);

  // --- Visible Step Rows `[firstStep .. lastStep)` ---
  /** First visible step index (inclusive). */
  firstStep = 0;
  /** One past the last visible step index (exclusive). */
  lastStep = 0;
  /** Number of visible steps (`lastStep - firstStep`). */
  stepCount = 0;
  /** Step index (`firstStep + i`) for each visible slot `i` (`0 .. stepCount - 1`). */
  stepIndex = new Int32Array(64);
  /** Top Y in body content coordinates for each visible slot `i`. */
  stepTopY = new Float64Array(64);
  /** Arrow line Y (vertical center) in body content coordinates for each visible slot `i`. */
  stepCenterY = new Float64Array(64);
  /** Start X of the arrow in content coordinates for each visible slot `i`. */
  arrowX0 = new Float64Array(64);
  /** End X of the arrow in content coordinates for each visible slot `i`. */
  arrowX1 = new Float64Array(64);
  /** `ArrowHeadKind` for each visible slot `i`. */
  arrowHead = new Uint8Array(64);
  /** `1` if the arrow line is dashed (`StepKind.Return`), else `0`. */
  arrowDashed = new Uint8Array(64);
  /** `1` if this step is a self-call loop (`StepKind.SelfCall`), else `0`. */
  arrowSelfLoop = new Uint8Array(64);
  /** `PlanStateFlag` bitmask for each visible slot `i`. */
  stepState = new Uint8Array(64);
  /** Primary label text for each visible slot `i`. */
  stepLabel: string[] = new Array<string>(64).fill('');
  /** Secondary badge text (e.g. `×12`, `+4.2ms`, `✖ ERROR`) for each visible slot `i`. */
  stepBadge: string[] = new Array<string>(64).fill('');
  /** Time gutter text (e.g. `+12.4ms`) for each visible slot `i`. */
  gutterText: string[] = new Array<string>(64).fill('');
  /** Gap break banner text (e.g. `≈ +120ms`) when `StepFlag.Gap` is set, else `""`. */
  gapText: string[] = new Array<string>(64).fill('');

  // --- Visible Activations ---
  /** Number of activations overlapping the visible step range. */
  actCount = 0;
  /** Activation index in `steps.act` for each visible activation `a` (`0 .. actCount - 1`). */
  actIndex = new Int32Array(64);
  /** Left X in content coordinates for each visible activation `a`. */
  actX = new Float64Array(64);
  /** Top Y in body content coordinates for each visible activation `a`. */
  actY = new Float64Array(64);
  /** Width in CSS px for each visible activation `a`. */
  actW = new Float64Array(64);
  /** Height in CSS px for each visible activation `a`. */
  actH = new Float64Array(64);
  /** Span kind (`0 .. 5`) for colouring each visible activation `a`. */
  actSpanKind = new Uint8Array(64);
  /** `PlanStateFlag` bitmask for each visible activation `a`. */
  actState = new Uint8Array(64);
  /** Overflow badge text (`"×" + (nest + 1)` when `nest > MAX_NEST`, or `"⊕ " + hiddenCount` when collapsed). */
  actBadge: string[] = new Array<string>(64).fill('');

  // --- Visible Span Event Ticks ---
  /** Number of span event ticks on visible activations. */
  tickCount = 0;
  /** Activation slot (`0 .. actCount - 1`) that owns each tick `t`. */
  tickActSlot = new Int32Array(64);
  /** `SpanTable` row of the span owning each tick `t`. */
  tickRow = new Int32Array(64);
  /** Event index in `table.evT` / `table.evSrc` for each tick `t`. */
  tickEventIdx = new Int32Array(64);
  /** Center X in content coordinates for each tick `t`. */
  tickX = new Float64Array(64);
  /** Center Y in body content coordinates for each tick `t`. */
  tickY = new Float64Array(64);
  /** `1` if the event name is `'exception'`, else `0`. */
  tickIsException = new Uint8Array(64);
}

export interface BuildSequencePlanParams {
  readonly steps: SequenceSteps;
  readonly layout: SequenceLayout;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly selection: SpanSet;
  readonly hover: SpanSet | null;
  readonly activeColumns?: readonly number[];
  readonly overscanRows?: number;
}

function nextCapacity(current: number, needed: number, minCap: number): number {
  let cap = Math.max(current, minCap);
  while (cap < needed) {
    cap *= 2;
  }
  return cap;
}

function ensureColumnCapacity(plan: SequencePlan, needed: number): void {
  if (needed <= plan.colParticipant.length) return;
  const cap = nextCapacity(plan.colParticipant.length, needed, 16);
  plan.colParticipant = new Int32Array(cap);
  plan.colCenterX = new Float64Array(cap);
  plan.colState = new Uint8Array(cap);
}

function ensureStepCapacity(plan: SequencePlan, needed: number): void {
  if (needed <= plan.stepIndex.length) return;
  const cap = nextCapacity(plan.stepIndex.length, needed, 64);
  plan.stepIndex = new Int32Array(cap);
  plan.stepTopY = new Float64Array(cap);
  plan.stepCenterY = new Float64Array(cap);
  plan.arrowX0 = new Float64Array(cap);
  plan.arrowX1 = new Float64Array(cap);
  plan.arrowHead = new Uint8Array(cap);
  plan.arrowDashed = new Uint8Array(cap);
  plan.arrowSelfLoop = new Uint8Array(cap);
  plan.stepState = new Uint8Array(cap);
  plan.stepLabel = new Array<string>(cap).fill('');
  plan.stepBadge = new Array<string>(cap).fill('');
  plan.gutterText = new Array<string>(cap).fill('');
  plan.gapText = new Array<string>(cap).fill('');
}

function ensureActCapacity(plan: SequencePlan, needed: number): void {
  if (needed <= plan.actIndex.length) return;
  const cap = nextCapacity(plan.actIndex.length, needed, 64);
  plan.actIndex = new Int32Array(cap);
  plan.actX = new Float64Array(cap);
  plan.actY = new Float64Array(cap);
  plan.actW = new Float64Array(cap);
  plan.actH = new Float64Array(cap);
  plan.actSpanKind = new Uint8Array(cap);
  plan.actState = new Uint8Array(cap);
  plan.actBadge = new Array<string>(cap).fill('');
}

function ensureTickCapacity(plan: SequencePlan, needed: number): void {
  if (needed <= plan.tickActSlot.length) return;
  const cap = nextCapacity(plan.tickActSlot.length, needed, 64);
  plan.tickActSlot = new Int32Array(cap);
  plan.tickRow = new Int32Array(cap);
  plan.tickEventIdx = new Int32Array(cap);
  plan.tickX = new Float64Array(cap);
  plan.tickY = new Float64Array(cap);
  plan.tickIsException = new Uint8Array(cap);
}

export function buildSequencePlan(plan: SequencePlan, params: BuildSequencePlanParams): SequencePlan {
  const { steps, layout, scrollTop, scrollLeft, selection, hover } = params;
  const { model } = steps;
  const { index, participants } = model;
  const { table } = index;

  // 1. Store frame parameters.
  plan.layout = layout;
  plan.steps = steps;
  plan.scrollTop = scrollTop;
  plan.scrollLeft = scrollLeft;

  // 2. Lifeline Columns (0 .. columnCount - 1).
  const activeColumns: ArrayLike<number> = params.activeColumns ?? participants.atColumn;
  const columnCount = activeColumns.length;
  plan.columnCount = columnCount;
  ensureColumnCapacity(plan, columnCount);

  const colOfParticipant = new Int32Array(participants.count).fill(-1);
  for (let c = 0; c < columnCount; c++) {
    const pId = activeColumns[c];
    if (pId >= 0 && pId < participants.count) {
      colOfParticipant[pId] = c;
    }
  }

  // Precompute participant state flags across spans and projected steps.
  const partState = new Uint8Array(participants.count);
  const partHasSpan = new Uint8Array(participants.count);
  const partHasMatch = new Uint8Array(participants.count);

  let filterActive = false;
  for (let s = 0; s < steps.count; s++) {
    const f = steps.flags[s];
    const isContext = (f & StepFlag.Context) !== 0;
    if (isContext) {
      filterActive = true;
    } else {
      const fromP = steps.from[s];
      const toP = steps.to[s];
      if (fromP >= 0 && fromP < participants.count) partHasMatch[fromP] = 1;
      if (toP >= 0 && toP < participants.count) partHasMatch[toP] = 1;
    }
  }

  for (let r = 0; r < table.length; r++) {
    const id = table.ids[r];
    const isSel = selection.has(id);
    const isHov = hover !== null && hover.has(id);
    const isErr = table.status[r] === 2;
    const stepIdx = steps.stepOfRow[r];
    const rowMatched = stepIdx >= 0 && (steps.flags[stepIdx] & StepFlag.Context) === 0;

    const ownP = participants.ofRow[r];
    if (ownP >= 0 && ownP < participants.count) {
      partHasSpan[ownP] = 1;
      if (isSel) partState[ownP] |= PlanStateFlag.Selected;
      if (isHov) partState[ownP] |= PlanStateFlag.Hovered;
      if (isErr) partState[ownP] |= PlanStateFlag.Error;
      if (rowMatched) partHasMatch[ownP] = 1;
    }

    const peerP = participants.peerOfRow[r];
    if (peerP >= 0 && peerP < participants.count) {
      partHasSpan[peerP] = 1;
      if (isSel) partState[peerP] |= PlanStateFlag.Selected;
      if (isHov) partState[peerP] |= PlanStateFlag.Hovered;
      if (isErr) partState[peerP] |= PlanStateFlag.Error;
      if (rowMatched) partHasMatch[peerP] = 1;
    }

    const fromP = model.from[r];
    if (
      fromP >= 0 &&
      fromP < participants.count &&
      participants.kind[fromP] === ParticipantKind.Gate
    ) {
      partHasSpan[fromP] = 1;
      if (isSel) partState[fromP] |= PlanStateFlag.Selected;
      if (isHov) partState[fromP] |= PlanStateFlag.Hovered;
      if (isErr) partState[fromP] |= PlanStateFlag.Error;
      if (rowMatched) partHasMatch[fromP] = 1;
    }
  }

  for (let c = 0; c < columnCount; c++) {
    const pId = activeColumns[c];
    plan.colParticipant[c] = pId;
    plan.colCenterX[c] = lifelineCenterX(layout, c);
    let state = pId >= 0 && pId < participants.count ? partState[pId] : PlanStateFlag.None;
    if (
      filterActive &&
      pId >= 0 &&
      pId < participants.count &&
      partHasSpan[pId] === 1 &&
      partHasMatch[pId] === 0
    ) {
      state |= PlanStateFlag.Dimmed;
    }
    plan.colState[c] = state;
  }

  // 3. Visible Step Range.
  const overscanRows = params.overscanRows ?? 4;
  let start = 0;
  let end = 0;
  if (steps.count > 0 && layout.rowHeight > 0) {
    if (layout.bodyViewportHeight > 0) {
      const range = visibleRange(
        {
          rowCount: steps.count,
          rowHeight: layout.rowHeight,
          viewportHeight: layout.bodyViewportHeight,
        },
        Math.max(0, scrollTop - CANVAS_PAD_Y),
        overscanRows,
      );
      if (range.last >= range.first) {
        start = Math.max(0, Math.min(steps.count, range.first));
        end = Math.max(start, Math.min(steps.count, range.last + 1));
      }
    } else {
      const relTop = Math.max(0, scrollTop - CANVAS_PAD_Y);
      const extra = overscanRows > 0 ? Math.floor(overscanRows) : 0;
      start = Math.max(0, Math.min(steps.count, Math.floor(relTop / layout.rowHeight) - extra));
      end = Math.max(start, Math.min(steps.count, Math.floor(relTop / layout.rowHeight) + extra));
    }
  }

  const stepCount = Math.max(0, end - start);
  plan.firstStep = start;
  plan.lastStep = end;
  plan.stepCount = stepCount;
  ensureStepCapacity(plan, stepCount);

  // 4. Populate Visible Steps (i = 0 .. stepCount - 1, s = firstStep + i).
  for (let i = 0; i < stepCount; i++) {
    const s = start + i;
    const { top, centerY } = stepRowY(layout, s);
    plan.stepIndex[i] = s;
    plan.stepTopY[i] = top;
    plan.stepCenterY[i] = centerY;

    const kind = steps.kind[s];
    const flags = steps.flags[s];
    const r = steps.row[s];
    const v = steps.via[s];
    const fromP = steps.from[s];
    const toP = steps.to[s];
    const fromCol = fromP >= 0 && fromP < colOfParticipant.length ? colOfParticipant[fromP] : -1;
    const toCol = toP >= 0 && toP < colOfParticipant.length ? colOfParticipant[toP] : -1;

    if (kind === StepKind.Elided) {
      const x0 = layout.gutterWidth + CANVAS_PAD_X;
      const x1 = Math.max(x0, layout.contentWidth - CANVAS_PAD_X);
      plan.arrowX0[i] = x0;
      plan.arrowX1[i] = x1;
      plan.arrowSelfLoop[i] = 0;
      plan.arrowDashed[i] = 1;
      plan.arrowHead[i] = ArrowHeadKind.None;
    } else if (kind === StepKind.SelfCall || (fromCol === toCol && fromCol >= 0)) {
      const baseCenterX =
        fromCol >= 0 ? lifelineCenterX(layout, fromCol) : layout.gutterWidth + CANVAS_PAD_X;
      const x = baseCenterX + ACT_W / 2;
      plan.arrowX0[i] = x;
      plan.arrowX1[i] = x + SELF_LOOP_W;
      plan.arrowSelfLoop[i] = 1;
      plan.arrowDashed[i] = 0;
      plan.arrowHead[i] = ArrowHeadKind.Filled;
    } else {
      const x0 = fromCol >= 0 ? lifelineCenterX(layout, fromCol) : layout.gutterWidth + CANVAS_PAD_X;
      const x1 = toCol >= 0 ? lifelineCenterX(layout, toCol) : x0;
      plan.arrowX0[i] = x0;
      plan.arrowX1[i] = x1;
      plan.arrowSelfLoop[i] = 0;
      plan.arrowDashed[i] = kind === StepKind.Return ? 1 : 0;
      plan.arrowHead[i] =
        kind === StepKind.Async || kind === StepKind.Return
          ? ArrowHeadKind.Open
          : ArrowHeadKind.Filled;
    }

    // Compute stepState[i].
    let sState = PlanStateFlag.None;
    if (kind === StepKind.Fold) {
      const fStart = steps.foldRowOff[s];
      const fEnd = steps.foldRowOff[s + 1];
      for (let f = fStart; f < fEnd; f++) {
        const fr = steps.foldRows[f];
        const fv = model.via[fr];
        if (
          (fr >= 0 && selection.has(table.ids[fr])) ||
          (fv >= 0 && selection.has(table.ids[fv]))
        ) {
          sState |= PlanStateFlag.Selected;
        }
        if (
          hover !== null &&
          ((fr >= 0 && hover.has(table.ids[fr])) || (fv >= 0 && hover.has(table.ids[fv])))
        ) {
          sState |= PlanStateFlag.Hovered;
        }
      }
    } else if (kind !== StepKind.Elided) {
      if ((r >= 0 && selection.has(table.ids[r])) || (v >= 0 && selection.has(table.ids[v]))) {
        sState |= PlanStateFlag.Selected;
      }
      if (
        hover !== null &&
        ((r >= 0 && hover.has(table.ids[r])) || (v >= 0 && hover.has(table.ids[v])))
      ) {
        sState |= PlanStateFlag.Hovered;
      }
    }
    if ((flags & StepFlag.Context) !== 0) {
      sState |= PlanStateFlag.Dimmed;
    }
    if ((flags & StepFlag.Error) !== 0) {
      sState |= PlanStateFlag.Error;
    }
    plan.stepState[i] = sState;

    // stepLabel[i]
    if (kind === StepKind.Return) {
      plan.stepLabel[i] = formatDuration(steps.duration[s]);
    } else if (kind === StepKind.Elided) {
      plan.stepLabel[i] = `⋯ ${steps.foldCount[s]} interactions outside window`;
    } else {
      plan.stepLabel[i] = r >= 0 && r < table.length ? (table.names[table.nameId[r]] ?? '') : '';
    }

    // stepBadge[i]
    const badgeParts: string[] = [];
    if (kind === StepKind.Fold) {
      badgeParts.push(`×${steps.foldCount[s]} (${formatDuration(steps.duration[s])})`);
    }
    if ((flags & StepFlag.Error) !== 0) {
      badgeParts.push('✖');
    }
    if ((flags & StepFlag.Skew) !== 0) {
      badgeParts.push('⚠');
    }
    if ((flags & StepFlag.Orphan) !== 0) {
      badgeParts.push('orphan');
    }
    plan.stepBadge[i] = badgeParts.join(' ');

    // gutterText[i]
    let gutterPrefix = '';
    if ((flags & StepFlag.Parallel) !== 0) {
      gutterPrefix += '‖ ';
    }
    if ((flags & StepFlag.Backwards) !== 0) {
      gutterPrefix += '⤴ ';
    }
    plan.gutterText[i] = gutterPrefix + formatOffset(steps.time[s]);

    // gapText[i]
    plan.gapText[i] =
      (flags & StepFlag.Gap) !== 0 ? `≈ +${formatDuration(steps.gapMs[s])}` : '';
  }

  // 5. Visible Activations (O(depth + visible)).
  const { act } = steps;
  const visibleActIndices: number[] = [];
  if (stepCount > 0 && act.count > 0) {
    // 5a. Walk the open activation chain at `firstStep`.
    const openChain: number[] = [];
    let a = start < act.innermostAtStep.length ? act.innermostAtStep[start] : -1;
    while (a >= 0 && a < act.count) {
      if (act.startStep[a] < end && act.endStep[a] >= start) {
        openChain.push(a);
      }
      a = act.parent[a];
    }
    openChain.reverse();

    // 5b. Binary search for the first activation with `startStep >= start`.
    let lo = 0;
    let hi = act.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (act.startStep[mid] < start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Merge openChain and range `[lo ..]` in ascending activation index order, deduplicating.
    let oi = 0;
    let si = lo;
    while (oi < openChain.length && si < act.count && act.startStep[si] < end) {
      const openIdx = openChain[oi];
      if (openIdx < si) {
        if (
          visibleActIndices.length === 0 ||
          visibleActIndices[visibleActIndices.length - 1] !== openIdx
        ) {
          visibleActIndices.push(openIdx);
        }
        oi++;
      } else if (si < openIdx) {
        if (
          act.endStep[si] >= start &&
          (visibleActIndices.length === 0 ||
            visibleActIndices[visibleActIndices.length - 1] !== si)
        ) {
          visibleActIndices.push(si);
        }
        si++;
      } else {
        if (
          visibleActIndices.length === 0 ||
          visibleActIndices[visibleActIndices.length - 1] !== openIdx
        ) {
          visibleActIndices.push(openIdx);
        }
        oi++;
        si++;
      }
    }
    while (oi < openChain.length) {
      const openIdx = openChain[oi++];
      if (
        visibleActIndices.length === 0 ||
        visibleActIndices[visibleActIndices.length - 1] !== openIdx
      ) {
        visibleActIndices.push(openIdx);
      }
    }
    while (si < act.count && act.startStep[si] < end) {
      if (
        act.endStep[si] >= start &&
        (visibleActIndices.length === 0 ||
          visibleActIndices[visibleActIndices.length - 1] !== si)
      ) {
        visibleActIndices.push(si);
      }
      si++;
    }
  }

  ensureActCapacity(plan, visibleActIndices.length);
  let actSlot = 0;
  for (let k = 0; k < visibleActIndices.length; k++) {
    const a = visibleActIndices[k];
    const partId = act.part[a];
    const col = partId >= 0 && partId < colOfParticipant.length ? colOfParticipant[partId] : -1;
    if (col < 0) continue;

    const nest = act.nest[a];
    const box = activationBoxX(layout, col, nest);
    const s0 = act.startStep[a];
    const s1 = act.endStep[a];
    const y0 = stepRowY(layout, s0).centerY - 6;
    const y1 = stepRowY(layout, s1).centerY + 6;
    const r = act.row[a];
    const v = r >= 0 && r < model.via.length ? model.via[r] : -1;

    plan.actIndex[actSlot] = a;
    plan.actX[actSlot] = box.x;
    plan.actY[actSlot] = y0;
    plan.actW[actSlot] = box.w;
    plan.actH[actSlot] = Math.max(12, y1 - y0);
    plan.actSpanKind[actSlot] = r >= 0 && r < table.length ? table.kind[r] : 0;

    let aState = PlanStateFlag.None;
    if ((r >= 0 && selection.has(table.ids[r])) || (v >= 0 && selection.has(table.ids[v]))) {
      aState |= PlanStateFlag.Selected;
    }
    if (
      hover !== null &&
      ((r >= 0 && hover.has(table.ids[r])) || (v >= 0 && hover.has(table.ids[v])))
    ) {
      aState |= PlanStateFlag.Hovered;
    }
    if (r >= 0 && r < table.length && table.status[r] === 2) {
      aState |= PlanStateFlag.Error;
    }
    if (s0 >= 0 && s0 < steps.count && (steps.flags[s0] & StepFlag.Context) !== 0) {
      aState |= PlanStateFlag.Dimmed;
    }
    plan.actState[actSlot] = aState;

    const hiddenCount = act.hiddenCount[a];
    if (hiddenCount > 0) {
      plan.actBadge[actSlot] = `⊕ ${hiddenCount}`;
    } else if (nest > MAX_NEST) {
      plan.actBadge[actSlot] = `×${nest + 1}`;
    } else {
      plan.actBadge[actSlot] = '';
    }

    actSlot++;
  }
  plan.actCount = actSlot;

  // 6. Visible Span Event Ticks.
  let totalTicks = 0;
  for (let slot = 0; slot < actSlot; slot++) {
    const a = plan.actIndex[slot];
    const r = act.row[a];
    if (r >= 0 && r < table.length) {
      totalTicks += table.evOff[r + 1] - table.evOff[r];
    }
  }
  ensureTickCapacity(plan, totalTicks);

  let tickIdx = 0;
  for (let slot = 0; slot < actSlot; slot++) {
    const a = plan.actIndex[slot];
    const r = act.row[a];
    if (r < 0 || r >= table.length) continue;

    const evStart = table.evOff[r];
    const evEnd = table.evOff[r + 1];
    if (evEnd <= evStart) continue;

    const spanStart = table.start[r];
    const spanEnd = table.end[r];
    const spanDur = spanEnd - spanStart;
    const actTop = plan.actY[slot];
    const actHeight = plan.actH[slot];
    const centerX = plan.actX[slot] + plan.actW[slot] / 2;
    const orderedSpan = index.ordered[r]?.span;

    for (let e = evStart; e < evEnd; e++) {
      const evTime = table.evT[e];
      const frac =
        spanDur > 0 ? Math.min(1, Math.max(0, (evTime - spanStart) / spanDur)) : 0;
      const tickY = actTop + frac * actHeight;
      const srcIdx = table.evSrc[e];
      const isEx = orderedSpan?.events?.[srcIdx]?.name === 'exception' ? 1 : 0;

      plan.tickActSlot[tickIdx] = slot;
      plan.tickRow[tickIdx] = r;
      plan.tickEventIdx[tickIdx] = e;
      plan.tickX[tickIdx] = centerX;
      plan.tickY[tickIdx] = tickY;
      plan.tickIsException[tickIdx] = isEx;
      tickIdx++;
    }
  }
  plan.tickCount = tickIdx;

  return plan;
}
