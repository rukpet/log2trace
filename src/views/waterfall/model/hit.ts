/**
 * Hit testing: what is under a point of the view.
 *
 * Geometry only, shared by the Canvas and the DOM painter, so both react to
 * the pointer identically. Finding the row is arithmetic, and the nearest
 * event marker is a binary search, so a test costs the same at 50,000 spans as
 * at 50. Reuse one {@link HitResult} for every pointer move to avoid garbage.
 *
 * Headless: no DOM, no browser globals.
 */

import { pxPerMs, type Camera1D } from '../../../kit/geometry/camera1d.ts';
import { clampScrollTop } from '../../../kit/geometry/virtual-list.ts';
import type { SpanIndex } from '../../../core/span-index.ts';
import type { SpanMask } from '../../../core/span-set.ts';
import { barExtent, createBarExtent, lowerBound, MIN_BAR_WIDTH_FOR_EVENTS } from './bars.ts';
import { CHEVRON_SIZE, chevronX, listMetrics, rowAt, rowTop, type WaterfallLayout } from './layout.ts';
import { Chevron, chevronOf, type RowProjection } from './rows.ts';

/** What a point is over. */
export enum HitPart {
  /** Nothing: the ruler, the space below the last row, or outside the view. */
  None = 0,
  /** The chevron box of a span that has children on show. */
  Chevron = 1,
  /** The label of a span in the gutter. */
  Label = 2,
  /** A span's bar, or up to {@link BAR_TOLERANCE} px beside it. */
  Bar = 3,
  /** An event marker on a bar. */
  Event = 4,
  /** A row, but not its bar: empty plot area. */
  Row = 5,
}

/** How far beside a bar still counts as the bar, px; keeps thin bars clickable. */
export const BAR_TOLERANCE = 3;
/** How far from an event marker still counts as the marker, px. */
export const EVENT_TOLERANCE = 3;
/** Width of the anchor box of an event marker, px. */
export const EVENT_ANCHOR_WIDTH = 6;

/** The answer of {@link hitTest}; reuse one object. */
export interface HitResult {
  part: HitPart;
  /** Waterfall row, or -1 for none. */
  row: number;
  /** Table row of the span, or -1 for none. */
  span: number;
  /** Index into the table's event arrays (`evT`) for an {@link HitPart.Event}, else -1. */
  event: number;
  /** Box to attach a tooltip to, in view coordinates: the chevron, the label column, the bar, the marker or the row. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An empty result to pass to {@link hitTest}. */
export function createHitResult(): HitResult {
  return { part: HitPart.None, row: -1, span: -1, event: -1, x: 0, y: 0, w: 0, h: 0 };
}

/** What {@link hitTest} reads. */
export interface HitInput {
  readonly index: SpanIndex;
  readonly projection: RowProjection;
  readonly collapsed: SpanMask | null;
  readonly layout: WaterfallLayout;
  readonly camera: Camera1D;
  readonly scrollTop: number;
}

const scratchExtent = createBarExtent();

function setBox(out: HitResult, x: number, y: number, w: number, h: number): void {
  out.x = x;
  out.y = y;
  out.w = w;
  out.h = h;
}

/**
 * The event of a span nearest to a plot position, when it is within {@link EVENT_TOLERANCE} px
 * and inside the span; its index in the table's event arrays, else -1.
 */
function nearestEvent(input: HitInput, span: number, px: number): number {
  const { table } = input.index;
  const first = table.evOff[span];
  const last = table.evOff[span + 1];
  const scale = pxPerMs(input.camera);
  if (first === last || !(scale > 0)) return -1;

  const { camera } = input;
  const t = camera.t0 + px / scale;
  const after = lowerBound(table.evT, first, last, t);
  let best = -1;
  let bestDistance = EVENT_TOLERANCE + 1;
  for (let k = Math.max(first, after - 1); k < Math.min(last, after + 1); k++) {
    const time = table.evT[k];
    if (time < table.start[span] || time > table.end[span]) continue;
    const distance = Math.abs((time - camera.t0) * scale - px);
    if (distance <= EVENT_TOLERANCE && distance < bestDistance) {
      best = k;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Find what is at a point.
 *
 * @param input - The state to test against.
 * @param x - Horizontal position in the view, px.
 * @param y - Vertical position in the view, px.
 * @param out - Receives the result; every field is overwritten.
 * @returns `out`.
 */
export function hitTest(input: HitInput, x: number, y: number, out: HitResult): HitResult {
  out.part = HitPart.None;
  out.row = -1;
  out.span = -1;
  out.event = -1;
  setBox(out, 0, 0, 0, 0);

  const { index, projection, layout, camera } = input;
  if (!(x >= 0 && x < layout.width)) return out;

  const scrollTop = clampScrollTop(listMetrics(layout, projection.count), input.scrollTop);
  const row = rowAt(layout, projection.count, y, scrollTop);
  if (row < 0) return out;

  const { table } = index;
  const span = projection.rows[row];
  const top = rowTop(layout, row, scrollTop);
  out.row = row;
  out.span = span;
  out.part = HitPart.Row;
  setBox(out, 0, top, layout.width, layout.rowHeight);

  if (x < layout.plotLeft) {
    const left = chevronX(layout, table.depth[span]);
    if (x >= left && x < left + CHEVRON_SIZE && chevronOf(index, projection, input.collapsed, row) !== Chevron.None) {
      out.part = HitPart.Chevron;
      setBox(out, left, top + (layout.rowHeight - CHEVRON_SIZE) / 2, CHEVRON_SIZE, CHEVRON_SIZE);
    } else {
      out.part = HitPart.Label;
      setBox(out, 0, top, layout.plotLeft, layout.rowHeight);
    }
    return out;
  }

  const px = x - layout.plotLeft;
  const extent = barExtent(camera, table.start[span], table.end[span], scratchExtent);
  if (!extent.visible || px < extent.x0 - BAR_TOLERANCE || px > extent.x1 + BAR_TOLERANCE) return out;

  const barTop = top + layout.barInset;
  out.part = HitPart.Bar;
  setBox(out, layout.plotLeft + extent.x0, barTop, extent.x1 - extent.x0, layout.barHeight);

  if (y >= barTop && y < barTop + layout.barHeight && extent.x1 - extent.x0 >= MIN_BAR_WIDTH_FOR_EVENTS) {
    const event = nearestEvent(input, span, px);
    if (event >= 0) {
      const markerX = (table.evT[event] - camera.t0) * pxPerMs(camera);
      out.part = HitPart.Event;
      out.event = event;
      setBox(out, layout.plotLeft + markerX - EVENT_ANCHOR_WIDTH / 2, barTop, EVENT_ANCHOR_WIDTH, layout.barHeight);
    }
  }
  return out;
}
