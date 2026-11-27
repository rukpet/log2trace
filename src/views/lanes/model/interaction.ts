/**
 * Interaction: what the lanes view does with input.
 *
 * The browser events (wheel, drag, click, keys) are turned into plain {@link LanesInput}s by the
 * DOM binding of the view; {@link reduceInteraction} maps an input and the current {@link ViewState}
 * to the next state, a set of dirty bits for the painter and a list of {@link Effect}s for the
 * store (select, hover). It reads the model and the last frame plan (picking goes through the plan, so
 * it always agrees with what was drawn) but touches neither the DOM nor the store, so every
 * behaviour is tested in Node.
 *
 * Lane modes (collapsed, capped, full) are view state, not shared state: a click on a header or an
 * overflow row, a key or a command changes them and rebuilds the stack of lanes, keeping the lane the
 * user looks at where it was.
 *
 * Plain vertical wheel scrolling is native (the lanes live in a scrollable element); the reducer only
 * keeps `scrollTop` in step with it. Zoom, horizontal pan and everything else is handled here, and
 * `handled` tells the binding whether to cancel the event's default action.
 *
 * Keys: left and right move to the previous or next item on the same track, up to the parent span
 * (in any lane), down to the first child, plus, minus and 0 zoom, F zooms to the selection, Enter or
 * Space toggles the lane of the selection, E expands all lanes and G collapses them all. Escape is the
 * view's.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  MIN_WINDOW_MS,
  PINCH_ZOOM_K,
  WHEEL_ZOOM_K,
  createCamera,
  panByPx,
  pxPerMs,
  pxToTime,
  withWindow,
  zoomAt,
  zoomFactor,
  type Camera1D,
} from '../../../kit/geometry/camera1d.ts';
import { lowerBound } from '../../../kit/geometry/extent.ts';
import type { SpanMask } from '../../../core/span-set.ts';
import { HitPart, createHitResult, hitTest, rowsInFlight, rowsOfRun, type HitResult } from './hit.ts';
import type { LaneModel } from './lanes.ts';
import {
  LaneMode,
  clampScroll,
  laneAt,
  laneHeight,
  laneOfTrack,
  levelTop,
  scrollToRange,
  stackLanes,
  trackOfItem,
  type LaneStack,
  type LanesLayout,
} from './layout.ts';
import type { LanesFramePlan, SelectionMasks } from './plan.ts';

/** What a painter has to redraw; OR the bits together. */
export enum LanesDirty {
  /** The stack of lanes changed (modes, order, peers, metrics, new data). */
  Lanes = 1,
  /** The lanes scrolled. */
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
  /** The filter changed: bars dim, summaries count matches only. */
  Filter = 128,
}

/** Pan step of the arrow keys that pan, px. */
export const KEY_PAN_PX = 50;
/** Zoom step of the plus and minus keys and buttons (the window gets this much shorter or longer). */
export const KEY_ZOOM_STEP = 1.2;
/** Room left around a span when zooming to it, as a share of its duration. */
export const ZOOM_TO_SPAN_PADDING = 0.05;
/** Where the start of a span lands, as a share of the window, when a pan reveals it. */
export const REVEAL_LEAD = 0.1;

/** The element under the pointer, as far as the view tells the store and the tooltip: a copy of the hit. */
export type HoverInfo = Readonly<HitResult>;

/** The view's own state: where it looks and how the lanes are shown. The shared state (selection, filter) is in the store. */
export interface ViewState {
  /** The visible time window. */
  readonly camera: Camera1D;
  /** Scroll position of the lanes, px. */
  readonly scrollTop: number;
  /** What the pointer was last over, or `null`. */
  readonly hover: HoverInfo | null;
  /** The shown lanes with their modes and heights; `stack.modes` holds the mode of every lane. */
  readonly stack: LaneStack;
  /**
   * The item the keyboard cursor is on, or -1: the item that was clicked or moved to last. It tells a
   * span's own bar from its ghost on a peer lane; it only counts while it is an item of the selected span.
   */
  readonly focusItem: number;
}

