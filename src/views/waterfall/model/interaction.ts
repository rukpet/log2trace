/**
 * Interaction: what the waterfall does with input.
 *
 * The browser events (wheel, drag, click, keys) are turned into plain
 * {@link WaterfallInput}s by the DOM binding of the view; {@link reduceInteraction} maps an
 * input and the current {@link ViewState} to the next state, a set of dirty bits for the painter
 * and a list of {@link Effect}s for the store (select, hover, collapse). It reads the model but
 * touches neither the DOM nor the store, so every behaviour is tested in Node.
 *
 * Plain vertical wheel scrolling is native (the rows live in a scrollable element); the reducer
 * only keeps `scrollTop` in step with it. Zoom, horizontal pan and everything else is handled
 * here, and `handled` tells the binding whether to cancel the event's default action.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  MIN_WINDOW_MS,
  PINCH_ZOOM_K,
  WHEEL_ZOOM_K,
  createCamera,
  panByPx,
  pxToTime,
  withWindow,
  zoomAt,
  zoomFactor,
  type Camera1D,
} from '../../../kit/geometry/camera1d.ts';
import {
  clampScrollTop,
  ensureRowVisible,
  keepRowAtSameY,
  visibleRange,
  type RevealAlign,
} from '../../../kit/geometry/virtual-list.ts';
import type { SpanIndex } from '../../../core/span-index.ts';
import type { SpanMask } from '../../../core/span-set.ts';
import { HitPart, createHitResult, hitTest } from './hit.ts';
import { listMetrics, type WaterfallLayout } from './layout.ts';
import { Chevron, chevronOf, type RowProjection } from './rows.ts';

/** What a painter has to redraw; OR the bits together. */
export enum WaterfallDirty {
  /** The set of rows changed (collapse, filter, new data). */
  Rows = 1,
  /** The rows scrolled. */
  Scroll = 2,
  /** The time window changed (zoom, pan). */
  Camera = 4,
  /** The selection changed. */
  Selection = 8,
  /** The hovered element changed. */
  Hover = 16,
  /** Colours or fonts changed. */
  Theme = 32,
  /** The view was resized. */
  Size = 64,
}

/** Pan step of the arrow keys, px. */
export const KEY_PAN_PX = 50;
/** Zoom step of the plus and minus keys and buttons (the window gets this much shorter or longer). */
export const KEY_ZOOM_STEP = 1.2;
/** Room left around a span when zooming to it, as a share of its duration. */
export const ZOOM_TO_SPAN_PADDING = 0.05;
/** Where the start of a span lands, as a share of the window, when a pan reveals it. */
export const REVEAL_LEAD = 0.1;

