/**
 * Layout: the fixed geometry of the waterfall.
 *
 * The view is a label column (the gutter) on the left, a time plot on the right,
 * a ruler band on top and a scrolling list of rows below. The ruler and the
 * gutter stay put while the rows scroll. Everything is in CSS pixels in view
 * coordinates (origin at the top-left corner of the surface).
 *
 * Headless: no DOM, no browser globals.
 */

import type { ListMetrics } from '../../../kit/geometry/virtual-list.ts';

/** Sizes that can be configured. Use {@link resolveMetrics} to fill in defaults and drop bad values. */
export interface WaterfallMetrics {
  /** Height of one row including the gap below the bar, px. */
  readonly rowHeight: number;
  /** Height of a span bar, px; the bar is centred in its row. */
  readonly barHeight: number;
  /** Height of the time ruler above the rows, px. */
  readonly headerHeight: number;
  /** Wanted width of the label column, px; it never takes more than half of the view. */
  readonly gutterWidth: number;
  /** Space kept free right of the plot so that the last tick label fits, px. */
  readonly plotPaddingRight: number;
  /** Largest indent per tree level in the gutter, px; deep traces get less. */
  readonly maxIndent: number;
}

/** The defaults, matching the old element: 30 px bars in 35 px rows, a 40 px ruler, a 250 px label column. */
export const DEFAULT_METRICS: WaterfallMetrics = Object.freeze({
  rowHeight: 35,
  barHeight: 30,
  headerHeight: 40,
  gutterWidth: 250,
  plotPaddingRight: 24,
  maxIndent: 20,
});

/** Left padding of the gutter, px. */
export const GUTTER_PADDING = 8;
/** Width and height of the box a chevron is drawn in and clicked on, px. */
export const CHEVRON_SIZE = 16;
/** Gap between the chevron box and the label text, px. */
export const LABEL_GAP = 4;
/** Smallest indent per tree level, however deep the trace is, px. */
export const MIN_INDENT = 2;
/** Gutter width that is not the indent or the label text: the padding on both sides, the chevron box and its gap, px. */
const INDENT_RESERVE = 2 * GUTTER_PADDING + CHEVRON_SIZE + LABEL_GAP;

/**
 * Build metrics from the old `span-height` / `span-padding` pair.
 *
 * @param spanHeight - Height of a bar, px.
 * @param spanPadding - Gap below each bar, px.
 */
export function metricsFromSpanSizes(spanHeight: number, spanPadding: number): Partial<WaterfallMetrics> {
  const bar = Number.isFinite(spanHeight) && spanHeight > 0 ? spanHeight : DEFAULT_METRICS.barHeight;
  const gap = Number.isFinite(spanPadding) && spanPadding >= 0 ? spanPadding : DEFAULT_METRICS.rowHeight - DEFAULT_METRICS.barHeight;
  return { barHeight: bar, rowHeight: bar + gap };
}

/** Fill in the defaults and replace anything that is not a usable size. */
export function resolveMetrics(overrides: Partial<WaterfallMetrics> = {}): WaterfallMetrics {
  const pick = (value: number | undefined, fallback: number, min: number): number =>
    value !== undefined && Number.isFinite(value) && value >= min ? value : fallback;

  const rowHeight = pick(overrides.rowHeight, DEFAULT_METRICS.rowHeight, 1);
  const barHeight = Math.min(pick(overrides.barHeight, DEFAULT_METRICS.barHeight, 1), rowHeight);
  return {
    rowHeight,
    barHeight,
    headerHeight: pick(overrides.headerHeight, DEFAULT_METRICS.headerHeight, 0),
    gutterWidth: pick(overrides.gutterWidth, DEFAULT_METRICS.gutterWidth, 0),
    plotPaddingRight: pick(overrides.plotPaddingRight, DEFAULT_METRICS.plotPaddingRight, 0),
    maxIndent: pick(overrides.maxIndent, DEFAULT_METRICS.maxIndent, MIN_INDENT),
  };
}