/** What the view must do to the store as a result of an input (lane modes live in the state). */
export type Effect =
  /** Select spans by table row; `rows` empty clears the selection. `key` names a merged run or summary. */
  | { readonly type: 'select'; readonly rows: readonly number[]; readonly primary: number; readonly key?: string; readonly additive: boolean }
  /** The hovered element changed; `null` when the pointer left every element. */
  | { readonly type: 'hover'; readonly target: HoverInfo | null };

/** Mouse cursor to show over the surface. */
export type Cursor = 'default' | 'pointer' | 'grab';

/** Input to the reducer; positions are in view coordinates, deltas in CSS pixels. */
export type LanesInput =
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
  /** Show a lane in a mode. */
  | { readonly type: 'laneMode'; readonly lane: number; readonly mode: LaneMode }
  /** Show every collapsed lane as capped. */
  | { readonly type: 'expandAll' }
  /** Collapse every lane. */
  | { readonly type: 'collapseAll' }
  /** Bring a span (table row) into view: expand its lane if needed, scroll to it, pan to it. */
  | { readonly type: 'reveal'; readonly row: number; readonly align: 'nearest' | 'center' }
  /** The layout changed (view size): fit the camera and the scroll position to it. */
  | { readonly type: 'resize' };

/** What decides how the lanes are stacked; the reducer rebuilds the stack from it when a mode changes. */
export interface StackSpec {
  readonly model: LaneModel;
  readonly layout: LanesLayout;
  /** Lane ids in display order. */
  readonly order: Int32Array;
  /** Whether peer lanes are shown. */
  readonly showPeers: boolean;
}

/** What the reducer reads besides the state. */
export interface InteractionContext extends StackSpec {
  /** The last frame plan: picking goes through it. */
  readonly plan: LanesFramePlan;
  /** The spans that passed the filter, or `null`. */
  readonly matched: SpanMask | null;
  /** Table row of the primary selected span, or -1. */
  readonly selectedRow: number;
  /** The selection, for zooming to it; `null` for none. */
  readonly selection: SelectionMasks | null;
  /** Plain wheel zooms instead of scrolling the lanes. */
  readonly wheelZoom: boolean;
}

/** The outcome of one input. */
export interface InteractionResult {
  readonly state: ViewState;
  /** OR of {@link LanesDirty} bits. */
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
  if (hover === null) return 'default';
  switch (hover.part) {
    case HitPart.None:
    case HitPart.Ruler:
      return 'default';
    case HitPart.IdleGap:
      return 'grab';
    default:
      return 'pointer';
  }
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

/** A state looking at the whole trace from the top, every lane capped. */
export function initialViewState(spec: StackSpec): ViewState {
  const { model, layout } = spec;
  const modes = new Uint8Array(model.laneCount).fill(LaneMode.Capped);
  return {
    camera: createCamera(model.index.table.extentMs, layout.plotWidth),
    scrollTop: 0,
    hover: null,
    stack: stackLanes(model, layout, spec.order, spec.showPeers, modes),
    focusItem: -1,
  };
}

/** Bring a state in line with a new layout: the camera takes the new plot width and the scroll position is clamped. */
export function fitViewState(state: ViewState, layout: LanesLayout): ViewState {
  const camera = state.camera.widthPx === layout.plotWidth ? state.camera : { ...state.camera, widthPx: layout.plotWidth };
  const scrollTop = clampScroll(layout, state.stack, state.scrollTop);
  return camera === state.camera && scrollTop === state.scrollTop ? state : { ...state, camera, scrollTop };
}

/**
 * The scroll position that keeps a lane where it was on screen after the stack changed.
 *
 * @param before - The stack as it was.
 * @param after - The stack now; both must belong to the same model.
 * @param layout - Geometry, for the scroll limits.
 * @param scrollTop - Scroll position before the change.
 * @param anchorLane - The lane to keep still, or -1 for the lane at the top of the viewport. An anchor that is scrolled out of view does not count: the lane at the top of the viewport is kept instead. When the anchor is not shown in both stacks only the clamping applies.
 */
export function anchoredScrollTop(before: LaneStack, after: LaneStack, layout: LanesLayout, scrollTop: number, anchorLane = -1): number {
  let k = anchorLane >= 0 ? before.positionOfLane[anchorLane] : -1;
  if (k >= 0 && (before.top[k + 1] <= scrollTop || before.top[k] >= scrollTop + layout.bodyHeight)) k = -1;
  if (k < 0) k = laneAt(before, scrollTop);
  const lane = k >= 0 ? before.lane[k] : -1;
  const kAfter = lane >= 0 ? after.positionOfLane[lane] : -1;
  if (k < 0 || kAfter < 0) return clampScroll(layout, after, scrollTop);
  return clampScroll(layout, after, after.top[kAfter] + Math.min(scrollTop - before.top[k], laneHeight(after, kAfter)));
}

/**
 * Rebuild the stack of a state for other modes (or another order, peer flag or layout), keeping the
 * anchor lane still on screen. The hover is dropped, as its lanes may have moved.
 */
export function restack(state: ViewState, spec: StackSpec, modes: Uint8Array, anchorLane = -1): ViewState {
  const stack = stackLanes(spec.model, spec.layout, spec.order, spec.showPeers, modes);
  const scrollTop = anchoredScrollTop(state.stack, stack, spec.layout, state.scrollTop, anchorLane);
  return { ...state, stack, scrollTop, hover: null };
}

/**
 * Pan the window, without zooming, so that an interval is in view. Nothing changes while it overlaps
 * the window; otherwise an interval shorter than the window is centred and a longer one starts a tenth
 * of the way in.
 */
export function revealTime(camera: Camera1D, start: number, end: number): Camera1D {
  if (end > camera.t0 && start < camera.t1) return camera;
  const length = camera.t1 - camera.t0;
  const t0 = end - start < length ? (start + end) / 2 - length / 2 : start - REVEAL_LEAD * length;
  return withWindow(camera, t0, t0 + length);
}

/** The window that shows an interval with a little room around it. */
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
  return same ? outcome(state, 0, true) : outcome({ ...state, camera }, LanesDirty.Camera, true);
}

