/**
 * Sequence diagram step & activation projection.
 *
 * Headless: no DOM, no browser globals.
 */

import type { SpanMask, TimeWindow } from '../../../core.ts';
import type { ReturnArrowMode } from '../settings.ts';
import { detectTimeGaps } from './layout.ts';
import { MsgKind, type SequenceModel } from './messages.ts';

/** Kind of logical step row in the projected sequence diagram. */
export const enum StepKind {
  /** Synchronous request arrow (`from -> to`). */
  Call = 1,
  /** Synchronous dashed return arrow (`to -> from`, i.e. returning from callee to caller). */
  Return = 2,
  /** Asynchronous message arrow (`from -> to`, open arrowhead, no return arrow). */
  Async = 3,
  /** Same-participant self-call loop (`from === to`). */
  SelfCall = 4,
  /** Entry call from the synthetic Gate (or root start). */
  Found = 5,
  /** Folded run of `foldCount` consecutive identical sibling calls (`loop ×N`). */
  Fold = 6,
  /** Coalesced run of `foldCount` interactions outside the shared time window. */
  Elided = 7,
}

/** Bit flags on each projected step. */
export const enum StepFlag {
  None = 0,
  /** Callee (or `via` caller) has `status === 2` (error), or a folded step contains at least one error. */
  Error = 1,
  /** Step has clock skew (`start < parent.start` or negative duration). */
  Skew = 2,
  /** Step runs in parallel (overlapping `[start, end]`) with an adjacent sibling message. */
  Parallel = 4,
  /** Step is an orphan root whose `parentSpanId` was missing from the trace. */
  Orphan = 8,
  /** Step did not match the active filter directly (or is shown only as ancestor context). */
  Context = 16,
  /** Step is preceded by a significant idle time gap (`gapMs[s] > 0`). */
  Gap = 32,
  /** Step timestamp moved backwards relative to the preceding step (`time[s] < time[s - 1]`). */
  Backwards = 64,
}

/** Activation boxes on participant lifelines. */
export interface Activations {
  /** Total number of activations. */
  readonly count: number;
  /** Participant id owning each activation (`0 .. count - 1`). */
  readonly part: Int32Array;
  /** Callee `SpanTable` row of each activation (`0 .. count - 1`). */
  readonly row: Int32Array;
  /** Step index where the activation begins (`0 .. steps.count - 1`). */
  readonly startStep: Int32Array;
  /** Step index where the activation ends (`>= startStep`). */
  readonly endStep: Int32Array;
  /** Nesting level (`0`-based) on the same participant lifeline. */
  readonly nest: Uint8Array;
  /** Enclosing parent activation index on the causal call stack, or `-1`. */
  readonly parent: Int32Array;
  /** Number of descendant spans hidden because `row` is collapsed in the store. */
  readonly hiddenCount: Int32Array;
  /** `1` if `row` has children in the projected sequence that can be collapsed/expanded. */
  readonly collapsible: Uint8Array;
  /** `1` if `row` is currently collapsed in the store. */
  readonly collapsed: Uint8Array;
  /** Innermost open activation index at each step (`0 .. steps.count - 1`), or `-1`. */
  readonly innermostAtStep: Int32Array;
}

/** Options controlling step projection. */
export interface StepOptions {
  /** `'hide'` or `'show'` (`'auto'` is resolved before calling or by `projectSteps` using `model.singleParticipant`). */
  readonly internal?: 'auto' | 'hide' | 'show';
  /** Which return arrows to emit. Default `'all'`. */
  readonly returns?: ReturnArrowMode;
  /** Minimum consecutive identical sibling messages to fold (`0` disables folding). Default `3`. */
  readonly foldMin?: number;
  /** Fold keys (`"fold:<firstRow>"`) that the user has expanded locally. */
  readonly expandedFolds?: ReadonlySet<string>;
  /** When true and `matched !== null`, omit subtrees that contain no filter match. Default `false`. */
  readonly matchesOnly?: boolean;
}