/** The element under the pointer, as far as the view tells the store. */
export interface HoverInfo {
  /** Table row of the span. */
  readonly span: number;
  readonly part: HitPart;
  /** Index into the table's event arrays for an event marker, else -1. */
  readonly event: number;
  /** Box to attach a tooltip to, in view coordinates. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The view's own state: where it looks. The shared state (selection, collapse) is in the store. */
export interface ViewState {
  /** The visible time window. */
  readonly camera: Camera1D;
  /** Scroll position of the rows, px. */
  readonly scrollTop: number;
  /** What the pointer was last over, or `null`. */
  readonly hover: HoverInfo | null;
}

/** What the view must do to the store or the DOM as a result of an input. */
export type Effect =
  /** Select a span (`-1` clears the selection); `event` is the marker clicked, else -1. */
  | { readonly type: 'select'; readonly span: number; readonly event: number; readonly additive: boolean }
  /** The hovered element changed; `null` when the pointer left every element. */
  | { readonly type: 'hover'; readonly target: HoverInfo | null }
  /** Collapse an expanded span or expand a collapsed one. */
  | { readonly type: 'toggle'; readonly span: number }
  /** Collapse or expand a span, whichever state it is in. */
  | { readonly type: 'collapse'; readonly span: number; readonly collapsed: boolean };

/** Mouse cursor to show over the surface. */
export type Cursor = 'default' | 'pointer' | 'grab';

/** Input to the reducer; positions are in view coordinates, deltas in CSS pixels. */
export type WaterfallInput =
  /** The scroller moved (native scrolling). */
  | { readonly type: 'scroll'; readonly top: number }
  /** A wheel event, with the delta already normalised to pixels. `ctrl` is true for Ctrl or Cmd. */
  | { readonly type: 'wheel'; readonly x: number; readonly dx: number; readonly dy: number; readonly ctrl: boolean; readonly shift: boolean }
  /** A drag moved by `dx` pixels. */
  | { readonly type: 'pan'; readonly dx: number }
  /** A two-finger gesture scaled by `scale` (above 1 spreads the fingers: zoom in) around x. */
  | { readonly type: 'pinch'; readonly x: number; readonly scale: number }
  | { readonly type: 'click'; readonly x: number; readonly y: number; readonly additive: boolean }
  | { readonly type: 'doubleClick'; readonly x: number; readonly y: number }
  | { readonly type: 'hover'; readonly x: number; readonly y: number }
  /** The pointer left the surface. */
  | { readonly type: 'leave' }
  | { readonly type: 'key'; readonly key: string; readonly shift: boolean; readonly ctrl: boolean; readonly alt: boolean }
  /** Zoom around the middle of the window (toolbar buttons). */
  | { readonly type: 'zoomBy'; readonly factor: number }
  /** Show the whole trace again. */
  | { readonly type: 'reset' }
  /** Bring a span into view (selection from outside, search). */
  | { readonly type: 'reveal'; readonly span: number; readonly align: RevealAlign };

/** What the reducer reads besides the state. */
export interface InteractionContext {
  readonly index: SpanIndex;
  readonly projection: RowProjection;
  readonly collapsed: SpanMask | null;
  readonly layout: WaterfallLayout;
  /** Waterfall row of the primary selected span, or -1 for none or hidden. */
  readonly selectedRow: number;
  /** Plain wheel zooms (the old behaviour) instead of scrolling the rows. */
  readonly wheelZoom: boolean;
}

/** The outcome of one input. */
export interface InteractionResult {
  readonly state: ViewState;
  /** OR of {@link WaterfallDirty} bits. */
  readonly dirty: number;
  /** Whether the event's default action (scrolling, text selection) should be cancelled. */
  readonly handled: boolean;
  /** The reducer changed `scrollTop` on its own: write `state.scrollTop` to the scroller. */
  readonly scrollTo: boolean;
  readonly cursor: Cursor;
  readonly effects: readonly Effect[];
}

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);
const scratchHit = createHitResult();

function cursorFor(hover: HoverInfo | null): Cursor {
  if (hover === null || hover.part === HitPart.None) return 'default';
  return hover.part === HitPart.Row ? 'grab' : 'pointer';
}

function outcome(
  state: ViewState,
  dirty: number,
  handled: boolean,
  effects: readonly Effect[] = NO_EFFECTS,
  scrollTo = false,
): InteractionResult {
  return { state, dirty, handled, scrollTo, cursor: cursorFor(state.hover), effects };
}

/** A state looking at the whole trace from the top. */
export function initialViewState(index: SpanIndex, layout: WaterfallLayout): ViewState {
  return { camera: createCamera(index.table.extentMs, layout.plotWidth), scrollTop: 0, hover: null };
}

/**
 * Bring a state in line with a new layout or row count: the camera takes the new plot width and the
 * scroll position is clamped to the rows that exist.
 */
export function fitViewState(state: ViewState, layout: WaterfallLayout, rowCount: number): ViewState {
  const camera = state.camera.widthPx === layout.plotWidth ? state.camera : { ...state.camera, widthPx: layout.plotWidth };
  const scrollTop = clampScrollTop(listMetrics(layout, rowCount), state.scrollTop);
  return camera === state.camera && scrollTop === state.scrollTop ? state : { ...state, camera, scrollTop };
}