function zoomAroundCentre(state: ViewState, factor: number): InteractionResult {
  const { camera } = state;
  return withCamera(state, zoomAt(camera, (camera.t0 + camera.t1) / 2, factor));
}

function wholeTrace(state: ViewState): InteractionResult {
  const { camera } = state;
  return withCamera(state, createCamera(camera.total, camera.widthPx));
}

function zoomToInterval(state: ViewState, start: number, end: number): InteractionResult {
  const { t0, t1 } = windowForSpan(start, end);
  return withCamera(state, withWindow(state.camera, t0, t1));
}

/** Whether two hovers are the same element (for the parts that depend on the pointer position, the same pixel column). */
function sameHover(a: HoverInfo | null, b: HoverInfo | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.part !== b.part || a.lane !== b.lane) return false;
  switch (a.part) {
    case HitPart.Bar:
    case HitPart.Run:
      return a.item === b.item && a.count === b.count;
    case HitPart.IdleGap:
      return a.gapFrom === b.gapFrom && a.gapTo === b.gapTo;
    case HitPart.Summary:
    case HitPart.Overflow:
      return a.x === b.x && a.t === b.t;
    default:
      return true;
  }
}

function hitAt(ctx: InteractionContext, x: number, y: number): HitResult {
  return hitTest(ctx.plan, x, y, scratchHit);
}

/** The state with the lanes shown in `modes`, as an outcome; the anchor lane stays where it is on screen. */
function withModes(state: ViewState, ctx: InteractionContext, modes: Uint8Array, anchorLane: number): InteractionResult {
  let changed = false;
  for (let l = 0; l < modes.length; l++) {
    if (modes[l] !== state.stack.modes[l]) {
      changed = true;
      break;
    }
  }
  if (!changed) return outcome(state, 0, true);

  const next = restack(state, ctx, modes, anchorLane);
  const scrolled = next.scrollTop !== state.scrollTop;
  const effects: readonly Effect[] = state.hover === null ? NO_EFFECTS : [{ type: 'hover', target: null }];
  return outcome(next, LanesDirty.Lanes | (scrolled ? LanesDirty.Scroll : 0) | (state.hover === null ? 0 : LanesDirty.Hover), true, effects, scrolled);
}

