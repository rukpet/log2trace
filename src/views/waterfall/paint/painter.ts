/**
 * The contract of a waterfall painter.
 *
 * A painter turns what the headless model decided (the controller's frame plan) into something on
 * screen. Canvas 2D and the virtualized DOM are two implementations of this one interface, so the
 * element can mount either and swap them while keeping the camera, the scroll position and the
 * selection (all of which live in the controller and the store, never in a painter).
 *
 * A painter owns its drawing surface inside `host` and nothing else: input, scrolling, the
 * tooltip and the detail panel belong to the element.
 */

import type { FrameScheduler } from '../../../kit/scheduler.ts';
import { Dirty } from '../../../kit/scheduler.ts';
import type { TextMeter } from '../../../kit/canvas/text-cache.ts';
import type { RendererKind } from '../../../kit/view.ts';
import type { ResolvedTheme } from '../../../kit/theme/theme.ts';
import type { WaterfallController } from '../controller.ts';
import { WaterfallDirty } from '../model/interaction.ts';

/** The kinds of painter (declared by the view contract, which lets a view name its backends). */
export type { RendererKind };

/** Counters for the harness: what the painter did. */
export interface PainterStats {
  /** Full redraws so far (the canvas scene, or a rewrite of the rows in the DOM painter). */
  scenes: number;
  /** Cheap redraws so far (the overlay, or only the hover and selection classes). */
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
  /** The tokens as the browser resolved them. */
  readonly theme: ResolvedTheme;
  readonly scheduler: FrameScheduler;
  /** The host has (a new) size, in CSS px. Called before the painter draws at that size. */
  readonly onSize: (width: number, height: number) => void;
}

/** A mounted painter. */
export interface WaterfallPainter {
  readonly kind: RendererKind;
  readonly stats: PainterStats;
  /** Say what changed, as {@link WaterfallDirty} bits; the painter draws on the next frame. */
  mark(dirty: number): void;
  /** The theme was resolved again; the painter repaints with it. */
  setTheme(theme: ResolvedTheme): void;
  /** Remove everything the painter added to the host and stop its listeners. */
  dispose(): void;
}

/** Creates a painter. */
export type PainterFactory = (context: PainterContext) => WaterfallPainter;

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
