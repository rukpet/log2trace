/**
 * Kit: frame scheduler
 *
 * One `requestAnimationFrame` per page, shared by every view. A client
 * registers once, marks dirty bits whenever something it draws changes, and
 * receives `paint(dirty)` at most once per frame with everything marked since
 * its last paint. Nothing marked, nothing requested: an idle page runs no
 * frames at all.
 *
 * Each frame has two phases. First the callbacks queued with `schedule` run
 * (the trace store's notifications: listeners react to changes by marking
 * their client dirty), then every dirty client paints, in registration order.
 * Work queued while a frame runs is picked up by the same frame when it can
 * be (a listener marking a client that has not painted yet) and by the next
 * one otherwise.
 *
 * The scheduler measures what its frames cost (flush and paint, not the time
 * between frames) into a small ring buffer, so the cost of a frame is known
 * without `performance.measure` marks. Browsers pause `requestAnimationFrame`
 * in hidden tabs; flushes wait with the frames, so code that must deliver
 * notifications while the page is hidden calls `store.flushSync()`.
 *
 * Nothing here touches a browser global at import time: the environment is
 * injected (`requestFrame`, `cancelFrame`, `now`) and defaults to the page's
 * own on first use, so the whole module runs under `node:test`.
 */

import type { FlushScheduler } from '../core.ts';

/**
 * Dirty bits shared by the canvas painters. A client marks the bits for what
 * changed and `paint` repaints only the layers they name; a painter that needs
 * more bits defines them above {@link Dirty.Hover} (`1 << 7` and up). The
 * scheduler itself only ORs numbers together and never looks at the meaning.
 */
export enum Dirty {
  /** The canvases were resized or restored, or the page's pixel ratio changed: everything drawn is gone or in the wrong place. */
  Size = 1 << 0,
  /** Theme tokens or fonts changed: colours and text widths are stale. */
  Theme = 1 << 1,
  /** The data, or which rows or items are shown (collapse, filter), changed. */
  Rows = 1 << 2,
  /** The scroll position changed. */
  Scroll = 1 << 3,
  /** The camera (time window, zoom, pan) changed. */
  Camera = 1 << 4,
  /** The selection changed. */
  Selection = 1 << 5,
  /** The hover target changed. */
  Hover = 1 << 6,
  /** Every bit, including those a painter defines for itself. */
  All = 0x7fffffff,
}

/** Frame durations kept by default: two seconds at 60 fps. */
export const DEFAULT_STATS_WINDOW = 120;

/** Weight of the newest frame in {@link FrameStats.ema}. */
export const FRAME_EMA_ALPHA = 0.2;

/** Rounds of `schedule` callbacks one frame runs before it hands the rest to the next frame. */
const MAX_FLUSH_ROUNDS = 8;

/** Something that paints on frames. */
export interface FrameClient {
  /**
   * Paint what the dirty bits name. Called at most once per frame, and only
   * when bits were marked since the last call.
   *
   * Return the bits that could not be painted (no size yet, the view is
   * hidden): they are kept and handed to the next `paint`, together with
   * whatever is marked by then. Keeping bits does not request a frame, so a
   * client that cannot paint costs nothing until something marks it again.
   * Return nothing when everything was painted. Marking during `paint` asks for
   * the next frame, as anywhere else.
   *
   * @param dirty - OR of the bits marked since the last `paint`.
   * @returns The bits to keep, or nothing.
   */
  paint(dirty: number): number | void;
}

/** What {@link FrameScheduler.register} hands back: the client's end of the scheduler. */
export interface FrameHandle {
  /**
   * Add bits to what the client receives in its next `paint` and make sure a
   * frame runs. Marking no bits does nothing; marking after `dispose` too.
   *
   * @param bits - OR of the bits that changed.
   */
  mark(bits: number): void;
  /** Bits waiting for the next `paint`: marked and not painted yet, or kept by a `paint` that returned them. */
  readonly dirty: number;
  /**
   * Paint now, with the pending bits, instead of waiting for the frame: for a
   * caller that must not show an unpainted frame, such as a `ResizeObserver`
   * callback after clearing the canvas by resizing it. The frame that was
   * requested for those bits is cancelled when nothing else needs it. Does
   * nothing when no bits are pending; when called from inside the client's own
   * `paint`, the bits wait for the next frame instead.
   */
  paintNow(): void;
  /**
   * Remove the client. Pending bits are dropped, and a frame that only this
   * client needed is cancelled. Safe to call from inside a `paint`.
   */
  dispose(): void;
}