function setLaneMode(state: ViewState, ctx: InteractionContext, lane: number, mode: LaneMode): InteractionResult {
  if (!(lane >= 0 && lane < state.stack.modes.length)) return outcome(state, 0, true);
  const modes = state.stack.modes.slice();
  modes[lane] = mode;
  return withModes(state, ctx, modes, lane);
}

/** Collapse a lane that is shown, show a collapsed one as capped. */
function toggleLane(state: ViewState, ctx: InteractionContext, lane: number): InteractionResult {
  const collapsed = state.stack.modes[lane] === LaneMode.Collapsed;
  return setLaneMode(state, ctx, lane, collapsed ? LaneMode.Capped : LaneMode.Collapsed);
}

function setAllModes(state: ViewState, ctx: InteractionContext, expand: boolean): InteractionResult {
  const modes = state.stack.modes.slice();
  for (let l = 0; l < modes.length; l++) {
    if (!expand) modes[l] = LaneMode.Collapsed;
    else if (modes[l] === LaneMode.Collapsed) modes[l] = LaneMode.Capped;
  }
  return withModes(state, ctx, modes, -1);
}

/** The item the keyboard cursor is on: the focus item while it belongs to the selected span, else the span's own item; -1 for no selection. */
function currentItem(state: ViewState, ctx: InteractionContext): number {
  const row = ctx.selectedRow;
  if (row < 0 || row >= ctx.model.itemOfRow.length) return -1;
  const focus = state.focusItem;
  return focus >= 0 && ctx.model.itemRow[focus] === row ? focus : ctx.model.itemOfRow[row];
}

/** What {@link revealItem} did. */
interface Revealed {
  readonly state: ViewState;
  readonly dirty: number;
  readonly scrollTo: boolean;
  /** The item that is now in view: the given one, or the span's own when its ghost lane is hidden. */
  readonly item: number;
}

/**
 * Make an item visible: show its lane in a mode that has its level, scroll its row into view and pan
 * the window to it. A ghost on a hidden peer lane falls back to the span's own item.
 */
function revealItem(state: ViewState, ctx: InteractionContext, item: number, align: 'nearest' | 'center'): Revealed {
  const { model, layout } = ctx;
  let current = item;
  let track = trackOfItem(model, current);
  let lane = laneOfTrack(model, track);
  if (state.stack.positionOfLane[lane] < 0) {
    current = model.itemOfRow[model.itemRow[item]];
    track = trackOfItem(model, current);
    lane = laneOfTrack(model, track);
  }
  const level = track - model.laneTrackOff[lane];

  let next = state;
  let dirty = 0;
  const mode = state.stack.modes[lane] as LaneMode;
  const needed = mode === LaneMode.Collapsed ? (level < layout.maxRows ? LaneMode.Capped : LaneMode.Full) : mode === LaneMode.Capped && level >= layout.maxRows ? LaneMode.Full : mode;
  if (needed !== mode && state.stack.positionOfLane[lane] >= 0) {
    const modes = state.stack.modes.slice();
    modes[lane] = needed;
    next = restack(state, ctx, modes, lane);
    dirty |= LanesDirty.Lanes;
  }

  const k = next.stack.positionOfLane[lane];
  let scrollTop = next.scrollTop;
  if (k >= 0) scrollTop = scrollToRange(layout, next.stack, scrollTop, levelTop(next.stack, layout, k, level), layout.rowHeight, align);
  const camera = revealTime(next.camera, model.itemStart[current], model.itemEnd[current]);
  if (scrollTop !== next.scrollTop) dirty |= LanesDirty.Scroll;
  if (camera !== next.camera) dirty |= LanesDirty.Camera;
  if (scrollTop !== next.scrollTop || camera !== next.camera) next = { ...next, scrollTop, camera };
  return { state: next, dirty, scrollTo: scrollTop !== state.scrollTop, item: current };
}

/** Select the span of an item, with the item revealed and the keyboard cursor on it. */
function selectItem(state: ViewState, ctx: InteractionContext, item: number): InteractionResult {
  const row = ctx.model.itemRow[item];
  const revealed = revealItem(state, ctx, item, 'nearest');
  const next = revealed.state.focusItem === revealed.item ? revealed.state : { ...revealed.state, focusItem: revealed.item };
  return outcome(next, revealed.dirty, true, [{ type: 'select', rows: [row], primary: row, additive: false }], revealed.scrollTo);
}