/**
 * The scroll position that keeps the same span at the same height after the rows changed.
 *
 * The anchor is the selected span if it is on screen, otherwise the first row in view. If the
 * anchor is gone, the position is only clamped.
 *
 * @param before - The rows, layout and scroll position as they were.
 * @param selectedSpan - Table row of the selected span, or -1.
 * @param after - The rows and layout now. Both must belong to the same trace.
 */
export function anchoredScrollTop(
  before: { readonly projection: RowProjection; readonly layout: WaterfallLayout; readonly scrollTop: number },
  selectedSpan: number,
  after: { readonly projection: RowProjection; readonly layout: WaterfallLayout },
): number {
  const metricsAfter = listMetrics(after.layout, after.projection.count);
  const range = visibleRange(listMetrics(before.layout, before.projection.count), before.scrollTop, 0);
  if (range.last < range.first) return clampScrollTop(metricsAfter, before.scrollTop);

  let fromRow = range.first;
  if (selectedSpan >= 0) {
    const selected = before.projection.rowOf[selectedSpan];
    if (selected >= range.first && selected <= range.last) fromRow = selected;
  }
  const anchor = before.projection.rows[fromRow];
  const toRow = anchor < after.projection.rowOf.length ? after.projection.rowOf[anchor] : -1;
  return keepRowAtSameY(metricsAfter, before.scrollTop, fromRow, toRow);
}

/**
 * Pan the window, without zooming, so that a span is in view. Nothing changes while the span
 * overlaps the window; otherwise a span shorter than the window is centred and a longer one
 * starts a tenth of the way in.
 */
export function revealTime(camera: Camera1D, start: number, end: number): Camera1D {
  if (end > camera.t0 && start < camera.t1) return camera;
  const length = camera.t1 - camera.t0;
  const t0 = end - start < length ? (start + end) / 2 - length / 2 : start - REVEAL_LEAD * length;
  return withWindow(camera, t0, t0 + length);
}

/** The window that shows a span with a little room around it. */
export function windowForSpan(start: number, end: number): { t0: number; t1: number } {
  const padding = Math.max((end - start) * ZOOM_TO_SPAN_PADDING, MIN_WINDOW_MS);
  return { t0: start - padding, t1: Math.max(end, start) + padding };
}

function plotX(ctx: InteractionContext, x: number): number {
  return Math.min(Math.max(x - ctx.layout.plotLeft, 0), ctx.layout.plotWidth);
}

/** The camera changed to `camera`: nothing to redraw when it shows the same window (zooming out at the limit, say). */
function withCamera(state: ViewState, camera: Camera1D): InteractionResult {
  const same = camera === state.camera || (camera.t0 === state.camera.t0 && camera.t1 === state.camera.t1);
  return same ? outcome(state, 0, true) : outcome({ ...state, camera }, WaterfallDirty.Camera, true);
}

function zoomAroundCentre(state: ViewState, factor: number): InteractionResult {
  const { camera } = state;
  return withCamera(state, zoomAt(camera, (camera.t0 + camera.t1) / 2, factor));
}

function wholeTrace(state: ViewState): InteractionResult {
  const { camera } = state;
  return withCamera(state, createCamera(camera.total, camera.widthPx));
}

function sameHover(a: HoverInfo | null, b: HoverInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.span === b.span && a.part === b.part && a.event === b.event;
}

function hitAt(state: ViewState, ctx: InteractionContext, x: number, y: number) {
  return hitTest(
    { index: ctx.index, projection: ctx.projection, collapsed: ctx.collapsed, layout: ctx.layout, camera: state.camera, scrollTop: state.scrollTop },
    x,
    y,
    scratchHit,
  );
}

function scrollToRow(state: ViewState, ctx: InteractionContext, row: number, align: RevealAlign): number {
  return ensureRowVisible(listMetrics(ctx.layout, ctx.projection.count), state.scrollTop, row, align);
}

