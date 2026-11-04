/**
 * Text formatting shared by every view and by the chrome: durations,
 * offsets, wall-clock times and attribute values. Plain strings, never
 * markup: whoever puts them on screen decides how to escape them.
 *
 * Headless: no DOM, no browser globals.
 */

import type { AnyValue } from './otel/common.ts';
import { nanoToMilli } from './time.ts';

/**
 * A duration in the unit that reads best: `250µs`, `12.50ms`, `1.50s`, `2.00min`.
 *
 * @param ms - Duration in milliseconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}min`;
}

/**
 * A signed distance from a reference time: `+250µs`, `-1.50s`.
 *
 * @param ms - Offset in milliseconds; negative when before the reference.
 */
export function formatOffset(ms: number): string {
  return ms < 0 ? `-${formatDuration(-ms)}` : `+${formatDuration(ms)}`;
}

/**
 * The value of an OTel attribute as text. Arrays and key-value lists become JSON.
 *
 * @param value - The attribute value.
 * @returns The text; an empty string when the value holds nothing.
 */
export function extractAnyValue(value: AnyValue): string {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue) return JSON.stringify(value.arrayValue.values.map(v => extractAnyValue(v)));
  if (value.kvlistValue) return JSON.stringify(Object.fromEntries(value.kvlistValue.values.map(kv => [kv.key, extractAnyValue(kv.value)])));
  return '';
}

/**
 * A timestamp as local wall-clock time with milliseconds, `2026-02-26 05:37:20.340`.
 *
 * @param nanoStr - Nanoseconds since the Unix epoch, as a decimal string.
 */
export function formatAbsoluteTime(nanoStr: string): string {
  const d = new Date(nanoToMilli(nanoStr));
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