/** The first item at or after the window start on the first track of the first expanded lane in view, or -1. */
function firstItemInView(state: ViewState, ctx: InteractionContext): number {
  const { model } = ctx;
  const { stack } = state;
  for (let p = Math.max(0, laneAt(stack, state.scrollTop)); p < stack.count; p++) {
    if (stack.mode[p] === LaneMode.Collapsed) continue;
    const track = model.laneTrackOff[stack.lane[p]];
    const from = model.trackItemOff[track];
    const to = model.trackItemOff[track + 1];
    if (from >= to) continue;
    const item = lowerBound(model.itemEnd, from, to, state.camera.t0);
    return item < to ? item : from;
  }
  return -1;
}

function handleKey(state: ViewState, input: Extract<LanesInput, { type: 'key' }>, ctx: InteractionContext): InteractionResult {
  if (input.ctrl || input.alt) return outcome(state, 0, false);
  const { model } = ctx;
  const table = model.index.table;

  switch (input.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const item = currentItem(state, ctx);
      if (item < 0) {
        const start = firstItemInView(state, ctx);
        return start < 0 ? outcome(state, 0, true) : selectItem(state, ctx, start);
      }
      const track = trackOfItem(model, item);
      const next = item + (input.key === 'ArrowLeft' ? -1 : 1);
      if (next < model.trackItemOff[track] || next >= model.trackItemOff[track + 1]) return outcome(state, 0, true);
      return selectItem(state, ctx, next);
    }
    case 'ArrowUp': {
      const row = ctx.selectedRow;
      if (row < 0) return outcome(state, 0, true);
      const parent = table.parent[row];
      return parent < 0 ? outcome(state, 0, true) : selectItem(state, ctx, model.itemOfRow[parent]);
    }
    case 'ArrowDown': {
      const row = ctx.selectedRow;
      if (row < 0 || table.subtreeEnd[row] <= row + 1) return outcome(state, 0, true);
      return selectItem(state, ctx, model.itemOfRow[row + 1]);
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
    case 'f':
    case 'F': {
      if (ctx.selection !== null && ctx.selection.count > 0) return zoomToInterval(state, ctx.selection.start, ctx.selection.end);
      return outcome(state, 0, true);
    }
    case 'Enter':
    case ' ': {
      const item = currentItem(state, ctx);
      if (item < 0) return outcome(state, 0, input.key === ' ');
      return toggleLane(state, ctx, laneOfTrack(model, trackOfItem(model, item)));
    }
    case 'e':
    case 'E':
      return setAllModes(state, ctx, true);
    case 'g':
    case 'G':
      return setAllModes(state, ctx, false);
    case 'PageUp':
    case 'PageDown': {
      const page = ctx.layout.bodyHeight;
      const scrollTop = clampScroll(ctx.layout, state.stack, state.scrollTop + (input.key === 'PageUp' ? -page : page));
      if (scrollTop === state.scrollTop) return outcome(state, 0, true);
      return outcome({ ...state, scrollTop }, LanesDirty.Scroll, true, NO_EFFECTS, true);
    }
    default:
      return outcome(state, 0, false);
  }
}

/** Index of `row` among the items of a run, for the keyboard cursor. */
function focusOfRun(ctx: InteractionContext, hit: HitResult, primary: number): number {
  for (let i = hit.item; i < hit.item + hit.count; i++) if (ctx.model.itemRow[i] === primary) return i;
  return hit.item;
}