/** How long frames took, from the scheduler's ring buffer; all times in ms. */
export interface FrameStats {
  /** Frames that did any work since the scheduler was created. */
  readonly frames: number;
  /** The cost of the most recent frames, oldest first; at most the ring size. */
  readonly recent: readonly number[];
  /** The newest frame; 0 before the first. */
  readonly last: number;
  /** Mean of `recent`; 0 when empty. */
  readonly mean: number;
  /** 95th percentile of `recent` (nearest rank); 0 when empty. */
  readonly p95: number;
  /** Slowest of `recent`; 0 when empty. */
  readonly max: number;
  /** Exponential moving average over every frame so far ({@link FRAME_EMA_ALPHA}); the signal for dropping detail under load. 0 before the first frame. */
  readonly ema: number;
}

/** A shared frame loop. */
export interface FrameScheduler {
  /** Add a client. It receives no `paint` until it marks bits. */
  register(client: FrameClient): FrameHandle;
  /**
   * Run a callback at the start of the next frame, before any client paints.
   * It has the shape of the store's `schedule` option and does not use `this`,
   * so it can be passed as it is: `createTraceStore({ schedule: scheduler.schedule })`.
   * Callbacks run in the order they were queued, once each.
   */
  readonly schedule: FlushScheduler;
  /** The cost of the recent frames. Allocates; call it from a readout, not from a frame. */
  stats(): FrameStats;
}

/** Everything a scheduler needs from its environment, and its one tuning knob. */
export interface FrameSchedulerOptions {
  /** Calls `callback` before the next paint and returns a handle for `cancelFrame`. Defaults to `requestAnimationFrame`. */
  readonly requestFrame?: (callback: (time: number) => void) => number;
  /** Withdraws a request made with `requestFrame`. Defaults to `cancelAnimationFrame`. */
  readonly cancelFrame?: (handle: number) => void;
  /** Milliseconds from a monotonic clock; only differences are used. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** How many frame durations to keep; defaults to {@link DEFAULT_STATS_WINDOW}. */
  readonly statsWindow?: number;
}

/** Where a frame is, so work queued during it is not requested twice. */
enum Phase {
  Idle,
  Flushing,
  Painting,
}

/** The scheduler's record of one client. */
interface Entry {
  readonly client: FrameClient;
  dirty: number;
  /** Marked since the last paint: the next frame must call `paint`. Bits kept by a skipped paint do not set it. */
  awake: boolean;
  painting: boolean;
  disposed: boolean;
}

function defaultRequestFrame(callback: (time: number) => void): number {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    throw new Error('requestAnimationFrame is not available here: pass requestFrame and cancelFrame to createFrameScheduler');
  }
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: number): void {
  globalThis.cancelAnimationFrame(handle);
}

function defaultNow(): number {
  return globalThis.performance.now();
}

/**
 * Create a frame loop. A page needs only one, which {@link getFrameScheduler}
 * hands out; create your own for a test with a fake clock.
 *
 * @param options - The environment to run in and the size of the stats ring.
 */
