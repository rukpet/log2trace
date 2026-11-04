/**
 * Rows: which spans the waterfall shows, and in which row.
 *
 * The table lists every span in depth-first order; the waterfall shows a subset
 * of them, one per row, in the same order. Collapsing a span hides its
 * descendants. A filter keeps the matching spans and, so that the tree stays
 * readable, their ancestors as dimmed "context" rows.
 *
 * The projection is computed in one pass over the table rows and is cheap enough
 * (well under a millisecond at 50,000 spans) to redo after every change, so
 * there is no incremental bookkeeping. Subtrees that are collapsed or hold no
 * match are skipped in one step through `subtreeEnd`.
 *
 * Headless: no DOM, no browser globals.
 */

import type { SpanMask } from '../../../core/span-set.ts';
import type { SpanIndex } from '../../../core/span-index.ts';

/** What a row's chevron shows. */
export enum Chevron {
  /** No chevron: the span has no children on show. */
  None = 0,
  /** Pointing down: the children are shown. */
  Expanded = 1,
  /** Pointing right: the children are hidden. */
  Collapsed = 2,
}

/** The spans shown by the waterfall. Immutable once built. */
export interface RowProjection {
  /** Number of rows. */
  readonly count: number;
  /** Table row of the span shown in each waterfall row; `count` entries. */
  readonly rows: Int32Array;
  /** Waterfall row of each table row, or -1 when the span is hidden; one entry per table row. */
  readonly rowOf: Int32Array;
  /** 1 for a row that is shown only as the ancestor of a match (draw it dimmed), else 0; `count` entries. */
  readonly context: Uint8Array;
}

/**
 * Work out which spans are visible.
 *
 * @param index - The loaded trace.
 * @param collapsed - Spans whose children are hidden, or `null` for none.
 * @param matched - Spans that passed the filter, or `null` when no filter is active. When set, only
 *   matches and their ancestors are shown (the ancestors as context rows).
 * @returns The rows, in depth-first order.
 * @throws Error when a mask belongs to a trace of a different size than `index`.
 */
export function projectRows(
  index: SpanIndex,
  collapsed: SpanMask | null,
  matched: SpanMask | null,
): RowProjection {
  const { table } = index;
  const n = table.length;
  if (collapsed !== null && collapsed.bits.length !== n) {
    throw new Error(`projectRows: the collapsed mask has ${collapsed.bits.length} rows, the trace has ${n}`);
  }
  if (matched !== null && matched.bits.length !== n) {
    throw new Error(`projectRows: the match mask has ${matched.bits.length} rows, the trace has ${n}`);
  }

  const { subtreeEnd } = table;
  const collapsedBits = collapsed === null ? null : collapsed.bits;
  const rows = new Int32Array(n);
  const rowOf = new Int32Array(n).fill(-1);
  const context = new Uint8Array(n);
  let count = 0;

  if (matched === null) {
    for (let row = 0; row < n;) {
      rowOf[row] = count;
      rows[count++] = row;
      row = collapsedBits !== null && collapsedBits[row] === 1 ? subtreeEnd[row] : row + 1;
    }
  } else {
    const matchedBits = matched.bits;
    // matchesBefore[r] = number of matches among the table rows before r, so a subtree holds a match
    // exactly when the count differs between its start and its end.
    const matchesBefore = new Int32Array(n + 1);
    for (let row = 0; row < n; row++) matchesBefore[row + 1] = matchesBefore[row] + matchedBits[row];

    for (let row = 0; row < n;) {
      const end = subtreeEnd[row];
      if (matchesBefore[end] === matchesBefore[row]) {
        row = end;
        continue;
      }
      rowOf[row] = count;
      context[count] = matchedBits[row] === 1 ? 0 : 1;
      rows[count++] = row;
      row = collapsedBits !== null && collapsedBits[row] === 1 ? end : row + 1;
    }
  }

  return { count, rows: rows.subarray(0, count), rowOf, context: context.subarray(0, count) };
}

/**
 * The chevron of a row: collapsed when the span's children are hidden by collapsing, expanded when
 * the next row shown is one of its descendants, none otherwise (a leaf, or a span whose children
 * are all filtered out).
 *
 * @param index - The loaded trace.
 * @param projection - The rows shown.
 * @param collapsed - Spans whose children are hidden, or `null` for none.
 * @param row - The waterfall row.
 */
export function chevronOf(
  index: SpanIndex,
  projection: RowProjection,
  collapsed: SpanMask | null,
  row: number,
): Chevron {
  const span = projection.rows[row];
  const end = index.table.subtreeEnd[span];
  if (end <= span + 1) return Chevron.None;
  if (collapsed !== null && collapsed.bits[span] === 1) return Chevron.Collapsed;
  return row + 1 < projection.count && projection.rows[row + 1] < end ? Chevron.Expanded : Chevron.None;
}
