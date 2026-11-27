/**
 * Lane summaries: how busy a lane is over time, without drawing its spans.
 *
 * A lane's load is a step function: the number of intervals in flight, `level[k]`, from
 * `times[k]` until `times[k + 1]` (0 before the first step and after the last). Lanes count
 * what is meaningful for them: a service lane counts its local roots (requests or messages in
 * flight, not the spans nested in them), a peer lane counts the calls that reach it. A second step
 * function over every span of the lane gives its busy union and from it the idle gaps.
 *
 * Everything here is a pure function over typed arrays. Building is `O(k log k)` for `k` intervals; a
 * frame samples a window in `O(steps in window + columns)`. With a filter mask only the matched
 * spans are counted, so a summary can show where the matches cluster.
 *
 * Headless: no DOM, no browser globals.
 */

import { INSTANT_MS } from './pack.ts';

/** In-flight count over time: `level[k]` holds from `times[k]` (inclusive) to `times[k + 1]` (exclusive). */
export interface Steps {
  /** Strictly increasing step times, ms. */
  readonly times: Float64Array;
  /** Count in flight from each step on; the last entry is 0. */
  readonly level: Int32Array;
  /** Highest count, 0 for no intervals. */
  readonly peak: number;
}

/** The empty step function. */
export const NO_STEPS: Steps = Object.freeze({ times: new Float64Array(0), level: new Int32Array(0), peak: 0 });

/**
 * Count intervals in flight over time.
 *
 * An interval holds from its start up to, not including, its end, so back-to-back intervals do not
 * overlap. Both arrays are sorted in place.
 *
 * @param starts - Start of each interval, ms.
 * @param ends - End of each interval, ms, in any order of its own: only the multiset matters. Each end must be after its start (see {@link intervalsOf}).
 */
export function buildSteps(starts: Float64Array, ends: Float64Array): Steps {
  const k = starts.length;
  if (k === 0) return NO_STEPS;
  starts.sort();
  ends.sort();

  const times = new Float64Array(2 * k);
  const level = new Int32Array(2 * k);
  let count = 0;
  let current = 0;
  let peak = 0;
  let i = 0;
  let j = 0;
  while (j < k) {
    const t = i < k && starts[i] < ends[j] ? starts[i] : ends[j];
    while (j < k && ends[j] === t) { current--; j++; }
    while (i < k && starts[i] === t) { current++; i++; }
    if (count === 0 || level[count - 1] !== current) {
      times[count] = t;
      level[count] = current;
      count++;
      if (current > peak) peak = current;
    }
  }
  return { times: times.slice(0, count), level: level.slice(0, count), peak };
}

/** Start and end arrays of a set of intervals, as {@link buildSteps} wants them. */
export interface Intervals {
  readonly starts: Float64Array;
  readonly ends: Float64Array;
}

/**
 * Gather the intervals of some rows, giving each at least {@link INSTANT_MS} so that an instant or a
 * span that ends before it starts still counts.
 *
 * @param rows - Table rows, read from `from` up to `to`.
 * @param start - `SpanTable.start`.
 * @param end - `SpanTable.end`.
 * @param mask - Only rows with a 1 here are taken; `null` takes all (`SpanMask.bits` for a filter).
 */
export function intervalsOf(
  rows: Int32Array,
  from: number,
  to: number,
  start: Float64Array,
  end: Float64Array,
  mask: Uint8Array | null = null,
): Intervals {
  const starts = new Float64Array(to - from);
  const ends = new Float64Array(to - from);
  let k = 0;
  for (let i = from; i < to; i++) {
    const r = rows[i];
    if (mask !== null && mask[r] !== 1) continue;
    const s = start[r];
    const e = end[r];
    starts[k] = s;
    ends[k] = e > s ? e : s + INSTANT_MS;
    k++;
  }
  return k === starts.length ? { starts, ends } : { starts: starts.slice(0, k), ends: ends.slice(0, k) };
}