export function createFrameScheduler(options: FrameSchedulerOptions = {}): FrameScheduler {
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  const now = options.now ?? defaultNow;
  const wanted = options.statsWindow;
  const ring = new Float64Array(wanted !== undefined && Number.isFinite(wanted) && wanted >= 1 ? Math.floor(wanted) : DEFAULT_STATS_WINDOW);

  const entries: Entry[] = [];
  let queued: Array<() => void> = [];
  let spare: Array<() => void> = [];
  let phase = Phase.Idle;
  let requested = false;
  let requestHandle = 0;
  let removed = 0;

  let frames = 0;
  let head = 0;
  let filled = 0;
  let ema = 0;

  /** Whether anything is waiting for a frame. */
  function needsFrame(): boolean {
    if (queued.length > 0) return true;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].awake && !entries[i].disposed) return true;
    }
    return false;
  }

  /** Ask for a frame unless one is requested or the running frame will pick the work up. */
  function request(): void {
    if (requested || phase !== Phase.Idle) return;
    requested = true;
    try {
      requestHandle = requestFrame(onFrame);
    } catch (error) {
      requested = false;
      throw error;
    }
  }

  /** Cancel the requested frame when nothing is left for it to do. */
  function cancelIfIdle(): void {
    if (!requested || phase !== Phase.Idle || needsFrame()) return;
    cancelFrame(requestHandle);
    requested = false;
    requestHandle = 0;
  }

  function record(duration: number): void {
    ring[head] = duration;
    head = (head + 1) % ring.length;
    if (filled < ring.length) filled++;
    ema = frames === 0 ? duration : ema + FRAME_EMA_ALPHA * (duration - ema);
    frames++;
  }

  /** Hand the pending bits to the client's `paint` and keep what it returns. */
  function paintEntry(entry: Entry): void {
    entry.awake = false;
    const bits = entry.dirty;
    if (bits === 0) return;
    entry.dirty = 0;
    entry.painting = true;
    try {
      const kept = entry.client.paint(bits);
      if (typeof kept === 'number') entry.dirty |= kept;
    } finally {
      entry.painting = false;
    }
  }

  function compact(): void {
    let write = 0;
    for (let read = 0; read < entries.length; read++) {
      if (!entries[read].disposed) entries[write++] = entries[read];
    }
    entries.length = write;
    removed = 0;
  }

  function onFrame(): void {
    requested = false;
    requestHandle = 0;
    const start = now();
    let worked = false;
    let failure: { error: unknown } | null = null;

    try {
      phase = Phase.Flushing;
      for (let round = 0; queued.length > 0 && round < MAX_FLUSH_ROUNDS; round++) {
        const batch = queued;
        queued = spare;
        worked = true;
        for (let i = 0; i < batch.length; i++) {
          try {
            batch[i]();
          } catch (error) {
            failure ??= { error };
          }
        }
        batch.length = 0;
        spare = batch;
      }

      phase = Phase.Painting;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.disposed || !entry.awake) continue;
        worked = true;
        try {
          paintEntry(entry);
        } catch (error) {
          failure ??= { error };
        }
      }
    } finally {
      phase = Phase.Idle;
      if (removed > 0) compact();
    }

    if (worked) record(now() - start);
    if (needsFrame()) request();
    if (failure !== null) throw failure.error;
  }

  function register(client: FrameClient): FrameHandle {
    const entry: Entry = { client, dirty: 0, awake: false, painting: false, disposed: false };
    entries.push(entry);

    return {
      mark(bits) {
        const added = bits | 0;
        if (entry.disposed || added === 0) return;
        entry.dirty |= added;
        entry.awake = true;
        request();
      },

      get dirty() {
        return entry.dirty;
      },

      paintNow() {
        if (entry.disposed || entry.dirty === 0) return;
        if (entry.painting) {
          entry.awake = true;
          request();
          return;
        }
        try {
          paintEntry(entry);
        } finally {
          cancelIfIdle();
        }
      },

      dispose() {
        if (entry.disposed) return;
        entry.disposed = true;
        entry.dirty = 0;
        entry.awake = false;
        if (phase === Phase.Idle) {
          entries.splice(entries.indexOf(entry), 1);
        } else {
          removed++;
        }
        cancelIfIdle();
      },
    };
  }

  function stats(): FrameStats {
    const recent: number[] = [];
    const oldest = filled < ring.length ? 0 : head;
    let sum = 0;
    for (let i = 0; i < filled; i++) {
      const duration = ring[(oldest + i) % ring.length];
      recent.push(duration);
      sum += duration;
    }

    const sorted = recent.slice().sort((a, b) => a - b);
    return {
      frames,
      recent,
      last: filled > 0 ? recent[filled - 1] : 0,
      mean: filled > 0 ? sum / filled : 0,
      p95: filled > 0 ? sorted[Math.min(filled - 1, Math.ceil(0.95 * filled) - 1)] : 0,
      max: filled > 0 ? sorted[filled - 1] : 0,
      ema,
    };
  }

  return {
    register,
    schedule(flush) {
      queued.push(flush);
      request();
    },
    stats,
  };
}

let shared: FrameScheduler | undefined;

/**
 * The page's frame loop, created on first use: every view and surface that
 * does not bring its own shares this one, which is what keeps it to a single
 * `requestAnimationFrame` per page. Creating it touches no browser API; the
 * first frame request does.
 */
export function getFrameScheduler(): FrameScheduler {
  shared ??= createFrameScheduler();
  return shared;
}