/** Select the row `delta` rows from the selected one and make it visible. */
function moveSelection(state: ViewState, ctx: InteractionContext, delta: number): InteractionResult {
  const { count, rows } = ctx.projection;
  if (count === 0) return outcome(state, 0, false);

  const row = ctx.selectedRow < 0 ? 0 : Math.min(count - 1, Math.max(0, ctx.selectedRow + delta));
  const span = rows[row];
  const { table } = ctx.index;
  const scrollTop = scrollToRow(state, ctx, row, 'nearest');
  const camera = revealTime(state.camera, table.start[span], table.end[span]);

  const dirty = (scrollTop !== state.scrollTop ? WaterfallDirty.Scroll : 0) | (camera !== state.camera ? WaterfallDirty.Camera : 0);
  const next = dirty === 0 ? state : { ...state, scrollTop, camera };
  return outcome(next, dirty, true, [{ type: 'select', span, event: -1, additive: false }], scrollTop !== state.scrollTop);
}

function handleKey(state: ViewState, input: Extract<WaterfallInput, { type: 'key' }>, ctx: InteractionContext): InteractionResult {
  if (input.ctrl || input.alt) return outcome(state, 0, false);

  switch (input.key) {
    case 'ArrowUp':
      return moveSelection(state, ctx, -1);
    case 'ArrowDown':
      return moveSelection(state, ctx, 1);
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (input.shift) {
        if (ctx.selectedRow < 0) return outcome(state, 0, true);
        const chevron = chevronOf(ctx.index, ctx.projection, ctx.collapsed, ctx.selectedRow);
        const collapse = input.key === 'ArrowLeft';
        const wanted = collapse ? Chevron.Expanded : Chevron.Collapsed;
        if (chevron !== wanted) return outcome(state, 0, true);
        return outcome(state, 0, true, [{ type: 'collapse', span: ctx.projection.rows[ctx.selectedRow], collapsed: collapse }]);
      }
      return withCamera(state, panByPx(state.camera, input.key === 'ArrowLeft' ? KEY_PAN_PX : -KEY_PAN_PX));
    }
    case '+':
    case '=':
      return zoomAroundCentre(state, 1 / KEY_ZOOM_STEP);
    case '-':
    case '_':
      return zoomAroundCentre(state, KEY_ZOOM_STEP);
    case '0':
    case 'Home':
      return wholeTrace(state);
    case 'PageUp':
    case 'PageDown': {
      const page = ctx.layout.bodyHeight;
      const scrollTop = clampScrollTop(listMetrics(ctx.layout, ctx.projection.count), state.scrollTop + (input.key === 'PageUp' ? -page : page));
      if (scrollTop === state.scrollTop) return outcome(state, 0, true);
      return outcome({ ...state, scrollTop }, WaterfallDirty.Scroll, true, NO_EFFECTS, true);
    }
    default:
      return outcome(state, 0, false);
  }
}

function handleClick(state: ViewState, input: Extract<WaterfallInput, { type: 'click' }>, ctx: InteractionContext): InteractionResult {
  const hit = hitAt(state, ctx, input.x, input.y);
  switch (hit.part) {
    case HitPart.Chevron:
      return outcome(state, 0, true, [{ type: 'toggle', span: hit.span }]);
    case HitPart.Label:
    case HitPart.Bar:
    case HitPart.Row:
    case HitPart.Event:
      return outcome(state, 0, true, [{ type: 'select', span: hit.span, event: hit.event, additive: input.additive }]);
    default:
      return outcome(state, 0, false);
  }
}

function handleDoubleClick(state: ViewState, input: Extract<WaterfallInput, { type: 'doubleClick' }>, ctx: InteractionContext): InteractionResult {
  const hit = hitAt(state, ctx, input.x, input.y);
  if (hit.part === HitPart.Chevron) return outcome(state, 0, true);
  if (hit.part === HitPart.Bar || hit.part === HitPart.Event || hit.part === HitPart.Label) {
    const { table } = ctx.index;
    const { t0, t1 } = windowForSpan(table.start[hit.span], table.end[hit.span]);
    return withCamera(state, withWindow(state.camera, t0, t1));
  }
  return wholeTrace(state);
}