/** Projected sequence steps and lifeline activations. */
export interface SequenceSteps {
  readonly model: SequenceModel;
  /** Number of visible step rows. */
  readonly count: number;
  /** `StepKind` of each step (`0 .. count - 1`). */
  readonly kind: Uint8Array;
  /** `StepFlag` bitmask of each step (`0 .. count - 1`). */
  readonly flags: Uint8Array;
  /** Primary `SpanTable` row of each step (`0 .. count - 1`). */
  readonly row: Int32Array;
  /** Caller-side `CLIENT`/`PRODUCER` `SpanTable` row of each step, or `-1`. */
  readonly via: Int32Array;
  /** Source participant id of the step arrow (`to` -> `from` on `StepKind.Return`). */
  readonly from: Int32Array;
  /** Target participant id of the step arrow. */
  readonly to: Int32Array;
  /** Timestamp of the step in ms after trace origin (`start[row]` for calls, `end[row]` for returns). */
  readonly time: Float64Array;
  /** Duration of the call in ms (`end[row] - start[row]`, or summed duration for `Fold`, or window gap for `Elided`). */
  readonly duration: Float64Array;
  /** Call tree depth (`1`-based for `aria-level`). */
  readonly depth: Int32Array;
  /** Paired step index (`Call <-> Return`), or `-1`. */
  readonly pair: Int32Array;
  /** Activation index associated with this step, or `-1`. */
  readonly actIndex: Int32Array;
  /** Count of folded calls for `StepKind.Fold` or elided spans for `StepKind.Elided` (`0` otherwise). */
  readonly foldCount: Int32Array;
  /** Error count inside a `StepKind.Fold` step (`0` or `1` for normal steps). */
  readonly foldErrors: Int32Array;
  /** Max single-call duration (ms) inside a `StepKind.Fold` step. */
  readonly foldMaxDuration: Float64Array;
  /** Compressed array offsets into `foldRows` for `StepKind.Fold` steps: `foldRowOff[s] .. foldRowOff[s + 1]`. */
  readonly foldRowOff: Int32Array;
  /** Primary `SpanTable` rows belonging to each folded step. */
  readonly foldRows: Int32Array;
  /** Preceding idle time gap in ms when `StepFlag.Gap` is set on step `s`, else `0`. */
  readonly gapMs: Float64Array;
  /** Representative visible step index (`0 .. count - 1`) for every `SpanTable` row (`0 .. table.length - 1`), or `-1`. */
  readonly stepOfRow: Int32Array;
  /** Lifeline activations. */
  readonly act: Activations;
}

