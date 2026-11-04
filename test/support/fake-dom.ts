/**
 * Fakes of the browser pieces the canvas surface depends on, driven by hand: a
 * canvas that counts how often its size is written, a `ResizeObserver` that
 * reports when the test says so, `matchMedia` queries the test can fire, and a
 * host element. The casts to DOM types live here, so the tests read plainly.
 */

import type {
  CanvasHost,
  SurfaceEnv,
  SurfaceMediaQuery,
  SurfaceResizeEntry,
  SurfaceResizeObserver,
} from '../../src/kit/canvas/surface.ts';

/** What listeners of a fake canvas receive. */
export interface FakeEvent {
  readonly type: string;
  readonly target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/** A canvas 2D context that remembers its transform. */
export class FakeContext {
  readonly canvas: FakeCanvas;
  readonly options: unknown;
  transform: readonly number[] | null = null;

  constructor(canvas: FakeCanvas, options: unknown) {
    this.canvas = canvas;
    this.options = options;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
  }
}

/** A canvas that counts writes to its size and keeps its event listeners. */
export class FakeCanvas {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly getContextCalls: Array<{ kind: string; options: unknown }> = [];
  widthWrites = 0;
  heightWrites = 0;
  removed = false;
  /** Make `getContext` fail the way a browser out of memory does. */
  refuseContext = false;

  #width = 300;
  #height = 150;
  #context: FakeContext | null = null;
  readonly #listeners = new Map<string, Set<(event: FakeEvent) => void>>();

  get width(): number {
    return this.#width;
  }

  set width(value: number) {
    this.widthWrites++;
    this.#width = value;
  }

  get height(): number {
    return this.#height;
  }

  set height(value: number) {
    this.heightWrites++;
    this.#height = value;
  }

  getContext(kind: string, options?: unknown): CanvasRenderingContext2D | null {
    this.getContextCalls.push({ kind, options });
    if (this.refuseContext) return null;
    this.#context ??= new FakeContext(this, options);
    return this.#context as unknown as CanvasRenderingContext2D;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  /** Fire an event at this canvas, as the browser does for `contextlost` and `contextrestored`. */
  dispatch(type: string): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
    return event;
  }

  remove(): void {
    this.removed = true;
  }
}

/** A `ResizeObserver` that reports only when told to. */
export class FakeResizeObserver implements SurfaceResizeObserver {
  readonly observed: Array<{ target: unknown; options: unknown }> = [];
  disconnected = false;
  readonly #callback: (entries: readonly SurfaceResizeEntry[]) => void;
  readonly #rejectDevicePixelBox: boolean;

  constructor(callback: (entries: readonly SurfaceResizeEntry[]) => void, rejectDevicePixelBox: boolean) {
    this.#callback = callback;
    this.#rejectDevicePixelBox = rejectDevicePixelBox;
  }

  observe(target: HTMLCanvasElement, options?: ResizeObserverOptions): void {
    if (this.#rejectDevicePixelBox && options?.box === 'device-pixel-content-box') {
      throw new TypeError("The provided value 'device-pixel-content-box' is not a valid enum value of type ResizeObserverBoxOptions.");
    }
    this.observed.push({ target, options });
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /**
   * Deliver one entry as the browser would.
   *
   * @param width - CSS width of the content box.
   * @param height - CSS height of the content box.
   * @param device - Device pixel size, for browsers that report it; omit it for those that do not.
   */
  notify(width: number, height: number, device?: { width: number; height: number }): void {
    this.#callback([
      {
        contentRect: { width, height },
        devicePixelContentBoxSize: device === undefined ? undefined : [{ inlineSize: device.width, blockSize: device.height }],
      },
    ]);
  }
}

/** A media query list whose `change` the test fires. */
export class FakeMediaQuery implements SurfaceMediaQuery {
  readonly query: string;
  readonly listeners = new Set<() => void>();

  constructor(query: string) {
    this.query = query;
  }

  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }

  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A fake host element: it keeps what was put into it, and starts with one child of its own. */
export interface FakeHost extends CanvasHost {
  readonly children: unknown[];
}

/** The environment of a surface and the handles a test needs to drive it. */
export interface FakeSurfaceEnv {
  readonly env: SurfaceEnv;
  readonly host: FakeHost;
  /** Canvases created so far: the scene first, then the overlay. */
  readonly canvases: FakeCanvas[];
  /** Observers created so far. */
  readonly observers: FakeResizeObserver[];
  /** Media queries created so far, oldest first. */
  readonly queries: FakeMediaQuery[];
  /** Change what `devicePixelRatio` returns; fire the newest query for the browser to notice. */
  setDpr(value: number): void;
}

/** Options for {@link createFakeSurfaceEnv}. */
export interface FakeSurfaceEnvOptions {
  /** Starting pixel ratio; default 2. */
  readonly dpr?: number;
  /** Make the observer reject `device-pixel-content-box`, as browsers without it do. */
  readonly rejectDevicePixelBox?: boolean;
  /** Make every canvas refuse to give a 2D context. */
  readonly refuseContext?: boolean;
}

/** Build the fake environment for one surface. */
export function createFakeSurfaceEnv(options: FakeSurfaceEnvOptions = {}): FakeSurfaceEnv {
  let dpr = options.dpr ?? 2;
  const canvases: FakeCanvas[] = [];
  const observers: FakeResizeObserver[] = [];
  const queries: FakeMediaQuery[] = [];

  const host: FakeHost = {
    children: ['existing child'],
    prepend(...nodes) {
      this.children.unshift(...nodes);
    },
  };

  const env: SurfaceEnv = {
    createCanvas() {
      const canvas = new FakeCanvas();
      canvas.refuseContext = options.refuseContext ?? false;
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
    createResizeObserver(callback) {
      const observer = new FakeResizeObserver(callback, options.rejectDevicePixelBox ?? false);
      observers.push(observer);
      return observer;
    },
    matchMedia(query) {
      const list = new FakeMediaQuery(query);
      queries.push(list);
      return list;
    },
    devicePixelRatio: () => dpr,
  };

  return {
    env,
    host,
    canvases,
    observers,
    queries,
    setDpr(value) {
      dpr = value;
    },
  };
}

/** The fake behind a context a surface exposes. */
export function fakeContext(ctx: CanvasRenderingContext2D): FakeContext {
  return ctx as unknown as FakeContext;
}
