/**
 * Bars: where a span's bar and its event markers fall on the plot.
 *
 * Both the frame plan (what to draw) and the hit test (what is under the
 * pointer) use these functions, so they always agree. Positions are in plot
 * pixels: 0 is the left edge of the time axis. Everything is computed in
 * 64-bit floats and clipped to just outside the plot before it is stored, so
 * a deep zoom (a bar thousands of times wider than the view) never produces
 * coordinates the painters or the browser cannot represent.
 *
 * Headless: no DOM, no browser globals.
 */

import { pxPerMs, type Camera1D } from '../../../kit/geometry/camera1d.ts';
import type { SpanTable } from '../../../core/span-table.ts';

/** Narrowest a bar is drawn, px, so that even a microsecond span stays visible. */
export const MIN_BAR_WIDTH = 2;
/** A bar narrower than this (on screen) shows no event markers, px. */
export const MIN_BAR_WIDTH_FOR_EVENTS = 6;
/** Closest two event markers on one bar are placed, px. */
export const MIN_EVENT_GAP = 2;
/** Most event markers drawn on one bar. */
export const MAX_EVENT_MARKERS = 64;
/** How far outside the plot a clipped bar edge is kept, px. */
export const CLIP_MARGIN = 1;

/** Where a bar lies on the plot; reuse one object to avoid allocating per row. */
export interface BarExtent {
  /** Left edge, plot px, clipped to `-CLIP_MARGIN … plotWidth + CLIP_MARGIN`. */
  x0: number;
  /** Right edge, plot px, clipped the same way. */
  x1: number;
  /** Whether any part of the bar is inside the plot. */
  visible: boolean;
  /** The bar starts left of the plot. */
  clippedLeft: boolean;
  /** The bar ends right of the plot. */
  clippedRight: boolean;
}

/** An empty extent to pass to {@link barExtent}. */
export function createBarExtent(): BarExtent {
  return { x0: 0, x1: 0, visible: false, clippedLeft: false, clippedRight: false };
}

function clip(x: number, width: number): number {
  return x < -CLIP_MARGIN ? -CLIP_MARGIN : x > width + CLIP_MARGIN ? width + CLIP_MARGIN : x;
}

/**
 * Work out where a span's bar is.
 *
 * A bar is at least {@link MIN_BAR_WIDTH} wide. A span that ends before it starts is drawn as a
 * minimum-width bar at its start.
 *
 * @param camera - The visible time window, sized to the plot.
 * @param startMs - Span start, ms after the start of the trace.
 * @param endMs - Span end, ms after the start of the trace.
 * @param out - Receives the result.
 * @returns `out`.
 */
export function barExtent(camera: Camera1D, startMs: number, endMs: number, out: BarExtent): BarExtent {
  const scale = pxPerMs(camera);
  const x0 = (startMs - camera.t0) * scale;
  let x1 = (endMs - camera.t0) * scale;
  if (!(x1 - x0 >= MIN_BAR_WIDTH)) x1 = x0 + MIN_BAR_WIDTH;

  const width = camera.widthPx;
  out.visible = x1 >= 0 && x0 <= width;
  out.clippedLeft = x0 < -CLIP_MARGIN;
  out.clippedRight = x1 > width + CLIP_MARGIN;
  out.x0 = clip(x0, width);
  out.x1 = clip(x1, width);
  return out;
}

/**
 * First index in `from … to - 1` whose value is not below `value`, in a range sorted ascending
 * (`to` when there is none).
 */
export function lowerBound(values: Float64Array, from: number, to: number, value: number): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Place the event markers of one span.
 *
 * Only events inside the span and inside the visible window get a marker, and none are
 * drawn on a bar narrower than {@link MIN_BAR_WIDTH_FOR_EVENTS}. Markers are at least
 * {@link MIN_EVENT_GAP} px apart (further apart on a long bar, so that a bar never gets
 * more than `capacity` markers); of events that fall within one gap, the earliest wins.
 *
 * @param table - The trace.
 * @param row - Table row of the span.
 * @param camera - The visible time window, sized to the plot.
 * @param extent - The span's bar, from {@link barExtent}.
 * @param out - Receives marker x positions (plot px), in order, starting at `offset`.
 * @param offset - Where in `out` to start writing.
 * @param capacity - Most markers to write; `out` needs room for `offset + capacity` entries.
 * @returns The number of markers written.
 */
export function eventMarkers(
  table: SpanTable,
  row: number,
  camera: Camera1D,
  extent: BarExtent,
  out: Float32Array,
  offset: number,
  capacity: number = MAX_EVENT_MARKERS,
): number {
  const first = table.evOff[row];
  const last = table.evOff[row + 1];
  const visibleWidth = extent.x1 - extent.x0;
  if (first === last || !extent.visible || visibleWidth < MIN_BAR_WIDTH_FOR_EVENTS) return 0;

  const from = Math.max(table.start[row], camera.t0);
  const to = Math.min(table.end[row], camera.t1);
  const scale = pxPerMs(camera);
  if (!(to >= from) || !(scale > 0)) return 0;

  const gapMs = Math.max(MIN_EVENT_GAP, visibleWidth / capacity) / scale;
  const evT = table.evT;
  let count = 0;
  for (let k = lowerBound(evT, first, last, from); k < last && count < capacity;) {
    const t = evT[k];
    if (t > to) break;
    out[offset + count++] = (t - camera.t0) * scale;
    k = lowerBound(evT, k + 1, last, t + gapMs);
  }
  return count;
}
