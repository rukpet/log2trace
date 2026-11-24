/**
 * Instrumentation via the User Timing API (performance.mark / performance.measure).
 *
 * All marks and measures use the `log2trace:` prefix so they appear
 * grouped in browser DevTools Performance recordings. Zero overhead
 * when the Performance panel is not recording — the browser discards
 * marks cheaply.
 *
 * Consumers never need to enable or configure anything; simply open
 * DevTools → Performance → record, and timings appear automatically.
 *
 * The core has no DOM typings, so `performance` is looked up on `globalThis`
 * and typed here. Where a runtime has none, the calls do nothing.
 */

const PREFIX = 'log2trace';

/** The part of the User Timing API used here. */
interface UserTiming {
  mark(name: string, options?: { detail?: unknown }): unknown;
  measure(name: string, startMark?: string): unknown;
  clearMarks(name?: string): void;
}

function userTiming(): UserTiming | undefined {
  return Reflect.get(globalThis, 'performance');
}

/**
 * Place a performance mark with an optional detail payload.
 * Marks are lightweight timestamps visible in the Performance panel.
 */
export function mark(name: string, detail?: unknown): void {
  userTiming()?.mark(`${PREFIX}:${name}`, detail !== undefined ? { detail } : undefined);
}

/**
 * Measure a synchronous operation and return its result.
 * Creates a performance.measure entry visible in DevTools.
 */
export function measure<T>(name: string, fn: () => T): T {
  const timing = userTiming();
  if (!timing) return fn();
  const startMark = `${PREFIX}:${name}:start`;
  timing.mark(startMark);
  const result = fn();
  timing.measure(`${PREFIX}:${name}`, startMark);
  timing.clearMarks(startMark);
  return result;
}

/**
 * Measure an async operation and return its result.
 * Creates a performance.measure entry visible in DevTools.
 */
export async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timing = userTiming();
  if (!timing) return fn();
  const startMark = `${PREFIX}:${name}:start`;
  timing.mark(startMark);
  const result = await fn();
  timing.measure(`${PREFIX}:${name}`, startMark);
  timing.clearMarks(startMark);
  return result;
}
