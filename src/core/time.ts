/** Nanoseconds in a millisecond. */
const NANOS_PER_MS = 1_000_000n;

/**
 * Convert a nanosecond timestamp string to milliseconds.
 *
 * OpenTelemetry encodes timestamps as nanoseconds since the Unix epoch
 * in string form to preserve int64 precision. This helper narrows that
 * value into a regular JavaScript number for use in the timeline math
 * (Date constructors, pixel offsets, etc.). Sub-millisecond precision
 * is discarded by integer division.
 *
 * @param nano - UNIX epoch time in nanoseconds, encoded as a decimal string.
 * @returns The same instant expressed in milliseconds.
 */
export function nanoToMilli(nano: string): number {
  return bigNanoToMilli(BigInt(nano));
}

/** {@link nanoToMilli} for a timestamp that is already a BigInt. */
export function bigNanoToMilli(nano: bigint): number {
  return Number(nano / NANOS_PER_MS);
}

/**
 * Parse a nanosecond timestamp string, naming `what` it belongs to when it is not a number.
 *
 * @param value - Decimal string of nanoseconds since the Unix epoch.
 * @param what - Used in the error message, e.g. `span 3f2a start time`.
 * @throws Error when `value` is not a whole number.
 */
export function parseNano(value: string, what: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${what}: "${String(value)}" is not a nanosecond timestamp`);
  }
}

/**
 * Milliseconds from `originNano` to `nano`, keeping the sub-millisecond part.
 *
 * The subtraction is done on BigInts, so it is exact; only the final division
 * rounds. A trace hours long therefore still resolves microseconds, which
 * `nanoToMilli` throws away.
 *
 * @param nano - The instant, in nanoseconds since the Unix epoch.
 * @param originNano - The instant that counts as zero, in the same unit.
 */
export function nanoDeltaToMilli(nano: bigint, originNano: bigint): number {
  return Number(nano - originNano) / 1e6;
}