function handleHover(state: ViewState, input: Extract<WaterfallInput, { type: 'hover' }>, ctx: InteractionContext): InteractionResult {
  const hit = hitAt(state, ctx, input.x, input.y);
  const next: HoverInfo | null = hit.part === HitPart.None
    ? null
    : { span: hit.span, part: hit.part, event: hit.event, x: hit.x, y: hit.y, w: hit.w, h: hit.h };
  if (sameHover(state.hover, next)) return outcome(state, 0, false);
  return outcome({ ...state, hover: next }, WaterfallDirty.Hover, false, [{ type: 'hover', target: next }]);
}

function handleWheel(state: ViewState, input: Extract<WaterfallInput, { type: 'wheel' }>, ctx: InteractionContext): InteractionResult {
  const { camera } = state;
  const zoom = (k: number): InteractionResult =>
    withCamera(state, zoomAt(camera, pxToTime(camera, plotX(ctx, input.x)), zoomFactor(input.dy, k)));

  if (input.ctrl) return zoom(PINCH_ZOOM_K);
  if (input.shift || Math.abs(input.dx) > Math.abs(input.dy)) {
    return withCamera(state, panByPx(camera, -(input.shift && input.dx === 0 ? input.dy : input.dx)));
  }
  if (ctx.wheelZoom) return zoom(WHEEL_ZOOM_K);
  return outcome(state, 0, false); // plain vertical wheel: the scroller scrolls
}

/**
 * Apply one input.
 *
 * @param state - The view's state before the input.
 * @param input - What happened.
 * @param ctx - The model the input is interpreted against.
 */
export function reduceInteraction(state: ViewState, input: WaterfallInput, ctx: InteractionContext): InteractionResult {
  switch (input.type) {
    case 'scroll': {
      const scrollTop = clampScrollTop(listMetrics(ctx.layout, ctx.projection.count), input.top);
      return scrollTop === state.scrollTop ? outcome(state, 0, false) : outcome({ ...state, scrollTop }, WaterfallDirty.Scroll, false);
    }
    case 'wheel':
      return handleWheel(state, input, ctx);
    case 'pan':
      return withCamera(state, panByPx(state.camera, input.dx));
    case 'pinch':
      return withCamera(state, zoomAt(state.camera, pxToTime(state.camera, plotX(ctx, input.x)), input.scale > 0 ? 1 / input.scale : 1));
    case 'click':
      return handleClick(state, input, ctx);
    case 'doubleClick':
      return handleDoubleClick(state, input, ctx);
    case 'hover':
      return handleHover(state, input, ctx);
    case 'leave':
      return state.hover === null
        ? outcome(state, 0, false)
        : outcome({ ...state, hover: null }, WaterfallDirty.Hover, false, [{ type: 'hover', target: null }]);
    case 'key':
      return handleKey(state, input, ctx);
    case 'zoomBy':
      return zoomAroundCentre(state, input.factor);
    case 'reset':
      return wholeTrace(state);
    case 'reveal': {
      const row = ctx.projection.rowOf[input.span];
      if (row === undefined || row < 0) return outcome(state, 0, false);
      const { table } = ctx.index;
      const scrollTop = scrollToRow(state, ctx, row, input.align);
      const camera = revealTime(state.camera, table.start[input.span], table.end[input.span]);
      const dirty = (scrollTop !== state.scrollTop ? WaterfallDirty.Scroll : 0) | (camera !== state.camera ? WaterfallDirty.Camera : 0);
      return outcome(dirty === 0 ? state : { ...state, scrollTop, camera }, dirty, false, NO_EFFECTS, scrollTop !== state.scrollTop);
    }
  }
}
