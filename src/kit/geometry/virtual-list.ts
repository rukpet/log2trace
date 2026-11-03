/**
 * Kit geometry: virtual list
 *
 * Windowing math for a list of fixed-height rows inside a scroll viewport:
 * which rows to render, where to scroll to reveal a row, and how to keep a
 * row where it was on screen when the row list changes (collapse, expand,
 * filter). Row `r` occupies `[r * rowHeight, (r + 1) * rowHeight)` in content
 * coordinates, and `scrollTop` is the content offset of the viewport's top edge.
 *
 * Pure functions with no DOM: the canvas and DOM painters share them, and
 * tests run in plain Node. Bad input (zero or negative sizes, NaN) gives an
 * empty range or a scroll position of 0, never NaN.
 */

/** Geometry of a list: rows of one height in a viewport of another. */
export interface ListMetrics {
  /** Height of every row, px. */
  readonly rowHeight: number;
  /** Number of rows. */
  readonly rowCount: number;
  /** Height of the scroll viewport, px. */
  readonly viewportHeight: number;
}

/** Inclusive range of row indices. `last < first` means no rows. */
export interface RowRange {
  readonly first: number;
  readonly last: number;
}

/**
 * Where {@link ensureRowVisible} puts the row: `nearest` scrolls as little as
 * possible (not at all when the row is already fully visible), `center`
 * always puts the row in the middle of the viewport.
 */
export type RevealAlign = 'nearest' | 'center';

const NO_ROWS: RowRange = Object.freeze({ first: 0, last: -1 });

/** Number of rows as a whole number, 0 for anything that is not positive and finite. */
function rowsIn(metrics: ListMetrics): number {
  return Number.isFinite(metrics.rowCount) && metrics.rowCount > 0 ? Math.floor(metrics.rowCount) : 0;
}

/** Whether rows have a usable height. */
function hasRows(metrics: ListMetrics): boolean {
  return metrics.rowHeight > 0 && Number.isFinite(metrics.rowHeight) && rowsIn(metrics) > 0;
}

/**
 * Largest scroll position: the content height minus the viewport height, or 0
 * when everything fits.
 */
export function maxScrollTop(metrics: ListMetrics): number {
  if (!hasRows(metrics)) return 0;
  const hidden = metrics.rowHeight * rowsIn(metrics) - metrics.viewportHeight;
  return hidden > 0 ? hidden : 0;
}

/**
 * Bring a scroll position into `[0, maxScrollTop]`. NaN becomes 0. Use it
 * after the row count or viewport size changed, and on overscroll bounce.
 */
export function clampScrollTop(metrics: ListMetrics, scrollTop: number): number {
  if (!(scrollTop > 0)) return 0;
  return Math.min(scrollTop, maxScrollTop(metrics));
}

/**
 * Rows to render for a scroll position: those that intersect the viewport,
 * plus `overscan` more on each side, limited to the rows that exist. The
 * scroll position is clamped first, so overscroll still yields valid rows.
 * A row that is visible by even a sliver is included.
 *
 * @param metrics - List geometry.
 * @param scrollTop - Scroll position, px.
 * @param overscan - Extra rows above and below the viewport; negative or fractional values are rounded down to a whole number of at least 0.
 * @returns The inclusive range to render; empty when there are no rows or the viewport has no height.
 */
export function visibleRange(metrics: ListMetrics, scrollTop: number, overscan: number = 0): RowRange {
  if (!hasRows(metrics) || !(metrics.viewportHeight > 0)) return NO_ROWS;

  const top = clampScrollTop(metrics, scrollTop);
  const extra = overscan > 0 ? Math.floor(overscan) : 0;
  const first = Math.max(0, Math.floor(top / metrics.rowHeight) - extra);
  const last = Math.min(
    rowsIn(metrics) - 1,
    Math.ceil((top + metrics.viewportHeight) / metrics.rowHeight) - 1 + extra,
  );
  return { first, last };
}

/**
 * The scroll position that reveals a row.
 *
 * With `nearest`, a row already fully visible keeps the current position; one
 * above the viewport is aligned to its top edge, one below to its bottom edge
 * (a row taller than the viewport is aligned to the top). With `center` the row
 * is put in the middle of the viewport. Either way the result stays within
 * `[0, maxScrollTop]`, so rows near the ends are as centred as the list allows.
 *
 * @param metrics - List geometry.
 * @param scrollTop - Current scroll position, px.
 * @param row - Row to reveal; clamped to the rows that exist.
 * @param align - Where to put the row.
 * @returns The new scroll position; 0 for a list without rows.
 */
export function ensureRowVisible(
  metrics: ListMetrics,
  scrollTop: number,
  row: number,
  align: RevealAlign,
): number {
  if (!hasRows(metrics)) return 0;

  const index = row > 0 ? Math.min(Math.floor(row), rowsIn(metrics) - 1) : 0;
  const top = index * metrics.rowHeight;
  const bottom = top + metrics.rowHeight;

  if (align === 'center') {
    return clampScrollTop(metrics, top + (metrics.rowHeight - metrics.viewportHeight) / 2);
  }

  const current = clampScrollTop(metrics, scrollTop);
  if (top < current) return clampScrollTop(metrics, top);
  if (bottom > current + metrics.viewportHeight) {
    return clampScrollTop(metrics, Math.min(bottom - metrics.viewportHeight, top));
  }
  return current;
}

/**
 * The scroll position that keeps a row at the same screen y after the row
 * list changed and the row moved from index `fromRow` to `toRow`:
 * `toRow * rowHeight - (fromRow * rowHeight - scrollTop)`. When the new scroll
 * range does not allow it (the row ended up near the top or bottom of a short
 * list), the nearest position that does is used. If the row is gone
 * (`toRow < 0`), only the clamping applies.
 *
 * Capture `fromRow` before the change, from the selected row if it is on
 * screen and otherwise the first visible one, and pass the metrics of the
 * list as it is after the change.
 *
 * @param metrics - Geometry of the list after the change.
 * @param scrollTop - Scroll position before the change, px.
 * @param fromRow - Index of the anchor row before the change.
 * @param toRow - Index of the same row after the change, or -1 if it no longer exists.
 */
export function keepRowAtSameY(
  metrics: ListMetrics,
  scrollTop: number,
  fromRow: number,
  toRow: number,
): number {
  if (!(toRow >= 0) || !(fromRow >= 0) || !hasRows(metrics)) return clampScrollTop(metrics, scrollTop);
  return clampScrollTop(metrics, scrollTop + (toRow - fromRow) * metrics.rowHeight);
}
