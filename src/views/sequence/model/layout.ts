/**
 * Layout: the fixed and dynamic geometry of the sequence diagram.
 *
 * Headless: no DOM, no browser globals.
 */

/** Height of the sticky lifeline header band in CSS px. */
export const HEADER_H = 44;
/** Width of the sticky left time-gutter column in CSS px. */
export const GUTTER_W = 92;
/** Default width of one participant lifeline column in CSS px. */
export const COL_W = 168;
/** Minimum width of one participant lifeline column when fitting to viewport in CSS px. */
export const MIN_COL_W = 96;
/** Maximum width of one participant lifeline column when few columns exist in CSS px. */
export const MAX_COL_W = 240;
/** Horizontal padding at the left and right edges of the lifeline canvas in CSS px. */
export const CANVAS_PAD_X = 24;
/** Vertical padding at the top and bottom of the step rows in CSS px. */
export const CANVAS_PAD_Y = 12;
/** Default step row height in CSS px. */
export const ROW_H_DEFAULT = 28;
/** Minimum step row height in CSS px. */
export const ROW_H_MIN = 18;
/** Maximum step row height in CSS px. */
export const ROW_H_MAX = 48;
/** Width of an activation bar on a lifeline in CSS px. */
export const ACT_W = 10;
/** Horizontal offset added per nesting level of recursive/self activations on the same lifeline in CSS px. */
export const NEST_DX = 5;
/** Maximum visual nesting levels offset before clamping with a depth badge. */
export const MAX_NEST = 6;
/** Radius of a self-call loop to the right of the activation bar in CSS px. */
export const SELF_LOOP_W = 36;

export interface SequenceLayout {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly headerHeight: number;
  readonly gutterWidth: number;
  readonly columnCount: number;
  readonly columnWidth: number;
  readonly rowCount: number;
  readonly rowHeight: number;
  /** Total scrollable content width (gutterWidth + columns area). */
  readonly contentWidth: number;
  /** Total scrollable body height (excluding sticky header: `rowCount * rowHeight + 2 * CANVAS_PAD_Y`). */
  readonly bodyHeight: number;
  /** Height of the scrollable viewport below the sticky header (`Math.max(0, viewHeight - headerHeight)`). */
  readonly bodyViewportHeight: number;
}

/** Compute the layout geometry for the sequence diagram. */
export function computeSequenceLayout(params: {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly columnCount: number;
  readonly rowCount: number;
  readonly rowHeight?: number;
  readonly fitColumns?: boolean;
  readonly gutterWidth?: number;
}): SequenceLayout {
  const viewWidth = Number.isFinite(params.viewWidth) && params.viewWidth > 0 ? params.viewWidth : 0;
  const viewHeight = Number.isFinite(params.viewHeight) && params.viewHeight > 0 ? params.viewHeight : 0;
  const headerHeight = HEADER_H;
  const gutterWidth =
    params.gutterWidth !== undefined && Number.isFinite(params.gutterWidth) && params.gutterWidth >= 0
      ? params.gutterWidth
      : GUTTER_W;
  const columnCount =
    Number.isFinite(params.columnCount) && params.columnCount > 0 ? Math.floor(params.columnCount) : 0;
  const rowCount =
    Number.isFinite(params.rowCount) && params.rowCount > 0 ? Math.floor(params.rowCount) : 0;
  const rowHeight =
    params.rowHeight !== undefined && Number.isFinite(params.rowHeight)
      ? Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, params.rowHeight))
      : ROW_H_DEFAULT;

  let columnWidth = COL_W;
  if (params.fitColumns && columnCount > 0) {
    const availW = Math.max(0, viewWidth - gutterWidth - 2 * CANVAS_PAD_X);
    columnWidth = Math.min(MAX_COL_W, Math.max(MIN_COL_W, availW / columnCount));
  }

  const columnsAreaWidth = columnCount > 0 ? 2 * CANVAS_PAD_X + columnCount * columnWidth : 0;
  const contentWidth = gutterWidth + columnsAreaWidth;
  const bodyHeight = rowCount * rowHeight + 2 * CANVAS_PAD_Y;
  const bodyViewportHeight = Math.max(0, viewHeight - headerHeight);

  return {
    viewWidth,
    viewHeight,
    headerHeight,
    gutterWidth,
    columnCount,
    columnWidth,
    rowCount,
    rowHeight,
    contentWidth,
    bodyHeight,
    bodyViewportHeight,
  };
}