/** The geometry for one view size, from {@link computeLayout}. */
export interface WaterfallLayout {
  /** Width of the view, px. */
  readonly width: number;
  /** Height of the view, px. */
  readonly height: number;
  readonly rowHeight: number;
  readonly barHeight: number;
  /** Distance from the top of a row to the top of its bar, px. */
  readonly barInset: number;
  /** Height of the ruler; the rows start right below it. */
  readonly headerHeight: number;
  /** Height of the area the rows scroll in. */
  readonly bodyHeight: number;
  /** Width of the label column. */
  readonly gutterWidth: number;
  /** Where the plot starts; equals `gutterWidth`. */
  readonly plotLeft: number;
  /** Width of the time axis, px: the camera is sized to it. 0 when the view is too small. */
  readonly plotWidth: number;
  /** Indent per tree level in the gutter, px. */
  readonly indentStep: number;
}

/**
 * Compute the layout for a view size.
 *
 * The indent per level shrinks on deep traces so that the deepest label keeps
 * half of the gutter: `min(maxIndent, (gutterWidth / 2 - 36) / maxDepth)` (36 px being the
 * paddings and the chevron box), never below {@link MIN_INDENT}.
 *
 * @param metrics - Configured sizes.
 * @param width - Width of the view, px; anything not finite and positive counts as 0.
 * @param height - Height of the view, px.
 * @param maxDepth - Depth of the deepest span (0 for a trace of roots).
 */
export function computeLayout(metrics: WaterfallMetrics, width: number, height: number, maxDepth: number): WaterfallLayout {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  const gutterWidth = Math.min(metrics.gutterWidth, Math.floor(w / 2));
  const indentStep = maxDepth > 0
    ? Math.min(metrics.maxIndent, Math.max(MIN_INDENT, (gutterWidth / 2 - INDENT_RESERVE) / maxDepth))
    : metrics.maxIndent;

  return {
    width: w,
    height: h,
    rowHeight: metrics.rowHeight,
    barHeight: metrics.barHeight,
    barInset: (metrics.rowHeight - metrics.barHeight) / 2,
    headerHeight: metrics.headerHeight,
    bodyHeight: Math.max(0, h - metrics.headerHeight),
    gutterWidth,
    plotLeft: gutterWidth,
    plotWidth: Math.max(0, w - gutterWidth - metrics.plotPaddingRight),
    indentStep,
  };
}

/** The virtual-list geometry for `rowCount` rows in this layout. */
export function listMetrics(layout: WaterfallLayout, rowCount: number): ListMetrics {
  return { rowHeight: layout.rowHeight, rowCount, viewportHeight: layout.bodyHeight };
}

/** Top edge of a row in view coordinates, for the given scroll position. */
export function rowTop(layout: WaterfallLayout, row: number, scrollTop: number): number {
  return layout.headerHeight + row * layout.rowHeight - scrollTop;
}

/**
 * The row under a y coordinate, or -1 when the point is in the ruler or past the last row.
 *
 * @param layout - View geometry.
 * @param rowCount - Number of rows.
 * @param y - Coordinate in the view, px.
 * @param scrollTop - Scroll position of the rows, px.
 */
export function rowAt(layout: WaterfallLayout, rowCount: number, y: number, scrollTop: number): number {
  if (!(y >= layout.headerHeight) || !(y < layout.height)) return -1;
  const row = Math.floor((y - layout.headerHeight + scrollTop) / layout.rowHeight);
  return row >= 0 && row < rowCount ? row : -1;
}

/** Left edge of the chevron box of a span at tree depth `depth`, px. */
export function chevronX(layout: WaterfallLayout, depth: number): number {
  return GUTTER_PADDING + depth * layout.indentStep;
}

/** Left edge of the label text of a span at tree depth `depth`, px. */
export function labelX(layout: WaterfallLayout, depth: number): number {
  return chevronX(layout, depth) + CHEVRON_SIZE + LABEL_GAP;
}

/** Room for the label text of a span at tree depth `depth`, px (0 when the gutter is too narrow). */
export function labelWidth(layout: WaterfallLayout, depth: number): number {
  return Math.max(0, layout.gutterWidth - labelX(layout, depth) - GUTTER_PADDING);
}
