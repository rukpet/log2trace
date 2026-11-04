/**
 * Kit canvas: surface
 *
 * Two canvases stacked inside a host element: a scene canvas without alpha for
 * the bulk of the drawing, and a transparent overlay above it for what changes
 * often and cheaply (hover, selection). The surface keeps their backing stores
 * the right size, and decides when painting is possible, so a painter never
 * sees a half-ready canvas:
 *
 * - Size. A `ResizeObserver` watches the scene canvas, which is absolutely
 *   positioned and takes its CSS size from the host (so its own pixel size never
 *   feeds back into layout). Where the browser reports `devicePixelContentBoxSize`
 *   the backing store takes it as is, otherwise it is `round(css * dpr)`. It is
 *   capped at about 8 Mpx per layer, and `scaleX`/`scaleY` say how CSS px map
 *   to it.
 * - Writes. `canvas.width` and `canvas.height` are assigned only when they
 *   differ, because any assignment clears the canvas and resets its context.
 * - Pixel ratio. A `matchMedia('(resolution: Xdppx)')` listener notices the
 *   page moving to another display or zooming, and is renewed for the new ratio.
 * - Frames. The surface is a client of the frame scheduler. While the canvas
 *   has no size (a hidden tab or panel) or a context is lost, it paints nothing
 *   and keeps the dirty bits for later. When the size changes it paints at once,
 *   inside the observer callback, which runs just before the browser paints:
 *   resizing clears the canvas, and waiting for the next frame would show it blank.
 * - Context loss. `contextlost` is cancelled so the browser restores the
 *   context, and `contextrestored` marks everything dirty.
 *
 * The environment (creating canvases, the observer, `matchMedia`, the pixel
 * ratio) is injected and defaults to the page's own on first use; nothing runs
 * at import time, so the surface works against fakes under `node:test`.
 *
 * The host must be a containing block for absolutely positioned children
 * (`position: relative` or similar), and the surface adds its canvases before
 * the host's existing children, so later siblings (a scroller, a mirror of rows
 * for screen readers) stack above them. The canvases take no pointer events.
 */

import { Dirty, getFrameScheduler, type FrameScheduler } from '../scheduler.ts';

/** Largest backing store of one layer, in device pixels: 32 MB of RGBA. */
export const MAX_BACKING_PIXELS = 8_000_000;

/** Longest side of a backing store, in device pixels, below the limit browsers put on a canvas. */
export const MAX_BACKING_SIDE = 16_384;

/** Where the surface is, in CSS and device pixels. A new object whenever any of it changes. */
export interface SurfaceSize {
  /** Width of the canvas box in CSS px; may be fractional. 0 while the host has no size. */
  readonly cssWidth: number;
  /** Height of the canvas box in CSS px. */
  readonly cssHeight: number;
  /** Device pixels per CSS px as the page reports it (`devicePixelRatio`). */
  readonly dpr: number;
  /** Width of the backing store, device px: what `canvas.width` holds. 0 while the host has no size. */
  readonly pxWidth: number;
  /** Height of the backing store, device px. */
  readonly pxHeight: number;
  /**
   * Backing-store pixels per CSS px horizontally: `pxWidth / cssWidth`. Draw
   * with a transform of this scale (see {@link CanvasSurface.applyScale}), not
   * with `dpr`: they differ when the browser snaps the canvas to whole device
   * pixels or the 8 Mpx cap shrank the store, and the drawing would then miss
   * its edge. `dpr` while there is no size.
   */
  readonly scaleX: number;
  /** Backing-store pixels per CSS px vertically. */
  readonly scaleY: number;
}

/** The part of a `ResizeObserverEntry` the surface reads. */
export interface SurfaceResizeEntry {
  readonly contentRect: { readonly width: number; readonly height: number };
  /** Size in device pixels where the browser supports it; for a horizontal writing mode `inlineSize` is the width. */
  readonly devicePixelContentBoxSize?: ReadonlyArray<{ readonly inlineSize: number; readonly blockSize: number }>;
}

/** The part of a `ResizeObserver` the surface uses. */
export interface SurfaceResizeObserver {
  /** Start watching an element. Browsers without `devicePixelContentBoxSize` reject the `device-pixel-content-box` option with a `TypeError`. */
  observe(target: HTMLCanvasElement, options?: ResizeObserverOptions): void;
  /** Stop watching everything. */
  disconnect(): void;
}

