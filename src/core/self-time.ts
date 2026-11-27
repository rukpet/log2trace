/**
 * Windowed interval-union self-time computation shared across views.
 *
 * Computes clipped duration, non-overlapping exclusive self-time, and window
 * membership for every span row in a single O(N) pass, relying on `SpanTable`'s
 * depth-first pre-order and sibling start-time ordering invariants.
 *
 * Headless: no DOM, no browser globals.
 */

import { defineSelector, type Selector } from './selectors.ts';
import type { SpanIndex } from './span-index.ts';
import { Slice, type TimeWindow } from './state.ts';

/** Per-row clipped duration, exclusive self-time, and window membership. */
export interface SpanTimings {
  readonly index: SpanIndex;
  /** The time window timings were clipped to, or `null` for the whole trace. */
  readonly window: TimeWindow | null;
  /** Clipped duration of each span in ms (`>= 0`). */
  readonly duration: Float64Array;
  /** Clipped non-overlapping exclusive self-time of each span in ms (`>= 0`). */
  readonly selfTime: Float64Array;
  /** `1` when the span is active in `window` (or `window === null`), including zero-duration spans inside `[t0, t1]`; `0` otherwise. */
  readonly inWindow: Uint8Array;
  /** Count of rows with `inWindow[r] === 1`. */
  readonly activeCount: number;
  /** Sum of `selfTime[r]` across all rows, ms. */
  readonly totalSelfMs: number;
  /** Maximum `duration[r]` across all rows, ms. */
  readonly maxDurationMs: number;
}

/**
 * Compute clipped durations and exact O(N) interval-union self-times for `index`
 * within `window`.
 */
export function computeSpanTimings(index: SpanIndex, window: TimeWindow | null): SpanTimings {
  const t = index.table;
  const n = t.length;

  const duration = new Float64Array(n);
  const selfTime = new Float64Array(n);
  const inWindow = new Uint8Array(n);
  const coveredByChildren = new Float64Array(n);
  const curStart = new Float64Array(n);
  const curEnd = new Float64Array(n).fill(-Infinity);

  let activeCount = 0;
  let maxDurationMs = 0;

  for (let r = 0; r < n; r++) {
    const rawStart = t.start[r];
    const rawEnd = t.end[r];
    const clampedEnd = rawEnd > rawStart ? rawEnd : rawStart;

    let from: number;
    let to: number;
    if (window === null) {
      from = rawStart;
      to = clampedEnd;
      inWindow[r] = 1;
      activeCount++;
    } else {
      const t0 = window.t0;
      const t1 = window.t1;
      if (clampedEnd > rawStart) {
        if (clampedEnd > t0 && rawStart < t1) {
          from = rawStart > t0 ? rawStart : t0;
          to = clampedEnd < t1 ? clampedEnd : t1;
          inWindow[r] = 1;
          activeCount++;
        } else {
          from = 0;
          to = 0;
        }
      } else if (rawStart >= t0 && rawStart <= t1) {
        from = rawStart;
        to = rawStart;
        inWindow[r] = 1;
        activeCount++;
      } else {
        from = 0;
        to = 0;
      }
    }

    const dur = to > from ? to - from : 0;
    duration[r] = dur;
    if (dur > maxDurationMs) maxDurationMs = dur;

    const p = t.parent[r];
    if (p >= 0 && dur > 0) {
      const pRawStart = t.start[p];
      const pRawEnd = t.end[p];
      const pClampedEnd = pRawEnd > pRawStart ? pRawEnd : pRawStart;
      const pFrom = window === null ? pRawStart : Math.max(pRawStart, window.t0);
      const pTo = window === null ? pClampedEnd : Math.min(pClampedEnd, window.t1);
      const cStart = from > pFrom ? from : pFrom;
      const cEnd = to < pTo ? to : pTo;

      if (cEnd > cStart) {
        if (curEnd[p] === -Infinity) {
          curStart[p] = cStart;
          curEnd[p] = cEnd;
        } else if (cStart > curEnd[p]) {
          coveredByChildren[p] += curEnd[p] - curStart[p];
          curStart[p] = cStart;
          curEnd[p] = cEnd;
        } else if (cEnd > curEnd[p]) {
          curEnd[p] = cEnd;
        }
      }
    }
  }

  let totalSelfMs = 0;
  for (let r = 0; r < n; r++) {
    if (curEnd[r] !== -Infinity) {
      coveredByChildren[r] += curEnd[r] - curStart[r];
    }
    const self = duration[r] - coveredByChildren[r];
    const clampedSelf = self > 0 ? self : 0;
    selfTime[r] = clampedSelf;
    totalSelfMs += clampedSelf;
  }

  return {
    index,
    window,
    duration,
    selfTime,
    inWindow,
    activeCount,
    totalSelfMs,
    maxDurationMs,
  };
}

/** Cached windowed span timings, recomputed only when data or time window changes. */
export const spanTimings: Selector<SpanTimings> = defineSelector(
  'core.spanTimings',
  Slice.Data | Slice.Window,
  (state, previous) => {
    const { window } = state;
    const same =
      previous !== undefined
      && previous.index === state.data.index
      && previous.window?.t0 === window?.t0
      && previous.window?.t1 === window?.t1;
    return same ? previous : computeSpanTimings(state.data.index, window);
  },
);