/** Steps of the given rows; with `mask` (a filter's `SpanMask.bits`) only the matched ones count. */
export function stepsOfRows(
  rows: Int32Array,
  from: number,
  to: number,
  start: Float64Array,
  end: Float64Array,
  mask: Uint8Array | null = null,
): Steps {
  const { starts, ends } = intervalsOf(rows, from, to, start, end, mask);
  return buildSteps(starts, ends);
}

/** Count in flight at time `t`. */
export function levelAt(steps: Steps, t: number): number {
  const k = upperBound(steps.times, t) - 1;
  return k < 0 ? 0 : steps.level[k];
}

/**
 * For each of `columns` equal slices of the window `t0 … t1`, the highest count in flight at any moment of
 * the slice. A step at exactly the start of a slice belongs to that slice.
 *
 * @param steps - The load.
 * @param t0 - Window start, ms.
 * @param t1 - Window end, ms.
 * @param columns - Number of slices (pixel columns).
 * @param out - Receives one count per slice; needs `columns` entries.
 * @returns The highest count in the window.
 */
export function sampleColumns(steps: Steps, t0: number, t1: number, columns: number, out: Int32Array): number {
  const { times, level } = steps;
  const n = times.length;
  const dt = (t1 - t0) / columns;
  let j = 0;
  let current = 0;
  let max = 0;
  // The first step after t0 is found by binary search; everything before it only sets the starting level.
  if (n > 0) {
    j = upperBound(times, t0);
    current = j > 0 ? level[j - 1] : 0;
  }
  for (let c = 0; c < columns; c++) {
    const a = t0 + c * dt;
    const b = c === columns - 1 ? t1 : a + dt;
    while (j < n && times[j] <= a) current = level[j++];
    let m = current;
    while (j < n && times[j] < b) {
      current = level[j++];
      if (current > m) m = current;
    }
    out[c] = m;
    if (m > max) max = m;
  }
  return max;
}

/** Disjoint stretches during which something is in flight. */
export interface Busy {
  /** Start of each stretch, ms; ascending. */
  readonly from: Float64Array;
  /** End of each stretch, ms; `from[k] < to[k] < from[k + 1]`. */
  readonly to: Float64Array;
  /** Total length of the stretches, ms. */
  readonly totalMs: number;
}

/** The stretches where the count in flight is above 0. */
export function busyOf(steps: Steps): Busy {
  const { times, level } = steps;
  const from: number[] = [];
  const to: number[] = [];
  let total = 0;
  for (let k = 0; k < times.length; k++) {
    const busy = level[k] > 0;
    const wasBusy = k > 0 && level[k - 1] > 0;
    if (busy && !wasBusy) from.push(times[k]);
    else if (!busy && wasBusy) {
      to.push(times[k]);
      total += times[k] - from[from.length - 1];
    }
  }
  return { from: Float64Array.from(from), to: Float64Array.from(to), totalMs: total };
}

/** An idle stretch between two busy ones. */
export interface IdleGap {
  /** When the previous busy stretch ended, ms. */
  from: number;
  /** When the next busy stretch starts, ms. */
  to: number;
}

/**
 * Find the idle stretch around time `t`: the gap between the busy stretches before and after it.
 *
 * Before the first and after the last busy stretch is not a gap (nothing bounds it), and neither is a
 * moment inside a busy stretch.
 *
 * @param out - Receives the gap.
 * @returns Whether `t` is in a gap.
 */
export function idleGapAt(busy: Busy, t: number, out: IdleGap): boolean {
  const k = upperBound(busy.from, t) - 1;
  if (k < 0 || k >= busy.from.length - 1) return false;
  if (t < busy.to[k]) return false;
  out.from = busy.to[k];
  out.to = busy.from[k + 1];
  return true;
}

/** First index whose value is above `value` in an ascending array (`length` when none). */
function upperBound(values: Float64Array, value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