/** The part of a `MediaQueryList` the surface uses. */
export interface SurfaceMediaQuery {
  /** Be called when the query starts or stops matching. */
  addEventListener(type: 'change', listener: () => void): void;
  /** Stop being called. */
  removeEventListener(type: 'change', listener: () => void): void;
}

/** The page features a surface depends on; every member can be replaced in a test. */
export interface SurfaceEnv {
  /** A new, detached canvas element. */
  createCanvas(): HTMLCanvasElement;
  /** A `ResizeObserver` calling `callback` with its entries. */
  createResizeObserver(callback: (entries: readonly SurfaceResizeEntry[]) => void): SurfaceResizeObserver;
  /** `window.matchMedia`. */
  matchMedia(query: string): SurfaceMediaQuery;
  /** `window.devicePixelRatio`. */
  devicePixelRatio(): number;
}

/** What the surface needs of its host element: a place to put the canvases. */
export interface CanvasHost {
  /** Insert nodes before the host's first child. */
  prepend(...nodes: HTMLCanvasElement[]): void;
}

/** Options for {@link createCanvasSurface}. */
export interface CanvasSurfaceOptions {
  /** The element the canvases go into; see the module notes for how it must be laid out. */
  readonly host: CanvasHost;
  /**
   * Draw a frame. Called at most once per frame, with the dirty bits marked
   * since the last call, and only while the surface can be drawn on: its size is
   * not zero and no context is lost. Everything marked meanwhile is delivered
   * with the first call after that. The bits {@link Dirty.Size} (after a resize
   * or a pixel-ratio change) and {@link Dirty.All} (after a context was restored)
   * mean the canvases are blank and the context's transform was reset.
   */
  readonly paint: (dirty: number, surface: CanvasSurface) => void;
  /** The frame loop to paint on; defaults to the page's shared one. */
  readonly scheduler?: FrameScheduler;
  /** Replacements for the page features the surface uses. */
  readonly env?: Partial<SurfaceEnv>;
}

/** A canvas pair that sizes itself and paints on the frame loop. Create one with {@link createCanvasSurface}. */
export interface CanvasSurface {
  /** Context of the scene canvas, created with `alpha: false`: opaque, so text can use subpixel antialiasing. The painter must fill it completely. */
  readonly scene: CanvasRenderingContext2D;
  /** Context of the overlay canvas, transparent, above the scene. */
  readonly overlay: CanvasRenderingContext2D;
  /** The current size; a different object after every change, so `size !== lastSize` detects one. */
  readonly size: SurfaceSize;
  /** Whether a paint can happen: the size is not zero and neither context is lost. */
  readonly ready: boolean;
  /**
   * Say what changed. The next frame calls `paint` with these bits and any
   * others marked before it. Does nothing after `dispose`.
   *
   * @param bits - OR of {@link Dirty} bits, or bits of the painter's own.
   */
  mark(bits: number): void;
  /**
   * Be called when the size, the pixel ratio or the backing store changes,
   * also when the host loses its size, and before the paint that follows: the
   * place to tell the view its new width and height.
   *
   * @param listener - Receives the new size. An exception it throws does not stop the others or the paint; the first one is rethrown afterwards.
   * @returns A function that stops the notifications.
   */
  onResize(listener: (size: SurfaceSize) => void): () => void;
  /**
   * Set a context's transform to the scale that maps CSS px to the backing
   * store. Call it at the start of a paint: resizing resets the transform.
   *
   * @param ctx - The scene or overlay context.
   */
  applyScale(ctx: CanvasRenderingContext2D): void;
  /** Stop observing, remove the canvases and leave the frame loop. */
  dispose(): void;
}

/**
 * The backing store for a wanted size in device pixels: as wanted unless it has
 * more than {@link MAX_BACKING_PIXELS} pixels (then both sides shrink in
 * proportion, rounded down) or a side longer than {@link MAX_BACKING_SIDE}. A
 * size with a side below one pixel, infinite or not a number is no size: 0 by 0.
 *
 * @param width - Wanted width, device px.
 * @param height - Wanted height, device px.
 */