export function projectSteps(
  model: SequenceModel,
  collapsed: SpanMask | null = null,
  matched: SpanMask | null = null,
  window: TimeWindow | null = null,
  options: StepOptions = {},
): SequenceSteps {
  const { table } = model.index;
  const n = table.length;

  if (collapsed !== null && collapsed.bits.length !== n) {
    throw new Error(`projectSteps: the collapsed mask has ${collapsed.bits.length} rows, the trace has ${n}`);
  }
  if (matched !== null && matched.bits.length !== n) {
    throw new Error(`projectSteps: the match mask has ${matched.bits.length} rows, the trace has ${n}`);
  }

  if (n === 0) {
    return {
      model,
      count: 0,
      kind: new Uint8Array(0),
      flags: new Uint8Array(0),
      row: new Int32Array(0),
      via: new Int32Array(0),
      from: new Int32Array(0),
      to: new Int32Array(0),
      time: new Float64Array(0),
      duration: new Float64Array(0),
      depth: new Int32Array(0),
      pair: new Int32Array(0),
      actIndex: new Int32Array(0),
      foldCount: new Int32Array(0),
      foldErrors: new Int32Array(0),
      foldMaxDuration: new Float64Array(0),
      foldRowOff: new Int32Array(1),
      foldRows: new Int32Array(0),
      gapMs: new Float64Array(0),
      stepOfRow: new Int32Array(0),
      act: {
        count: 0,
        part: new Int32Array(0),
        row: new Int32Array(0),
        startStep: new Int32Array(0),
        endStep: new Int32Array(0),
        nest: new Uint8Array(0),
        parent: new Int32Array(0),
        hiddenCount: new Int32Array(0),
        collapsible: new Uint8Array(0),
        collapsed: new Uint8Array(0),
        innermostAtStep: new Int32Array(0),
      },
    };
  }

  // 1. Resolve options.
  const showInternal =
    options.internal === 'show' || (options.internal !== 'hide' && model.singleParticipant);
  const returnsMode: ReturnArrowMode = options.returns ?? 'all';
  const foldMin = options.foldMin ?? 3;
  const expandedFolds = options.expandedFolds;
  const matchesOnly = options.matchesOnly ?? false;

  const { start, end, status, nameId, subtreeEnd } = table;
  const { msgKind, from, to, via, orphan, skew, parallel } = model;

  // 2. Determine candidate message rows & prefix sum so we can check in O(1) if a range has candidates.
  const isCandidate = new Uint8Array(n);
  const candidatesBefore = new Int32Array(n + 1);
  for (let r = 0; r < n; r++) {
    const mk = msgKind[r];
    const cand = mk !== MsgKind.None && (mk !== MsgKind.Internal || showInternal) ? 1 : 0;
    isCandidate[r] = cand;
    candidatesBefore[r + 1] = candidatesBefore[r] + cand;
  }

  // 3. Filter prefix sum.
  const matchedBits = matched === null ? null : matched.bits;
  let matchesBefore: Int32Array | null = null;
  if (matchedBits !== null) {
    matchesBefore = new Int32Array(n + 1);
    for (let r = 0; r < n; r++) {
      const v = via[r];
      const hit = matchedBits[r] === 1 || (v >= 0 && matchedBits[v] === 1) ? 1 : 0;
      matchesBefore[r + 1] = matchesBefore[r] + hit;
    }
  }

  // 4. Time window prefix sum.
  let windowMatchesBefore: Int32Array | null = null;
  if (window !== null) {
    const w0 = window.t0;
    const w1 = window.t1;
    windowMatchesBefore = new Int32Array(n + 1);
    for (let r = 0; r < n; r++) {
      const s0 = start[r];
      const e0 = end[r];
      let hit = Math.max(s0, e0) >= w0 && Math.min(s0, e0) <= w1;
      if (!hit) {
        const v = via[r];
        if (v >= 0) {
          const sv = start[v];
          const ev = end[v];
          hit = Math.max(sv, ev) >= w0 && Math.min(sv, ev) <= w1;
        }
      }
      windowMatchesBefore[r + 1] = windowMatchesBefore[r] + (hit ? 1 : 0);
    }
  }

  const collapsedBits = collapsed === null ? null : collapsed.bits;

  // Helper: check if row r is marked collapsed in store
  function isRowCollapsed(r: number): boolean {
    if (collapsedBits === null) return false;
    if (collapsedBits[r] === 1) return true;
    const v = via[r];
    return v >= 0 && collapsedBits[v] === 1;
  }

  // Helper: check if a candidate message row r is a leaf in the visible projection
  // (or collapsed so its descendants are not projected).
  function isVisibleLeaf(r: number): boolean {
    if (isRowCollapsed(r)) return true;
    const endRow = subtreeEnd[r];
    return candidatesBefore[endRow] - candidatesBefore[r + 1] === 0;
  }

  // Helper: check if a candidate message row r can participate in repeat folding.
  function isFoldableCandidate(r: number): boolean {
    const mk = msgKind[r];
    if (
      mk !== MsgKind.Sync &&
      mk !== MsgKind.Peer &&
      mk !== MsgKind.Async &&
      mk !== MsgKind.SelfRpc &&
      mk !== MsgKind.Internal
    ) {
      return false;
    }
    if (windowMatchesBefore !== null) {
      const endRow = subtreeEnd[r];
      if (windowMatchesBefore[endRow] === windowMatchesBefore[r]) {
        return false;
      }
    }
    return isVisibleLeaf(r);
  }

  // Helper: find the next visible candidate sibling of `curr` within `[currEnd, limitEnd)`,
  // advancing across any non-candidate intermediate wrappers (`MsgKind.None` or hidden `MsgKind.Internal`)
  // and skipping subtrees pruned by `matchesOnly`.
  function nextVisibleSibling(currEnd: number, limitEnd: number): number {
    let p = currEnd;
    while (p < limitEnd) {
      const pEnd = subtreeEnd[p];
      if (matchesOnly && matchesBefore !== null && matchesBefore[pEnd] === matchesBefore[p]) {
        p = pEnd;
        continue;
      }
      if (isCandidate[p] === 1) {
        return p;
      }
      p++;
    }
    return -1;
  }

  // Pre-allocate step arrays (at most 2 * n steps: call + return per row) and activation arrays (at most n).
  const maxSteps = 2 * n;
  const sKind = new Uint8Array(maxSteps);
  const sFlags = new Uint8Array(maxSteps);
  const sRow = new Int32Array(maxSteps);
  const sVia = new Int32Array(maxSteps).fill(-1);
  const sFrom = new Int32Array(maxSteps);
  const sTo = new Int32Array(maxSteps);
  const sTime = new Float64Array(maxSteps);
  const sDuration = new Float64Array(maxSteps);
  const sDepth = new Int32Array(maxSteps);
  const sPair = new Int32Array(maxSteps).fill(-1);
  const sActIndex = new Int32Array(maxSteps).fill(-1);
  const sFoldCount = new Int32Array(maxSteps);
  const sFoldErrors = new Int32Array(maxSteps);
  const sFoldMaxDuration = new Float64Array(maxSteps);
  const sFoldRowOff = new Int32Array(maxSteps + 1);
  const foldRowsList: number[] = [];

  const stepOfRow = new Int32Array(n).fill(-1);

  const actPart = new Int32Array(n);
  const actRow = new Int32Array(n);
  const actStartStep = new Int32Array(n);
  const actEndStep = new Int32Array(n);
  const actNest = new Uint8Array(n);
  const actParent = new Int32Array(n).fill(-1);
  const actHiddenCount = new Int32Array(n);
  const actCollapsible = new Uint8Array(n);
  const actCollapsed = new Uint8Array(n);
  const innermostAtStep = new Int32Array(maxSteps).fill(-1);

  // Open visible call stack arrays (explicit stack, depth <= n).
  const stackRow = new Int32Array(n);
  const stackVia = new Int32Array(n);
  const stackSubtreeEnd = new Int32Array(n);
  const stackCallStep = new Int32Array(n);
  const stackActIdx = new Int32Array(n);
  const stackMsgKind = new Uint8Array(n);
  const stackFrom = new Int32Array(n);
  const stackTo = new Int32Array(n);
  const stackDepth = new Int32Array(n);
  const stackFlags = new Uint8Array(n);
  let stackTop = 0;

  // Track open activation count per participant for O(1) nesting depth.
  const openCountByPart = new Int32Array( Math.max(1, model.participants.count) );

  let stepsCount = 0;
  let actsCount = 0;
  let skipFoldUntilRow = -1;

  // Pop any open stack frames whose subtreeEnd <= limitRow.
  function popFramesUpTo(limitRow: number): void {
    while (stackTop > 0 && stackSubtreeEnd[stackTop - 1] <= limitRow) {
      stackTop--;
      const fRow = stackRow[stackTop];
      const fVia = stackVia[stackTop];
      const fCallStep = stackCallStep[stackTop];
      const fActIdx = stackActIdx[stackTop];
      const fMsgKind = stackMsgKind[stackTop];
      const fFrom = stackFrom[stackTop];
      const fTo = stackTo[stackTop];
      const fDepth = stackDepth[stackTop];
      const fFlags = stackFlags[stackTop];

      if (fTo >= 0 && fTo < openCountByPart.length) {
        openCountByPart[fTo]--;
      }

      const canReturn =
        fFrom !== fTo &&
        fFrom >= 0 &&
        fTo >= 0 &&
        (fMsgKind === MsgKind.Sync || fMsgKind === MsgKind.Peer || fMsgKind === MsgKind.Found);

      const emitReturn =
        canReturn &&
        (returnsMode === 'all' ||
          (returnsMode === 'errors' && (fFlags & StepFlag.Error) !== 0));

      if (emitReturn) {
        const retStep = stepsCount++;
        sKind[retStep] = StepKind.Return;
        sFlags[retStep] = fFlags & (StepFlag.Error | StepFlag.Skew | StepFlag.Context);
        sRow[retStep] = fRow;
        sVia[retStep] = fVia;
        sFrom[retStep] = fTo;
        sTo[retStep] = fFrom;
        sTime[retStep] = end[fRow];
        sDuration[retStep] = Math.max(0, end[fRow] - start[fRow]);
        sDepth[retStep] = fDepth;
        sPair[fCallStep] = retStep;
        sPair[retStep] = fCallStep;
        sActIndex[retStep] = fActIdx;
        sFoldCount[retStep] = 0;
        sFoldErrors[retStep] = 0;
        sFoldMaxDuration[retStep] = 0;
        sFoldRowOff[retStep + 1] = foldRowsList.length;
        innermostAtStep[retStep] = fActIdx;
        actEndStep[fActIdx] = retStep;
      } else {
        actEndStep[fActIdx] = Math.max(fCallStep, stepsCount - 1);
      }
    }
  }

  for (let r = 0; r < n; ) {
    popFramesUpTo(r);

    const endRow = subtreeEnd[r];
    const currentOpenStep = stackTop > 0 ? stackCallStep[stackTop - 1] : -1;
    const currentOpenAct = stackTop > 0 ? stackActIdx[stackTop - 1] : -1;
    const currentLimitEnd = stackTop > 0 ? stackSubtreeEnd[stackTop - 1] : n;

    // Filter pruning when `matchesOnly` is active.
    if (matchesOnly && matchesBefore !== null && matchesBefore[endRow] === matchesBefore[r]) {
      for (let c = r; c < endRow; c++) {
        if (stepOfRow[c] < 0) stepOfRow[c] = currentOpenStep;
      }
      r = endRow;
      continue;
    }

    // Non-candidate row (`MsgKind.None` or hidden `MsgKind.Internal`).
    if (isCandidate[r] === 0) {
      if (stepOfRow[r] < 0) {
        stepOfRow[r] = currentOpenStep;
      }
      r++;
      continue;
    }

    // Time window elision: if this candidate's entire subtree has zero window-overlapping spans,
    // coalesce consecutive out-of-window sibling candidate subtrees into a single `StepKind.Elided` step.
    if (windowMatchesBefore !== null && windowMatchesBefore[endRow] === windowMatchesBefore[r]) {
      const firstRow = r;
      let minStart = start[firstRow];
      let maxEnd = end[firstRow];
      let elidedCandidates = 0;
      let cursor = r;

      while (cursor < currentLimitEnd) {
        const cEnd = subtreeEnd[cursor];
        if (matchesOnly && matchesBefore !== null && matchesBefore[cEnd] === matchesBefore[cursor]) {
          cursor = cEnd;
          continue;
        }
        if (isCandidate[cursor] === 0) {
          // If an intermediate wrapper contains in-window descendants, stop coalescing before it.
          if (windowMatchesBefore[cEnd] !== windowMatchesBefore[cursor]) {
            break;
          }
          cursor = cEnd;
          continue;
        }
        if (windowMatchesBefore[cEnd] !== windowMatchesBefore[cursor]) {
          break;
        }
        elidedCandidates += candidatesBefore[cEnd] - candidatesBefore[cursor];
        for (let c = cursor; c < cEnd; c++) {
          if (start[c] < minStart) minStart = start[c];
          if (end[c] > maxEnd) maxEnd = end[c];
        }
        cursor = cEnd;
      }

      const elidedStep = stepsCount++;
      sKind[elidedStep] = StepKind.Elided;
      let flags = StepFlag.None;
      if (matchedBeforeRangeIsZero(matchesBefore, firstRow, cursor)) {
        flags |= StepFlag.Context;
      }
      sFlags[elidedStep] = flags;
      sRow[elidedStep] = firstRow;
      sVia[elidedStep] = via[firstRow];
      sFrom[elidedStep] = from[firstRow];
      sTo[elidedStep] = to[firstRow];
      sTime[elidedStep] = start[firstRow];
      sDuration[elidedStep] = Math.max(0, maxEnd - minStart);
      sDepth[elidedStep] = stackTop + 1;
      sPair[elidedStep] = -1;
      sActIndex[elidedStep] = currentOpenAct;
      sFoldCount[elidedStep] = Math.max(1, elidedCandidates);
      sFoldErrors[elidedStep] = 0;
      sFoldMaxDuration[elidedStep] = 0;
      sFoldRowOff[elidedStep + 1] = foldRowsList.length;
      innermostAtStep[elidedStep] = currentOpenAct;

      for (let c = firstRow; c < cursor; c++) {
        stepOfRow[c] = elidedStep;
      }
      const vFirst = via[firstRow];
      if (vFirst >= 0) stepOfRow[vFirst] = elidedStep;

      r = cursor;
      continue;
    }

    // Check for Repeat Folding (`StepKind.Fold`) among consecutive compatible sibling messages.
    if (foldMin >= 2 && isFoldableCandidate(r) && skipFoldUntilRow <= r) {
      const targetMk = msgKind[r];
      const targetFrom = from[r];
      const targetTo = to[r];
      const targetName = nameId[r];

      const runRows: number[] = [r];
      let lastEnd = endRow;
      while (lastEnd < currentLimitEnd) {
        const nextSib = nextVisibleSibling(lastEnd, currentLimitEnd);
        if (nextSib < 0) break;
        if (
          !isFoldableCandidate(nextSib) ||
          msgKind[nextSib] !== targetMk ||
          from[nextSib] !== targetFrom ||
          to[nextSib] !== targetTo ||
          nameId[nextSib] !== targetName
        ) {
          break;
        }
        runRows.push(nextSib);
        lastEnd = subtreeEnd[nextSib];
      }

      if (runRows.length >= foldMin) {
        const foldKey = `fold:${r}`;
        const isExpanded = expandedFolds !== undefined && expandedFolds.has(foldKey);
        if (isExpanded) {
          skipFoldUntilRow = lastEnd;
        } else {
          const foldStep = stepsCount++;
          const k = runRows.length;
          let errCount = 0;
          let sumDur = 0;
          let maxDur = 0;
          let anySkew = false;
          let anyParallel = false;
          let anyMatched = false;

          for (let i = 0; i < k; i++) {
            const ri = runRows[i];
            const vi = via[ri];
            foldRowsList.push(ri);
            const dur = Math.max(0, end[ri] - start[ri]);
            sumDur += dur;
            if (dur > maxDur) maxDur = dur;
            if (status[ri] === 2 || (vi >= 0 && status[vi] === 2)) {
              errCount++;
            }
            if (skew[ri] === 1) anySkew = true;
            if (parallel[ri] === 1) anyParallel = true;
            if (
              matchedBits !== null &&
              (matchedBits[ri] === 1 || (vi >= 0 && matchedBits[vi] === 1))
            ) {
              anyMatched = true;
            }
          }

          let foldFlags = StepFlag.None;
          if (errCount > 0) foldFlags |= StepFlag.Error;
          if (anySkew) foldFlags |= StepFlag.Skew;
          if (anyParallel) foldFlags |= StepFlag.Parallel;
          if (matchedBits !== null && !anyMatched) foldFlags |= StepFlag.Context;

          // Create 1-step activation on targetTo
          const actIdx = actsCount++;
          const nestLevel =
            targetTo >= 0 && targetTo < openCountByPart.length ? openCountByPart[targetTo] : 0;
          actPart[actIdx] = targetTo;
          actRow[actIdx] = r;
          actStartStep[actIdx] = foldStep;
          actEndStep[actIdx] = foldStep;
          actNest[actIdx] = Math.min(255, nestLevel);
          actParent[actIdx] = currentOpenAct;
          actHiddenCount[actIdx] = 0;
          actCollapsible[actIdx] = 0;
          actCollapsed[actIdx] = 0;

          sKind[foldStep] = StepKind.Fold;
          sFlags[foldStep] = foldFlags;
          sRow[foldStep] = r;
          sVia[foldStep] = via[r];
          sFrom[foldStep] = targetFrom;
          sTo[foldStep] = targetTo;
          sTime[foldStep] = start[r];
          sDuration[foldStep] = sumDur;
          sDepth[foldStep] = stackTop + 1;
          sPair[foldStep] = -1;
          sActIndex[foldStep] = actIdx;
          sFoldCount[foldStep] = k;
          sFoldErrors[foldStep] = errCount;
          sFoldMaxDuration[foldStep] = maxDur;
          sFoldRowOff[foldStep + 1] = foldRowsList.length;
          innermostAtStep[foldStep] = actIdx;

          // Map all rows in the folded range (and their via rows) to foldStep.
          for (let c = r; c < lastEnd; c++) {
            stepOfRow[c] = foldStep;
          }
          for (let i = 0; i < k; i++) {
            const vi = via[runRows[i]];
            if (vi >= 0) stepOfRow[vi] = foldStep;
          }

          r = lastEnd;
          continue;
        }
      }
    }

    // Normal candidate message step emission.
    const callStep = stepsCount++;
    const mk = msgKind[r];
    const rFrom = from[r];
    const rTo = to[r];
    const rVia = via[r];

    let stepKind: StepKind;
    if (mk === MsgKind.Found) {
      stepKind = StepKind.Found;
    } else if (mk === MsgKind.Async) {
      stepKind = StepKind.Async;
    } else if (mk === MsgKind.SelfRpc || mk === MsgKind.Internal || rFrom === rTo) {
      stepKind = StepKind.SelfCall;
    } else {
      stepKind = StepKind.Call;
    }

    const isErr = status[r] === 2 || (rVia >= 0 && status[rVia] === 2);
    let stepFlags = StepFlag.None;
    if (isErr) stepFlags |= StepFlag.Error;
    if (skew[r] === 1) stepFlags |= StepFlag.Skew;
    if (parallel[r] === 1) stepFlags |= StepFlag.Parallel;
    if (orphan[r] === 1) stepFlags |= StepFlag.Orphan;
    if (
      matchedBits !== null &&
      matchedBits[r] !== 1 &&
      (rVia < 0 || matchedBits[rVia] !== 1)
    ) {
      stepFlags |= StepFlag.Context;
    }

    const actIdx = actsCount++;
    const nestLevel =
      rTo >= 0 && rTo < openCountByPart.length ? openCountByPart[rTo] : 0;
    const hasDescendants = endRow > r + 1;
    const rowCollapsed = hasDescendants && isRowCollapsed(r);

    actPart[actIdx] = rTo;
    actRow[actIdx] = r;
    actStartStep[actIdx] = callStep;
    actEndStep[actIdx] = callStep;
    actNest[actIdx] = Math.min(255, nestLevel);
    actParent[actIdx] = currentOpenAct;
    actCollapsible[actIdx] = hasDescendants ? 1 : 0;
    actCollapsed[actIdx] = rowCollapsed ? 1 : 0;
    actHiddenCount[actIdx] = rowCollapsed ? endRow - (r + 1) : 0;

    const callDepth = stackTop + 1;
    sKind[callStep] = stepKind;
    sFlags[callStep] = stepFlags;
    sRow[callStep] = r;
    sVia[callStep] = rVia;
    sFrom[callStep] = rFrom;
    sTo[callStep] = rTo;
    sTime[callStep] = start[r];
    sDuration[callStep] = Math.max(0, end[r] - start[r]);
    sDepth[callStep] = callDepth;
    sPair[callStep] = -1;
    sActIndex[callStep] = actIdx;
    sFoldCount[callStep] = 0;
    sFoldErrors[callStep] = isErr ? 1 : 0;
    sFoldMaxDuration[callStep] = 0;
    sFoldRowOff[callStep + 1] = foldRowsList.length;
    innermostAtStep[callStep] = actIdx;

    stepOfRow[r] = callStep;
    if (rVia >= 0) {
      stepOfRow[rVia] = callStep;
    }

    // Push onto open call stack.
    stackRow[stackTop] = r;
    stackVia[stackTop] = rVia;
    stackSubtreeEnd[stackTop] = endRow;
    stackCallStep[stackTop] = callStep;
    stackActIdx[stackTop] = actIdx;
    stackMsgKind[stackTop] = mk;
    stackFrom[stackTop] = rFrom;
    stackTo[stackTop] = rTo;
    stackDepth[stackTop] = callDepth;
    stackFlags[stackTop] = stepFlags;
    stackTop++;

    if (rTo >= 0 && rTo < openCountByPart.length) {
      openCountByPart[rTo]++;
    }

    if (rowCollapsed) {
      for (let c = r + 1; c < endRow; c++) {
        stepOfRow[c] = callStep;
      }
      r = endRow;
    } else {
      r++;
    }
  }

  // Pop any remaining open frames at end of trace.
  popFramesUpTo(n + 1);

  // Slice output arrays to exact counts.
  const finalTime = sTime.subarray(0, stepsCount);
  const finalFlags = sFlags.subarray(0, stepsCount);

  // Detect idle time gaps and backwards timestamps.
  const { isGap, gapMs } = detectTimeGaps(finalTime, table.extentMs);
  for (let s = 1; s < stepsCount; s++) {
    if (isGap[s] === 1) {
      finalFlags[s] |= StepFlag.Gap;
    }
    if (finalTime[s] < finalTime[s - 1] - 1e-6) {
      finalFlags[s] |= StepFlag.Backwards;
    }
  }

  return {
    model,
    count: stepsCount,
    kind: sKind.subarray(0, stepsCount),
    flags: finalFlags,
    row: sRow.subarray(0, stepsCount),
    via: sVia.subarray(0, stepsCount),
    from: sFrom.subarray(0, stepsCount),
    to: sTo.subarray(0, stepsCount),
    time: finalTime,
    duration: sDuration.subarray(0, stepsCount),
    depth: sDepth.subarray(0, stepsCount),
    pair: sPair.subarray(0, stepsCount),
    actIndex: sActIndex.subarray(0, stepsCount),
    foldCount: sFoldCount.subarray(0, stepsCount),
    foldErrors: sFoldErrors.subarray(0, stepsCount),
    foldMaxDuration: sFoldMaxDuration.subarray(0, stepsCount),
    foldRowOff: sFoldRowOff.subarray(0, stepsCount + 1),
    foldRows: new Int32Array(foldRowsList),
    gapMs,
    stepOfRow,
    act: {
      count: actsCount,
      part: actPart.subarray(0, actsCount),
      row: actRow.subarray(0, actsCount),
      startStep: actStartStep.subarray(0, actsCount),
      endStep: actEndStep.subarray(0, actsCount),
      nest: actNest.subarray(0, actsCount),
      parent: actParent.subarray(0, actsCount),
      hiddenCount: actHiddenCount.subarray(0, actsCount),
      collapsible: actCollapsible.subarray(0, actsCount),
      collapsed: actCollapsed.subarray(0, actsCount),
      innermostAtStep: innermostAtStep.subarray(0, stepsCount),
    },
  };
}

function matchedBeforeRangeIsZero(
  matchesBefore: Int32Array | null,
  startRow: number,
  endRow: number,
): boolean {
  if (matchesBefore === null) return false;
  return matchesBefore[endRow] === matchesBefore[startRow];
}
