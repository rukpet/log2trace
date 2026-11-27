/**
 * Bar extent: where a time interval falls on a plot as a bar.
 *
 * Shared by the views that draw spans as horizontal bars. Positions are in plot
 * pixels: 0 is the left edge of the time axis. Everything is computed in 64-bit
 * floats and clipped to just outside the plot before it is stored, so a deep zoom
 * (a bar thousands of times wider than the view) never produces coordinates the
 * painters or the browser cannot represent.
 *
 * Headless: no DOM, no browser globals.
 */

import { pxPerMs, type Camera1D } from './camera1d.ts';

/** Narrowest a bar is drawn, px, so that even a microsecond span stays visible. */
export const MIN_BAR_WIDTH = 2;
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
