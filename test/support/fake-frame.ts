/**
 * A fake animation-frame clock for the kit tests: nothing runs until the test
 * calls `frame()`, and time moves only when the test says so (`advance`, or the
 * 16 ms a frame takes to arrive).
 */

/** The environment a frame scheduler takes, plus the controls a test needs. */
export interface FakeClock {
  readonly requestFrame: (callback: (time: number) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly now: () => number;
  /** Move time forward, for instance to make a paint "cost" something. */
  advance(ms: number): void;
  /**
   * Run the callbacks requested so far as one animation frame: time moves on
   * by 16 ms first, and callbacks requested while it runs wait for the next
   * call. The first error a callback throws is rethrown after all have run.
   *
   * @returns How many callbacks ran.
   */
  frame(): number;
  /** Frames requested and neither run nor cancelled. */
  readonly pending: number;
  /** Calls to `requestFrame` so far. */
  readonly requests: number;
  /** Calls to `cancelFrame` so far. */
  readonly cancels: number;
}

/** Create a clock at time 0 with nothing requested. */
export function createFakeClock(): FakeClock {
  let time = 0;
  let nextHandle = 1;
  let requests = 0;
  let cancels = 0;
  let callbacks = new Map<number, (time: number) => void>();

  return {
    requestFrame(callback) {
      requests++;
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      cancels++;
      callbacks.delete(handle);
    },
    now: () => time,
    advance(ms) {
      time += ms;
    },
    frame() {
      time += 16;
      const due = callbacks;
      callbacks = new Map();
      let failure: { error: unknown } | null = null;
      for (const callback of due.values()) {
        try {
          callback(time);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== null) throw failure.error;
      return due.size;
    },
    get pending() {
      return callbacks.size;
    },
    get requests() {
      return requests;
    },
    get cancels() {
      return cancels;
    },
  };
}
