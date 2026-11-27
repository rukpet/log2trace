/**
 * Level packing: putting the spans of one lane on as few rows ("levels") as possible.
 *
 * Spans do not follow stack rules: siblings of one service overlap, an async child outlives its
 * parent, clocks skew. So instead of drawing each request as a rigid stack, a lane is packed
 * greedily, left to right in time:
 *
 * - every span gets an ordering key `eff = max(start, eff[parent])` when its parent is in the same
 *   lane, else `start`; rows are in depth-first order, so a parent's key is known before its child's;
 * - spans are sorted by `(eff, row)`, so a parent is always placed before its children;
 * - each level remembers when it becomes free (`busyUntil`); a span goes on the lowest level at or
 *   above `minLevel` that is free at its start, where `minLevel` is the parent's level plus one when the
 *   parent is in the same lane, else 0;
 * - a span with no duration (or one that ends before it starts) holds its level for a tiny
 *   {@link INSTANT_MS}, so instants at the same moment stack instead of hiding each other.
 *
 * This gives no overlap on any level (a span fits only after everything already on its level has
 * ended), a child strictly below its same-lane parent, and at least as many levels as the true peak
 * concurrency. The fit test uses the span's own start rather than `eff`, so the no-overlap guarantee
 * also holds when a child starts before its parent; without clock skew the two are the same.
 *
 * Finding the lowest free level uses a minimum tree over the levels' `busyUntil`, so packing is
 * `O(m log m)` however many spans run at once.
 *
 * Headless: no DOM, no browser globals.
 */

/** How long a span without duration holds its level, ms: one nanosecond, the resolution of the trace. */
export const INSTANT_MS = 1e-6;

/** When the parent of a row is in the lane being packed: needed for the "child below parent" rule. */
export interface PackConstraint {
  /** Parent row of each row, or -1 (`SpanTable.parent`). */
  readonly parent: Int32Array;
  /** Lane of each row; a parent counts only when its lane is `lane`. */
  readonly laneOfRow: Int32Array;
  /** The lane being packed. */
  readonly lane: number;
}

/** Buffers reused across lanes; create one per trace with {@link createPackScratch}. */
export interface PackScratch {
  /** Ordering key of each row, indexed by table row. */
  eff: Float64Array;
  /** Minimum tree over `busyUntil`; grown on demand. */
  tree: Float64Array;
}

/** Make scratch buffers for a trace of `rowCount` spans. */
export function createPackScratch(rowCount: number): PackScratch {
  return { eff: new Float64Array(rowCount), tree: new Float64Array(2) };
}

/**
 * Pack one lane.
 *
 * @param rows - Table rows of the lane, ascending. Sorted in place into placement order, which is also
 * start order within every level.
 * @param start - Start of each row, ms (`SpanTable.start`).
 * @param end - End of each row, ms (`SpanTable.end`); may be before the start.
 * @param constraint - Parent rule for a service lane, or `null` for no constraint (ghost spans on a peer lane).
 * @param levelOfRow - Receives the level of each packed row, at its table row index. For a constrained
 * lane it must already hold the levels of any same-lane parents, which holds when rows go in this lane's order.
 * @param scratch - Reusable buffers.
 * @returns The number of levels used (0 for no rows).
 */
export function packLevels(
  rows: Int32Array,
  start: Float64Array,
  end: Float64Array,
  constraint: PackConstraint | null,
  levelOfRow: Int32Array,
  scratch: PackScratch,
): number {
  const m = rows.length;
  if (m === 0) return 0;
  const eff = scratch.eff;

  let sorted = true;
  let previous = -Infinity;
  for (let k = 0; k < m; k++) {
    const r = rows[k];
    let key = start[r];
    if (constraint !== null) {
      const p = constraint.parent[r];
      if (p >= 0 && constraint.laneOfRow[p] === constraint.lane && eff[p] > key) key = eff[p];
    }
    eff[r] = key;
    if (key < previous) sorted = false;
    previous = key;
  }
  if (!sorted) rows.sort((a, b) => eff[a] - eff[b] || a - b);

  // Levels are numbered from 0 and at most `m` are ever used: a level above the parent's is at most `depth in lane` high.
  let size = 1;
  while (size < m) size <<= 1;
  if (scratch.tree.length < 2 * size) scratch.tree = new Float64Array(2 * size);
  const tree = scratch.tree;
  tree.fill(-Infinity, 0, 2 * size);

  let levels = 0;
  for (let k = 0; k < m; k++) {
    const r = rows[k];
    let minLevel = 0;
    if (constraint !== null) {
      const p = constraint.parent[r];
      if (p >= 0 && constraint.laneOfRow[p] === constraint.lane) minLevel = levelOfRow[p] + 1;
    }

    const s = start[r];
    const level = firstFree(tree, size, minLevel, s);
    levelOfRow[r] = level;
    if (level >= levels) levels = level + 1;

    const e = end[r];
    let i = level + size;
    tree[i] = e > s ? e : s + INSTANT_MS;
    for (i >>= 1; i >= 1; i >>= 1) {
      const a = tree[2 * i];
      const b = tree[2 * i + 1];
      tree[i] = a < b ? a : b;
    }
  }
  return levels;
}

/** The lowest leaf index `>= from` whose value is `<= time`; leaves that were never used are `-Infinity`, so one always exists. */
function firstFree(tree: Float64Array, size: number, from: number, time: number): number {
  let i = from + size;
  for (;;) {
    if (tree[i] <= time) {
      while (i < size) i = tree[2 * i] <= time ? 2 * i : 2 * i + 1;
      return i - size;
    }
    while (i & 1) i >>= 1;
    i++;
  }
}
