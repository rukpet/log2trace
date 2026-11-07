/**
 * Kit geometry: Camera2D
 *
 * Pure math for a two-dimensional pannable, zoomable viewport (used by the service graph view).
 * A camera represents a 2D transform `translate(x, y) scale(scale)` mapping world coordinates
 * to viewport coordinates:
 *
 *   screenX = x + worldX * scale
 *   screenY = y + worldY * scale
 *
 * Every function takes a camera and returns a new immutable camera, so zoom, pan, fit-to-screen,
 * and resize can be unit-tested in Node without any DOM dependencies.
 */

/** Minimum zoom scale (10%). */
export const MIN_CAMERA2D_SCALE = 0.1;

/** Maximum zoom scale (500%). */
export const MAX_CAMERA2D_SCALE = 5.0;

/** Default padding (px) when fitting bounds inside the viewport. */
export const DEFAULT_FIT_PADDING = 32;

/** A rectangle in 2D space. */
export interface Rect2D {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The 2D camera state. */
export interface Camera2D {
  /** Translation X in viewport px (world origin X in viewport space). */
  readonly x: number;
  /** Translation Y in viewport px (world origin Y in viewport space). */
  readonly y: number;
  /** Uniform scale factor (1.0 = 100%). */
  readonly scale: number;
  /** Viewport width in px. */
  readonly viewportWidth: number;
  /** Viewport height in px. */
  readonly viewportHeight: number;
}

function positiveOrZero(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampScale(scale: number, minScale: number, maxScale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1.0;
  return Math.max(minScale, Math.min(scale, maxScale));
}

/** Create a default camera with scale 1.0 centered at (0, 0). */
export function createCamera2D(viewportWidth: number, viewportHeight: number): Camera2D {
  return {
    x: 0,
    y: 0,
    scale: 1.0,
    viewportWidth: positiveOrZero(viewportWidth),
    viewportHeight: positiveOrZero(viewportHeight),
  };
}

/** Update viewport dimensions without altering the world focal center. */
export function resizeCamera2D(camera: Camera2D, viewportWidth: number, viewportHeight: number): Camera2D {
  const w = positiveOrZero(viewportWidth);
  const h = positiveOrZero(viewportHeight);
  return {
    x: camera.x,
    y: camera.y,
    scale: camera.scale,
    viewportWidth: w,
    viewportHeight: h,
  };
}

/** Pan the camera by a delta (dx, dy) in viewport pixels. */
export function panCamera2D(camera: Camera2D, dx: number, dy: number): Camera2D {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return camera;
  return {
    x: camera.x + dx,
    y: camera.y + dy,
    scale: camera.scale,
    viewportWidth: camera.viewportWidth,
    viewportHeight: camera.viewportHeight,
  };
}

/**
 * Zoom around a viewport anchor point `(cursorX, cursorY)`, keeping the world point
 * under the cursor stationary.
 *
 * @param camera - The camera to zoom.
 * @param cursorX - Viewport X coordinate of the zoom anchor.
 * @param cursorY - Viewport Y coordinate of the zoom anchor.
 * @param factor - Scale multiplier: values > 1 zoom in, values < 1 zoom out.
 * @param minScale - Minimum scale bound (defaults to {@link MIN_CAMERA2D_SCALE}).
 * @param maxScale - Maximum scale bound (defaults to {@link MAX_CAMERA2D_SCALE}).
 */
export function zoomCamera2DAt(
  camera: Camera2D,
  cursorX: number,
  cursorY: number,
  factor: number,
  minScale = MIN_CAMERA2D_SCALE,
  maxScale = MAX_CAMERA2D_SCALE,
): Camera2D {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1 || !Number.isFinite(cursorX) || !Number.isFinite(cursorY)) {
    return camera;
  }

  const nextScale = clampScale(camera.scale * factor, minScale, maxScale);
  if (nextScale === camera.scale) return camera;

  // World point under cursor: wx = (cursorX - x) / scale
  // We want: cursorX = nextX + wx * nextScale
  // => nextX = cursorX - (cursorX - x) * (nextScale / scale)
  const ratio = nextScale / camera.scale;
  const nextX = cursorX - (cursorX - camera.x) * ratio;
  const nextY = cursorY - (cursorY - camera.y) * ratio;

  return {
    x: nextX,
    y: nextY,
    scale: nextScale,
    viewportWidth: camera.viewportWidth,
    viewportHeight: camera.viewportHeight,
  };
}

/**
 * Fit a bounding rectangle into the viewport with padding, centered.
 *
 * @param bounds - World coordinates rectangle to fit.
 * @param viewportWidth - Width of the viewport in px.
 * @param viewportHeight - Height of the viewport in px.
 * @param padding - Padding around the bounds in px.
 * @param maxInitialScale - Maximum scale to allow when fitting (default 1.0, prevents small graphs from ballooning).
 */
export function fitBounds2D(
  bounds: Rect2D,
  viewportWidth: number,
  viewportHeight: number,
  padding = DEFAULT_FIT_PADDING,
  maxInitialScale = 1.0,
): Camera2D {
  const vw = positiveOrZero(viewportWidth);
  const vh = positiveOrZero(viewportHeight);
  if (vw === 0 || vh === 0 || bounds.width <= 0 || bounds.height <= 0) {
    return createCamera2D(vw, vh);
  }

  const availW = Math.max(1, vw - padding * 2);
  const availH = Math.max(1, vh - padding * 2);
  const scaleFit = Math.min(availW / bounds.width, availH / bounds.height);
  const scale = clampScale(Math.min(scaleFit, maxInitialScale), MIN_CAMERA2D_SCALE, MAX_CAMERA2D_SCALE);

  const cxWorld = bounds.x + bounds.width / 2;
  const cyWorld = bounds.y + bounds.height / 2;
  const x = vw / 2 - cxWorld * scale;
  const y = vh / 2 - cyWorld * scale;

  return {
    x,
    y,
    scale,
    viewportWidth: vw,
    viewportHeight: vh,
  };
}

/** Transform a point from world coordinates to viewport (screen) coordinates. */
export function worldToScreen(camera: Camera2D, wx: number, wy: number): { readonly x: number; readonly y: number } {
  return {
    x: camera.x + wx * camera.scale,
    y: camera.y + wy * camera.scale,
  };
}

/** Transform a point from viewport (screen) coordinates to world coordinates. */
export function screenToWorld(camera: Camera2D, sx: number, sy: number): { readonly x: number; readonly y: number } {
  return {
    x: (sx - camera.x) / camera.scale,
    y: (sy - camera.y) / camera.scale,
  };
}

/** Format a zoom ratio as a readable percentage string (e.g. "100%", "65%"). */
export function formatZoom2D(scale: number): string {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1.0;
  return `${Math.round(s * 100)}%`;
}