export function fitBackingStore(width: number, height: number): { readonly width: number; readonly height: number } {
  if (!(width >= 1 && width < Infinity) || !(height >= 1 && height < Infinity)) return { width: 0, height: 0 };
  let w = Math.floor(width);
  let h = Math.floor(height);

  const area = w * h;
  if (area > MAX_BACKING_PIXELS) {
    const shrink = Math.sqrt(MAX_BACKING_PIXELS / area);
    w = Math.floor(w * shrink);
    h = Math.floor(h * shrink);
  }
  return { width: Math.max(1, Math.min(w, MAX_BACKING_SIDE)), height: Math.max(1, Math.min(h, MAX_BACKING_SIDE)) };
}

/** A pixel ratio the page reported, or 1 when it was not a positive finite number. */
function usableRatio(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** A CSS length from the observer: 0 unless it is a positive finite number. */
function usableLength(length: number): number {
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function computeSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  device: { readonly width: number; readonly height: number } | undefined,
): SurfaceSize {
  const store = fitBackingStore(device?.width ?? Math.round(cssWidth * dpr), device?.height ?? Math.round(cssHeight * dpr));
  const usable = cssWidth > 0 && cssHeight > 0 && store.width > 0;
  const pxWidth = usable ? store.width : 0;
  const pxHeight = usable ? store.height : 0;
  return {
    cssWidth,
    cssHeight,
    dpr,
    pxWidth,
    pxHeight,
    scaleX: pxWidth > 0 ? pxWidth / cssWidth : dpr,
    scaleY: pxHeight > 0 ? pxHeight / cssHeight : dpr,
  };
}

function sameSize(a: SurfaceSize, b: SurfaceSize): boolean {
  return (
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight &&
    a.dpr === b.dpr &&
    a.pxWidth === b.pxWidth &&
    a.pxHeight === b.pxHeight
  );
}

function defaultCreateCanvas(): HTMLCanvasElement {
  if (typeof globalThis.document === 'undefined') {
    throw new Error('There is no document to create canvases in: pass env.createCanvas to createCanvasSurface');
  }
  return globalThis.document.createElement('canvas');
}

function defaultCreateResizeObserver(callback: (entries: readonly SurfaceResizeEntry[]) => void): SurfaceResizeObserver {
  return new globalThis.ResizeObserver(callback);
}

function defaultMatchMedia(query: string): SurfaceMediaQuery {
  return globalThis.matchMedia(query);
}

function defaultDevicePixelRatio(): number {
  return globalThis.devicePixelRatio;
}

/**
 * Create the canvas pair inside a host and start watching its size. Nothing is
 * painted until the host has a size, which the browser reports shortly after.
 *
 * @param options - The host, the paint callback and optional overrides.
 * @throws If the browser does not give 2D contexts; nothing is added to the host then.
 */
export function createCanvasSurface(options: CanvasSurfaceOptions): CanvasSurface {
  const env: SurfaceEnv = {
    createCanvas: options.env?.createCanvas ?? defaultCreateCanvas,
    createResizeObserver: options.env?.createResizeObserver ?? defaultCreateResizeObserver,
    matchMedia: options.env?.matchMedia ?? defaultMatchMedia,
    devicePixelRatio: options.env?.devicePixelRatio ?? defaultDevicePixelRatio,
  };
  const scheduler = options.scheduler ?? getFrameScheduler();

  const sceneCanvas = env.createCanvas();
  const overlayCanvas = env.createCanvas();
  for (const canvas of [sceneCanvas, overlayCanvas]) {
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
  }

  const scene = sceneCanvas.getContext('2d', { alpha: false });
  const overlay = overlayCanvas.getContext('2d');
  if (scene === null || overlay === null) throw new Error('The browser did not provide a 2D canvas context');

  let cssWidth = 0;
  let cssHeight = 0;
  let device: { readonly width: number; readonly height: number } | undefined;
  let dpr = usableRatio(env.devicePixelRatio());
  let size = computeSize(0, 0, dpr, undefined);
  let sceneLost = false;
  let overlayLost = false;
  let disposed = false;
  const resizeListeners = new Set<(size: SurfaceSize) => void>();

  const isReady = (): boolean => size.pxWidth > 0 && size.pxHeight > 0 && !sceneLost && !overlayLost;

  const handle = scheduler.register({
    paint(dirty) {
      if (!isReady()) return dirty;
      options.paint(dirty, surface);
    },
  });

  /** Give both canvases the backing-store size, writing only what differs: any write clears the canvas. */
  function resizeCanvases(): void {
    for (const canvas of [sceneCanvas, overlayCanvas]) {
      if (canvas.width !== size.pxWidth) canvas.width = size.pxWidth;
      if (canvas.height !== size.pxHeight) canvas.height = size.pxHeight;
    }
  }

  /** Work out the size from what the observer and the page last said, and react when it changed. */
  function update(): void {
    const next = computeSize(cssWidth, cssHeight, dpr, device);
    if (disposed || sameSize(next, size)) return;
    size = next;
    if (next.pxWidth > 0) resizeCanvases();

    let failure: { error: unknown } | null = null;
    for (const listener of [...resizeListeners]) {
      try {
        listener(size);
      } catch (error) {
        failure ??= { error };
      }
    }

    if (!disposed && isReady()) {
      handle.mark(Dirty.Size);
      handle.paintNow();
    }
    if (failure !== null) throw failure.error;
  }

  function onObserved(entries: readonly SurfaceResizeEntry[]): void {
    const entry = entries[entries.length - 1];
    if (entry === undefined) return;
    cssWidth = usableLength(entry.contentRect.width);
    cssHeight = usableLength(entry.contentRect.height);
    const box = entry.devicePixelContentBoxSize?.[0];
    device = box === undefined ? undefined : { width: box.inlineSize, height: box.blockSize };
    update();
  }

  const observer = env.createResizeObserver(onObserved);
  try {
    observer.observe(sceneCanvas, { box: 'device-pixel-content-box' });
  } catch {
    // Browsers without devicePixelContentBoxSize reject the option itself.
    observer.observe(sceneCanvas, { box: 'content-box' });
  }

  let ratioQuery: SurfaceMediaQuery | undefined;

  function watchRatio(): void {
    ratioQuery?.removeEventListener('change', onRatioChange);
    ratioQuery = env.matchMedia(`(resolution: ${dpr}dppx)`);
    ratioQuery.addEventListener('change', onRatioChange);
  }

  function onRatioChange(): void {
    if (disposed) return;
    dpr = usableRatio(env.devicePixelRatio());
    device = undefined; // measured at the old ratio; the observer reports the new one when it can
    watchRatio();
    update();
  }

  watchRatio();

  /** Follow one canvas's context: cancel its loss so it is restored, and mark everything dirty when it is. */
  function watchContext(canvas: HTMLCanvasElement, setLost: (lost: boolean) => void): () => void {
    const onLost = (event: Event): void => {
      event.preventDefault();
      setLost(true);
    };
    const onRestored = (): void => {
      setLost(false);
      handle.mark(Dirty.All);
    };
    canvas.addEventListener('contextlost', onLost);
    canvas.addEventListener('contextrestored', onRestored);
    return () => {
      canvas.removeEventListener('contextlost', onLost);
      canvas.removeEventListener('contextrestored', onRestored);
    };
  }

  const unwatchScene = watchContext(sceneCanvas, (lost) => {
    sceneLost = lost;
  });
  const unwatchOverlay = watchContext(overlayCanvas, (lost) => {
    overlayLost = lost;
  });

  const surface: CanvasSurface = {
    scene,
    overlay,

    get size() {
      return size;
    },

    get ready() {
      return isReady();
    },

    mark(bits) {
      handle.mark(bits);
    },

    onResize(listener) {
      resizeListeners.add(listener);
      return () => {
        resizeListeners.delete(listener);
      };
    },

    applyScale(ctx) {
      ctx.setTransform(size.scaleX, 0, 0, size.scaleY, 0, 0);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      ratioQuery?.removeEventListener('change', onRatioChange);
      unwatchScene();
      unwatchOverlay();
      resizeListeners.clear();
      handle.dispose();
      sceneCanvas.remove();
      overlayCanvas.remove();
    },
  };

  // Last, so that a failure above leaves the host untouched. The observer reports once the canvases are attached and have a size.
  options.host.prepend(sceneCanvas, overlayCanvas);
  return surface;
}