/** X coordinate (in content space, where 0 is the left edge of the surface including gutter) of the center of lifeline column `col`. */
export function lifelineCenterX(layout: SequenceLayout, col: number): number {
  return layout.gutterWidth + CANVAS_PAD_X + (col + 0.5) * layout.columnWidth;
}

/** Left and right X coordinates (in content space) of an activation box on column `col` with nesting depth `nest` (`0`-based). */
export function activationBoxX(
  layout: SequenceLayout,
  col: number,
  nest: number,
): { readonly x: number; readonly w: number; readonly clampedNest: number } {
  const rawNest = Number.isFinite(nest) ? Math.floor(nest) : 0;
  const clampedNest = Math.min(MAX_NEST, Math.max(0, rawNest));
  const centerX = lifelineCenterX(layout, col);
  const x = centerX - ACT_W / 2 + clampedNest * NEST_DX;
  return { x, w: ACT_W, clampedNest };
}

/** Y coordinate (in body content space, below the header) of the top of step row `step` and its vertical center (arrow line Y). */
export function stepRowY(
  layout: SequenceLayout,
  step: number,
): { readonly top: number; readonly centerY: number; readonly bottom: number } {
  const top = CANVAS_PAD_Y + step * layout.rowHeight;
  const centerY = top + layout.rowHeight / 2;
  const bottom = top + layout.rowHeight;
  return { top, centerY, bottom };
}

/** Convert a body-relative Y coordinate (`clientY - headerHeight + scrollTop`) to a step index (`0 .. rowCount - 1`), or `-1` if out of range. */
export function stepAtBodyY(layout: SequenceLayout, bodyY: number): number {
  if (layout.rowCount <= 0 || !Number.isFinite(bodyY)) return -1;
  const relY = bodyY - CANVAS_PAD_Y;
  if (relY < 0) return -1;
  const step = Math.floor(relY / layout.rowHeight);
  return step >= 0 && step < layout.rowCount ? step : -1;
}

/** Find the nearest column index (`0 .. columnCount - 1`) to a content-space X coordinate, or `-1` if `x < layout.gutterWidth` or `columnCount === 0`. */
export function columnAtContentX(layout: SequenceLayout, contentX: number): number {
  if (layout.columnCount <= 0 || !Number.isFinite(contentX) || contentX < layout.gutterWidth) {
    return -1;
  }
  const relX = contentX - layout.gutterWidth - CANVAS_PAD_X;
  const col = Math.floor(relX / layout.columnWidth);
  return Math.max(0, Math.min(layout.columnCount - 1, col));
}

/**
 * Determine which steps have a significant time gap before them.
 * A step `s > 0` has a gap break when `dt = time[s] - time[s - 1]` is strictly positive and
 * `dt >= Math.max(extentMs * 0.02, medianPositiveDelta * 3, 1)`.
 * Returns a `Uint8Array(time.length)` with `1` where a gap break occurs, and `Float64Array(time.length)` with the delta `dt`.
 */
export function detectTimeGaps(
  time: Float64Array,
  extentMs: number,
): { readonly isGap: Uint8Array; readonly gapMs: Float64Array } {
  const n = time.length;
  const isGap = new Uint8Array(n);
  const gapMs = new Float64Array(n);
  if (n <= 1) {
    return { isGap, gapMs };
  }

  const positiveDeltas: number[] = [];
  for (let s = 1; s < n; s++) {
    const dt = time[s] - time[s - 1];
    if (Number.isFinite(dt) && dt > 0) {
      gapMs[s] = dt;
      positiveDeltas.push(dt);
    }
  }

  if (positiveDeltas.length === 0) {
    return { isGap, gapMs };
  }

  positiveDeltas.sort((a, b) => a - b);
  const mid = positiveDeltas.length >> 1;
  const medianPositiveDelta =
    (positiveDeltas.length & 1) === 1
      ? positiveDeltas[mid]
      : 0.5 * (positiveDeltas[mid - 1] + positiveDeltas[mid]);

  const safeExtent = Number.isFinite(extentMs) && extentMs > 0 ? extentMs : 0;
  const threshold = Math.max(safeExtent * 0.02, medianPositiveDelta * 3, 1);

  for (let s = 1; s < n; s++) {
    const dt = gapMs[s];
    if (dt > 0 && dt >= threshold) {
      isGap[s] = 1;
    }
  }

  return { isGap, gapMs };
}