function handleClick(state: ViewState, input: Extract<LanesInput, { type: 'click' }>, ctx: InteractionContext): InteractionResult {
  const hit = hitAt(ctx, input.x, input.y);
  switch (hit.part) {
    case HitPart.Header:
      return toggleLane(state, ctx, hit.lane);
    case HitPart.Overflow:
      return setLaneMode(state, ctx, hit.lane, LaneMode.Full);
    case HitPart.Bar: {
      const next = { ...state, focusItem: hit.item };
      return outcome(next, 0, true, [{ type: 'select', rows: [hit.row], primary: hit.row, additive: input.additive }]);
    }
    case HitPart.Run: {
      const { rows, primary } = rowsOfRun(ctx.plan, hit.run);
      const next = { ...state, focusItem: focusOfRun(ctx, hit, primary) };
      const key = `run:${hit.item}:${hit.count}`;
      return outcome(next, 0, true, [{ type: 'select', rows, primary, key, additive: input.additive }]);
    }
    case HitPart.Summary: {
      const scale = pxPerMs(state.camera);
      const { rows, primary } = rowsInFlight(ctx.plan, hit.lane, hit.t, ctx.matched, scale > 0 ? 1 / scale : 0);
      if (rows.length === 0) return outcome(state, 0, true);
      const key = `summary:${hit.lane}:${hit.t.toFixed(3)}`;
      return outcome(state, 0, true, [{ type: 'select', rows, primary, key, additive: input.additive }]);
    }
    default:
      return outcome(state, 0, false);
  }
}

function handleDoubleClick(state: ViewState, input: Extract<LanesInput, { type: 'doubleClick' }>, ctx: InteractionContext): InteractionResult {
  const hit = hitAt(ctx, input.x, input.y);
  const { model } = ctx;
  switch (hit.part) {
    case HitPart.Header:
    case HitPart.Overflow:
      return outcome(state, 0, true);
    case HitPart.Bar:
    case HitPart.Run:
      return zoomToInterval(state, model.itemStart[hit.item], model.itemEnd[hit.item + hit.count - 1]);
    case HitPart.IdleGap:
      return zoomToInterval(state, hit.gapFrom, hit.gapTo);
    default:
      return wholeTrace(state);
  }
}

function handleHover(state: ViewState, input: Extract<LanesInput, { type: 'hover' }>, ctx: InteractionContext): InteractionResult {
  const hit = hitAt(ctx, input.x, input.y);
  const next: HoverInfo | null = hit.part === HitPart.None || hit.part === HitPart.Ruler ? null : { ...hit };
  if (sameHover(state.hover, next)) return outcome(state, 0, false);
  return outcome({ ...state, hover: next }, LanesDirty.Hover, false, [{ type: 'hover', target: next }]);
}

function handleWheel(state: ViewState, input: Extract<LanesInput, { type: 'wheel' }>, ctx: InteractionContext): InteractionResult {
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
 * @param ctx - The model, last plan and shared state the input is interpreted against.
 */
export function reduceInteraction(state: ViewState, input: LanesInput, ctx: InteractionContext): InteractionResult {
  switch (input.type) {
    case 'scroll': {
      const scrollTop = clampScroll(ctx.layout, state.stack, input.top);
      return scrollTop === state.scrollTop ? outcome(state, 0, false) : outcome({ ...state, scrollTop }, LanesDirty.Scroll, false);
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
        : outcome({ ...state, hover: null }, LanesDirty.Hover, false, [{ type: 'hover', target: null }]);
    case 'key':
      return handleKey(state, input, ctx);
    case 'zoomBy':
      return zoomAroundCentre(state, input.factor);
    case 'reset':
      return wholeTrace(state);
    case 'laneMode':
      return setLaneMode(state, ctx, input.lane, input.mode);
    case 'expandAll':
      return setAllModes(state, ctx, true);
    case 'collapseAll':
      return setAllModes(state, ctx, false);
    case 'reveal': {
      if (!(input.row >= 0 && input.row < ctx.model.itemOfRow.length)) return outcome(state, 0, false);
      const focus = state.focusItem >= 0 && ctx.model.itemRow[state.focusItem] === input.row ? state.focusItem : ctx.model.itemOfRow[input.row];
      const revealed = revealItem(state, ctx, focus, input.align);
      return outcome(revealed.state, revealed.dirty, false, NO_EFFECTS, revealed.scrollTo);
    }
    case 'resize': {
      const next = fitViewState(state, ctx.layout);
      return outcome(next, LanesDirty.Size | LanesDirty.Camera | LanesDirty.Scroll, false, NO_EFFECTS, next.scrollTop !== state.scrollTop);
    }
  }
}
