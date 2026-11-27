/**
 * Bars: where a span's bar and its event markers fall on the plot.
 *
 * Both the frame plan (what to draw) and the hit test (what is under the
 * pointer) use these functions, so they always agree. The bar geometry itself
 * (`barExtent` and friends) lives in the kit and is re-exported here; this file
 * adds the event markers.
 *
 * Headless: no DOM, no browser globals.
 */

import { pxPerMs, type Camera1D } from '../../../kit/geometry/camera1d.ts';
import { lowerBound, type BarExtent } from '../../../kit/geometry/extent.ts';
import type { SpanTable } from '../../../core/span-table.ts';

export { CLIP_MARGIN, MIN_BAR_WIDTH, barExtent, createBarExtent, lowerBound } from '../../../kit/geometry/extent.ts';
export type { BarExtent } from '../../../kit/geometry/extent.ts';

/** A bar narrower than this (on screen) shows no event markers, px. */
export const MIN_BAR_WIDTH_FOR_EVENTS = 6;
/** Closest two event markers on one bar are placed, px. */
export const MIN_EVENT_GAP = 2;
/** Most event markers drawn on one bar. */
export const MAX_EVENT_MARKERS = 64;
/**
 * Place the event markers of one span.
 *
 * Only events inside the span and inside the visible window get a marker, and none are
 * drawn on a bar narrower than {@link MIN_BAR_WIDTH_FOR_EVENTS}. Markers are at least
 * {@link MIN_EVENT_GAP} px apart (further apart on a long bar, so that a bar never gets
 * more than `capacity` markers); of events that fall within one gap, the earliest wins.
 *
 * @param table - The trace.
 * @param row - Table row of the span.
 * @param camera - The visible time window, sized to the plot.
 * @param extent - The span's bar, from {@link barExtent}.
 * @param out - Receives marker x positions (plot px), in order, starting at `offset`.
 * @param offset - Where in `out` to start writing.
 * @param capacity - Most markers to write; `out` needs room for `offset + capacity` entries.
 * @returns The number of markers written.
 */
export function eventMarkers(
  table: SpanTable,
  row: number,
  camera: Camera1D,
  extent: BarExtent,
  out: Float32Array,
  offset: number,
  capacity: number = MAX_EVENT_MARKERS,
): number {
  const first = table.evOff[row];
  const last = table.evOff[row + 1];
  const visibleWidth = extent.x1 - extent.x0;
  if (first === last || !extent.visible || visibleWidth < MIN_BAR_WIDTH_FOR_EVENTS) return 0;

  const from = Math.max(table.start[row], camera.t0);
  const to = Math.min(table.end[row], camera.t1);
  const scale = pxPerMs(camera);
  if (!(to >= from) || !(scale > 0)) return 0;

  const gapMs = Math.max(MIN_EVENT_GAP, visibleWidth / capacity) / scale;
  const evT = table.evT;
  let count = 0;
  for (let k = lowerBound(evT, first, last, from); k < last && count < capacity;) {
    const t = evT[k];
    if (t > to) break;
    out[offset + count++] = (t - camera.t0) * scale;
    k = lowerBound(evT, k + 1, last, t + gapMs);
  }
  return count;
}
