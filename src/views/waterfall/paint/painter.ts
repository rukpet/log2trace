/**
 * The contract of a waterfall painter.
 *
 * A painter turns what the headless model decided (the controller's frame plan) into DOM nodes on
 * screen. A painter owns its drawing layer inside `host` and nothing else: input, scrolling, the
 * tooltip and the detail panel belong to the view and element.
 */

import type { FrameScheduler } from '../../../kit/scheduler.ts';
import { Dirty } from '../../../kit/scheduler.ts';
import type { TextMeter } from '../../../kit/text-cache.ts';
import type { WaterfallController } from '../controller.ts';
import { WaterfallDirty } from '../model/interaction.ts';

/** Counters for the harness: what the painter did. */
export interface PainterStats {
  /** Full redraws so far (rewrites of the rows in the DOM painter). */
  scenes: number;
  /** Cheap redraws so far (only the hover and selection classes). */
  overlays: number;
  /** Rows drawn by the last full redraw. */
  rows: number;
}

/** What a painter is given when it is mounted. */
export interface PainterContext {
  readonly controller: WaterfallController;
  /** The element to draw into. It is positioned (`position: relative`) and clips its content. */
  readonly host: HTMLElement;
  /** Caches text widths; shared, and cleared by the painter when fonts load. */
  readonly meter: TextMeter;
  /** Computed CSS font-family used to measure labels. */
  readonly fontFamily: string;
  readonly scheduler: FrameScheduler;
  /** The host has (a new) size, in CSS px. Called before the painter draws at that size. */
  readonly onSize: (width: number, height: number) => void;
}

/** A mounted painter. */
export interface WaterfallPainter {
  readonly stats: PainterStats;
  /** Say what changed, as {@link WaterfallDirty} bits; the painter draws on the next frame. */
  mark(dirty: number): void;
  /** The theme or font changed; the painter updates its font metrics and repaints. */
  setFontFamily(fontFamily: string): void;
  /** Remove everything the painter added to the host and stop its listeners. */
  dispose(): void;
}

/** The {@link WaterfallDirty} bits of the controller as the scheduler's {@link Dirty} bits. */
export function toSurfaceDirty(bits: number): number {
  let out = 0;
  if (bits & WaterfallDirty.Rows) out |= Dirty.Rows;
  if (bits & WaterfallDirty.Scroll) out |= Dirty.Scroll;
  if (bits & WaterfallDirty.Camera) out |= Dirty.Camera;
  if (bits & WaterfallDirty.Selection) out |= Dirty.Selection;
  if (bits & WaterfallDirty.Hover) out |= Dirty.Hover;
  if (bits & WaterfallDirty.Theme) out |= Dirty.Theme;
  if (bits & WaterfallDirty.Size) out |= Dirty.Size;
  return out;
}
