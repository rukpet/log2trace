/**
 * Kit geometry: Camera1D
 *
 * Pure math for a horizontal time axis. A camera is the visible window
 * `[t0, t1]` (ms) inside a trace that spans `[0, total]`, stretched over a plot
 * `widthPx` pixels wide. Every function takes a camera and returns a new one,
 * so zoom, pan and resize can run in a plain reducer and be unit-tested in
 * Node; nothing here touches the DOM or any browser global.
 *
 * A camera built by these functions, from whatever input (an empty trace, a
 * zero-length window, NaN, a 1e8-pixel plot), is finite and satisfies
 * `0 <= t0 < t1 <= max(total, MIN_WINDOW_MS)` with `t1 - t0 >= MIN_WINDOW_MS`
 * (up to floating-point rounding), so the pixel scale is always defined. The
 * functions that read a camera also cope with a hand-built degenerate one
 * (say a zero-length window) without returning NaN or Infinity.
 */

/** Narrowest window the camera will show, ms (one microsecond). */
export const MIN_WINDOW_MS = 0.001;

/** Zoom speed of a plain mouse wheel: `factor = exp(dy * k)`. */
export const WHEEL_ZOOM_K = 0.002;

/** Zoom speed of Ctrl+wheel; browsers report a trackpad pinch as Ctrl+wheel too. */
export const PINCH_ZOOM_K = 0.01;

/** Largest |dy| (px) one wheel event may contribute to a zoom, so a fast flick cannot jump the window. */
export const MAX_WHEEL_DELTA_PX = 240;

/** Pixels per line for wheel events reported in lines (Firefox, `deltaMode` 1). */
export const WHEEL_LINE_PX = 16;

/** Above this zoom level (in percent) the readout switches from `250%` to `12x`. */
export const ZOOM_PERCENT_LIMIT = 1000;

/**
 * Unit of `WheelEvent.deltaX` / `deltaY`. The values mirror the DOM's
 * `DOM_DELTA_*` constants, so `event.deltaMode` can be passed through as is.
 */
export enum WheelDeltaMode {
  /** `DOM_DELTA_PIXEL`: the delta is in pixels. */
  Pixel = 0,
  /** `DOM_DELTA_LINE`: the delta is in lines of text. */
  Line = 1,
  /** `DOM_DELTA_PAGE`: the delta is in pages. */
  Page = 2,
}

/**
 * The visible time window over a trace, plus the plot it is drawn on.
 *
 * Only `t0` and `t1` are view state worth persisting (e.g. across tab
 * switches); restore them with {@link withWindow} on a fresh camera.
 */
export interface Camera1D {
  /** Start of the visible window, ms from the start of the trace. */
  readonly t0: number;
  /** End of the visible window, ms. */
  readonly t1: number;
  /** Length of the whole trace, ms: the window never leaves `[0, total]`. */
  readonly total: number;
  /** Width of the plot the window is stretched over, px. */
  readonly widthPx: number;
}

/** The `WheelEvent` fields the zoom reads; a real event satisfies this as is. */
export interface WheelLike {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}

