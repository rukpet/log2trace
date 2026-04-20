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
  return Number(BigInt(nano) / 1_000_000n);
}
