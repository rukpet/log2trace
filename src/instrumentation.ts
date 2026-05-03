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
 */

const PREFIX = 'log2trace';

/**
 * Place a performance mark with an optional detail payload.
 * Marks are lightweight timestamps visible in the Performance panel.
 */
export function mark(name: string, detail?: unknown): void {
  performance.mark(`${PREFIX}:${name}`, detail !== undefined ? { detail } : undefined);
}

/**
 * Measure a synchronous operation and return its result.
 * Creates a performance.measure entry visible in DevTools.
 */
export function measure<T>(name: string, fn: () => T): T {
  const startMark = `${PREFIX}:${name}:start`;
  performance.mark(startMark);
  const result = fn();
  performance.measure(`${PREFIX}:${name}`, startMark);
  performance.clearMarks(startMark);
  return result;
}

/**
 * Measure an async operation and return its result.
 * Creates a performance.measure entry visible in DevTools.
 */
export async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startMark = `${PREFIX}:${name}:start`;
  performance.mark(startMark);
  const result = await fn();
  performance.measure(`${PREFIX}:${name}`, startMark);
  performance.clearMarks(startMark);
  return result;
}