/** `x` when it is a finite number above zero; NaN, negatives and Infinity all become 0. */
function positiveOrZero(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Length of the range the window may move in: the trace, but never below the minimum window. */
function extentOf(total: number): number {
  return total > MIN_WINDOW_MS ? total : MIN_WINDOW_MS;
}

/** Window length with the minimum applied, safe to divide by. */
function spanOf(camera: Camera1D): number {
  const span = camera.t1 - camera.t0;
  return span >= MIN_WINDOW_MS ? span : MIN_WINDOW_MS;
}

/**
 * Build a camera showing `[t0, t1]`, repaired to satisfy the invariants:
 * reversed ends are swapped, non-finite ends fall back to the full range,
 * a window narrower than the minimum is widened around its centre, and one
 * that sticks out of `[0, extent]` is shifted back in with its length intact
 * (or replaced by the full range when it is longer than the range).
 */
function fit(t0: number, t1: number, total: number, widthPx: number): Camera1D {
  const limit = extentOf(total);
  if (t0 > t1) {
    const swap = t0;
    t0 = t1;
    t1 = swap;
  }

  let length = t1 - t0;
  if (!(length < Infinity)) return { t0: 0, t1: limit, total, widthPx }; // NaN or infinite

  if (length < MIN_WINDOW_MS) {
    const centre = t0 + length / 2;
    length = MIN_WINDOW_MS;
    t0 = centre - length / 2;
    t1 = centre + length / 2;
  }

  if (length >= limit) return { t0: 0, t1: limit, total, widthPx };
  if (t0 < 0) return { t0: 0, t1: length, total, widthPx };
  if (t1 > limit) return { t0: limit - length, t1: limit, total, widthPx };
  return { t0, t1, total, widthPx };
}

/**
 * A camera showing the whole trace.
 *
 * An empty trace (`total` of 0, or anything that is not a positive finite
 * number) gets the minimum window `[0, MIN_WINDOW_MS]`, so it still has a scale.
 *
 * @param total - Length of the trace in ms.
 * @param widthPx - Plot width in px; anything that is not a positive finite number becomes 0.
 */
export function createCamera(total: number, widthPx: number): Camera1D {
  const length = positiveOrZero(total);
  return { t0: 0, t1: extentOf(length), total: length, widthPx: positiveOrZero(widthPx) };
}

/**
 * The same camera showing a different window, repaired to fit `[0, total]`
 * (see the module notes). Use it to restore saved state, follow a shared time
 * window, or zoom to a span.
 *
 * @param camera - Camera to take the trace length and plot width from.
 * @param t0 - Wanted window start, ms.
 * @param t1 - Wanted window end, ms.
 */
export function withWindow(camera: Camera1D, t0: number, t1: number): Camera1D {
  return fit(t0, t1, camera.total, camera.widthPx);
}

/**
 * Resize the plot. The time window is kept exactly; only the scale changes.
 *
 * @param camera - Camera to resize.
 * @param widthPx - New plot width in px; anything that is not a positive finite number becomes 0.
 */
export function resizeCamera(camera: Camera1D, widthPx: number): Camera1D {
  return { t0: camera.t0, t1: camera.t1, total: camera.total, widthPx: positiveOrZero(widthPx) };
}

/**
 * Pixels per millisecond. Hoist this out of per-row loops: the pixel of a time
 * `t` is `(t - camera.t0) * pxPerMs(camera)`. Zero when the plot has no width.
 */
export function pxPerMs(camera: Camera1D): number {
  return camera.widthPx / spanOf(camera);
}

/**
 * Plot pixel (0 at the left edge) of a time in ms. Finite for finite input;
 * times outside the window map outside `[0, widthPx]`.
 */
export function timeToPx(camera: Camera1D, t: number): number {
  return ((t - camera.t0) * camera.widthPx) / spanOf(camera);
}

/**
 * Time in ms under a plot pixel; the inverse of {@link timeToPx}. A plot with
 * no width maps every pixel to the window start.
 */
export function pxToTime(camera: Camera1D, x: number): number {
  return camera.widthPx > 0 ? camera.t0 + (x * spanOf(camera)) / camera.widthPx : camera.t0;
}

/**
 * Zoom around a time, keeping that time at the same pixel:
 * `t0' = tc - (tc - t0) * f`, `t1' = tc + (t1 - tc) * f`.
 *
 * `factor` below 1 zooms in, above 1 zooms out. It is limited first, so the
 * new window is never shorter than {@link MIN_WINDOW_MS} nor longer than the
 * trace, and the anchor holds at those limits too. Only when the window then
 * runs into `[0, total]` is it shifted back in, which moves the anchor. A
 * `factor` that is NaN or not above zero, or a non-finite `tc`, leaves the
 * camera unchanged; an infinite `factor` zooms out to the whole trace.
 *
 * @param camera - Camera to zoom.
 * @param tc - Anchor time in ms, typically `pxToTime(camera, cursorX)`.
 * @param factor - Window length multiplier, typically from {@link zoomFactor}.
 */
export function zoomAt(camera: Camera1D, tc: number, factor: number): Camera1D {
  if (!(factor > 0) || !Number.isFinite(tc)) return camera;

  const span = spanOf(camera);
  const f = Math.min(Math.max(factor, MIN_WINDOW_MS / span), extentOf(camera.total) / span);
  if (f === 1) return camera;

  return fit(tc - (tc - camera.t0) * f, tc + (camera.t1 - tc) * f, camera.total, camera.widthPx);
}

/**
 * Move the window by a time offset, keeping its length. At the ends of the
 * trace it stops instead of shrinking. A zero or non-finite `dt` leaves the
 * camera unchanged.
 *
 * @param camera - Camera to pan.
 * @param dt - Offset in ms; positive shows later times.
 */
export function panByTime(camera: Camera1D, dt: number): Camera1D {
  if (dt === 0 || !Number.isFinite(dt)) return camera;
  return fit(camera.t0 + dt, camera.t1 + dt, camera.total, camera.widthPx);
}

/**
 * Pan by a drag in pixels: `dt = -dx / pxPerMs`. Dragging the content right
 * (positive `dx`) reveals earlier times. Does nothing when the plot has no width.
 *
 * @param camera - Camera to pan.
 * @param dx - Horizontal drag in px; positive moves the content right.
 */
export function panByPx(camera: Camera1D, dx: number): Camera1D {
  if (!(camera.widthPx > 0)) return camera;
  return panByTime(camera, (-dx * spanOf(camera)) / camera.widthPx);
}

/**
 * Convert one wheel delta to pixels: lines count {@link WHEEL_LINE_PX} each,
 * pages count `pageSizePx` (the viewport height). Unknown modes are taken as
 * pixels; a delta that would not be finite becomes 0.
 *
 * @param delta - `deltaX` or `deltaY` of the event.
 * @param mode - `deltaMode` of the event.
 * @param pageSizePx - Viewport height in px, the size of one page.
 */
export function normalizeWheelDelta(delta: number, mode: WheelDeltaMode, pageSizePx: number): number {
  let px = delta;
  if (mode === WheelDeltaMode.Line) px = delta * WHEEL_LINE_PX;
  else if (mode === WheelDeltaMode.Page) px = delta * pageSizePx;
  return Number.isFinite(px) ? px : 0;
}

/**
 * Window length multiplier for a wheel delta: `exp(dy * k)` with |dy| limited
 * to {@link MAX_WHEEL_DELTA_PX}. Positive `dy` (scrolling down) zooms out.
 *
 * @param dy - Wheel delta in px, already normalised by {@link normalizeWheelDelta}.
 * @param k - Zoom speed: {@link WHEEL_ZOOM_K} or {@link PINCH_ZOOM_K}.
 * @returns A positive finite factor; 1 when `dy` is not a number.
 */
export function zoomFactor(dy: number, k: number): number {
  const limited = Math.min(Math.max(dy, -MAX_WHEEL_DELTA_PX), MAX_WHEEL_DELTA_PX);
  const factor = Math.exp(limited * k);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * Window length multiplier for a wheel event: normalises `deltaY` by
 * `deltaMode`, then uses {@link PINCH_ZOOM_K} with Ctrl held (also how a
 * trackpad pinch arrives) and {@link WHEEL_ZOOM_K} otherwise.
 *
 * @param event - A `WheelEvent`, or any object with its `deltaY`, `deltaMode` and `ctrlKey`.
 * @param pageSizePx - Viewport height in px, the size of one page.
 */
export function wheelZoomFactor(event: WheelLike, pageSizePx: number): number {
  const dy = normalizeWheelDelta(event.deltaY, event.deltaMode, pageSizePx);
  return zoomFactor(dy, event.ctrlKey ? PINCH_ZOOM_K : WHEEL_ZOOM_K);
}

/**
 * How many times the window fits in the trace: `total / (t1 - t0)`, so 1 when
 * the whole trace is shown. An empty trace counts as the minimum window, so it
 * reads 1 too.
 */
export function zoomRatio(camera: Camera1D): number {
  return extentOf(camera.total) / spanOf(camera);
}

/**
 * Text for the zoom readout: a percentage up to {@link ZOOM_PERCENT_LIMIT}
 * (`100%`, `250%`, `1000%`), then a multiplier with an `x` suffix (`12.5x`,
 * `340x`, `1e7x`).
 *
 * @param ratio - Zoom level as returned by {@link zoomRatio}; anything not positive and finite reads as 1.
 */
export function formatZoom(ratio: number): string {
  const zoom = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const percent = zoom * 100;
  if (percent <= ZOOM_PERCENT_LIMIT) return `${Math.round(percent)}%`;
  return `${formatMultiplier(zoom)}x`;
}

/** A multiplier of at least 10 in a few characters: one decimal below 100, none up to 1e6, then `1.2e7`. */
function formatMultiplier(zoom: number): string {
  if (zoom >= 1e6) return zoom.toExponential(1).replace('.0e', 'e').replace('e+', 'e');
  if (zoom >= 100) return String(Math.round(zoom));
  return zoom.toFixed(1).replace('.0', '');
}
