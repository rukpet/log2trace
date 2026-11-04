/**
 * Kit input: DOM binding
 *
 * The thin layer between an element and the pure parts: it listens for pointer,
 * wheel, Safari gesture and key events on the element, turns each into plain
 * data in the element's own coordinates, feeds the pointer ones to the gesture
 * reducer, and reports the resulting actions to one callback. All decisions live
 * in `gesture.ts` and `normalize.ts`; what is left here is what only a DOM can
 * do:
 *
 * - a press on the element's native scrollbar is left alone, so the scrollbar
 *   drags as usual instead of starting a pan;
 * - a key that comes from an `input`, `textarea`, `select` or `contenteditable`
 *   (found through `composedPath()`, because events from inside a shadow root
 *   are retargeted to the host) belongs to that field and is ignored, as are key
 *   chords with Ctrl, Alt or Meta and every key a view does not handle;
 * - the pointer is captured when a drag begins, so the drag follows it outside
 *   the element;
 * - the default action of an event is prevented only when the callback did not
 *   answer `false`: a ctrl+wheel must not also zoom the page, an arrow key must
 *   not also scroll it. Pointer presses are never prevented, so the element
 *   still takes focus.
 *
 * For these to work the element needs `touch-action: pan-y` (the native scroller
 * keeps vertical touch scrolling while horizontal drags and pinches reach this
 * code) and, to avoid selecting text while dragging, `user-select: none`; both
 * are the element's CSS, not set here. `wheel` and Safari `gesture*` listeners are
 * registered non-passive, because they must be able to prevent the browser's page
 * zoom.
 */

import { IDLE_GESTURE_STATE, GesturePhase, reduceGesture, type GestureState } from './gesture.ts';
import { interpretWheel, isFormField, normalizeKey } from './normalize.ts';
import { GestureEventKind, InputActionKind, type GestureEvent, type InputAction, type Modifiers } from './types.ts';

/** What the binding needs of its element; any `HTMLElement` satisfies it. */
export interface InputTarget {
  /** Listen for events of a type. */
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  /** Stop listening: the registration is found by its type and listener. */
  removeEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  /** Where the element's border box is in the viewport; only the top left is used. */
  getBoundingClientRect(): { readonly left: number; readonly top: number };
  /** Width in px of the left border, plus a scrollbar drawn on the left. */
  readonly clientLeft: number;
  /** Width in px of the top border. */
  readonly clientTop: number;
  /** Width in px of the padding box without a vertical scrollbar. */
  readonly clientWidth: number;
  /** Height in px of the padding box without a horizontal scrollbar. */
  readonly clientHeight: number;
  /** Keep delivering a pointer's events to the element until it is released. */
  setPointerCapture(pointerId: number): void;
  /** Give a captured pointer back. */
  releasePointerCapture(pointerId: number): void;
}

/** Options for {@link bindInput}. */
export interface InputBindingOptions {
  /**
   * Receives every action, in order. Answer `false` for an action the view did
   * not handle, so that the browser keeps its default for the event behind it
   * (only wheel, key and gesture actions have one); any other answer, or none,
   * counts as handled. An exception it throws does not stop the remaining
   * actions of the same event; the first one is rethrown afterwards.
   */
  readonly onAction: (action: InputAction) => boolean | void;
  /** Whether a plain wheel zooms instead of scrolling; read on every event, so it can change at any time. Default: it does not. */
  readonly wheelZoom?: () => boolean;
  /** Height in px of a page, for wheels that report pages; default: the element's `clientHeight`. */
  readonly pageSizePx?: () => number;
}

/** What Safari's non-standard `GestureEvent` carries. */
interface SafariGestureLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly scale: number;
  preventDefault(): void;
}

function modifiersOf(event: Modifiers): Modifiers {
  return { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey };
}

function sameNode(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * Listen for input on an element and report it as plain actions.
 *
 * @param target - The element: usually the view's scroller, which is focusable (`tabindex`).
 * @param options - Where actions go, and how wheels are read.
 * @returns A function that removes every listener and releases pointer capture.
 */
export function bindInput(target: InputTarget, options: InputBindingOptions): () => void {
  let state: GestureState = IDLE_GESTURE_STATE;
  let disposed = false;
  const captured = new Set<number>();
  const bound: Array<{ readonly type: string; readonly listener: (event: Event) => void; readonly options?: AddEventListenerOptions }> = [];

  function listen(type: string, listener: (event: Event) => void, listenerOptions?: AddEventListenerOptions): void {
    target.addEventListener(type, listener, listenerOptions);
    bound.push({ type, listener, options: listenerOptions });
  }

  /** A client position in the element's frame: the padding box's top left is 0, 0. */
  function point(clientX: number, clientY: number): { readonly x: number; readonly y: number } {
    const rect = target.getBoundingClientRect();
    return { x: clientX - rect.left - target.clientLeft, y: clientY - rect.top - target.clientTop };
  }

  function capture(pointerId: number): void {
    if (captured.has(pointerId)) return;
    try {
      target.setPointerCapture(pointerId);
      captured.add(pointerId);
    } catch {
      // The pointer is already gone (or the event was synthetic): there is nothing to capture.
    }
  }

  /** Run the reducer and report what came out, taking pointer capture when a drag starts. */
  function feed(event: GestureEvent, pointerId?: number): void {
    const step = reduceGesture(state, event);
    state = step.state;

    let failure: { error: unknown } | null = null;
    for (const action of step.actions) {
      try {
        if (action.kind === InputActionKind.PanStart && pointerId !== undefined) capture(pointerId);
        options.onAction(action);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== null) throw failure.error;
  }

  /** Whether a press landed on the element's own scrollbar or border rather than its content. */
  function isScrollbarPress(event: PointerEvent): boolean {
    if (!sameNode(event.target, target)) return false;
    const p = point(event.clientX, event.clientY);
    return p.x < 0 || p.y < 0 || p.x >= target.clientWidth || p.y >= target.clientHeight;
  }

  function onPointerDown(event: PointerEvent): void {
    if (isScrollbarPress(event)) return;
    const p = point(event.clientX, event.clientY);
    feed(
      { kind: GestureEventKind.PointerDown, pointerId: event.pointerId, x: p.x, y: p.y, button: event.button, ...modifiersOf(event) },
      event.pointerId,
    );
  }

  function onPointerMove(event: PointerEvent): void {
    const p = point(event.clientX, event.clientY);
    feed({ kind: GestureEventKind.PointerMove, pointerId: event.pointerId, x: p.x, y: p.y }, event.pointerId);
  }

  function onPointerUp(event: PointerEvent): void {
    const p = point(event.clientX, event.clientY);
    try {
      feed({ kind: GestureEventKind.PointerUp, pointerId: event.pointerId, x: p.x, y: p.y, ...modifiersOf(event) });
    } finally {
      captured.delete(event.pointerId);
    }
  }

  function onPointerCancel(event: PointerEvent): void {
    try {
      feed({ kind: GestureEventKind.PointerCancel, pointerId: event.pointerId });
    } finally {
      captured.delete(event.pointerId);
    }
  }

  /** Capture lost while we still held it (not through a release at the end of a gesture): the gesture is over. */
  function onLostPointerCapture(event: PointerEvent): void {
    if (captured.delete(event.pointerId)) feed({ kind: GestureEventKind.PointerCancel, pointerId: event.pointerId });
  }

  function onDoubleClick(event: MouseEvent): void {
    const p = point(event.clientX, event.clientY);
    feed({ kind: GestureEventKind.DoubleClick, x: p.x, y: p.y, ...modifiersOf(event) });
  }

  function onWheel(event: WheelEvent): void {
    const p = point(event.clientX, event.clientY);
    const action = interpretWheel(
      { x: p.x, y: p.y, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, ...modifiersOf(event) },
      { pageSizePx: options.pageSizePx?.() ?? target.clientHeight, wheelZoom: options.wheelZoom?.() ?? false },
    );
    if (action !== null && options.onAction(action) !== false) event.preventDefault();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    if (isFormField(event.composedPath?.()[0] ?? event.target)) return;
    const key = normalizeKey(event);
    if (key !== null && options.onAction({ kind: InputActionKind.KeyDown, ...key }) !== false) event.preventDefault();
  }

  function safariGesture(kind: GestureEventKind.SafariGestureStart | GestureEventKind.SafariGestureChange | GestureEventKind.SafariGestureEnd) {
    return (event: Event): void => {
      const gesture = event as unknown as SafariGestureLike;
      gesture.preventDefault();
      const p = point(gesture.clientX, gesture.clientY);
      feed({ kind, x: p.x, y: p.y, scale: gesture.scale });
    };
  }

  listen('pointerdown', (event) => onPointerDown(event as PointerEvent));
  listen('pointermove', (event) => onPointerMove(event as PointerEvent));
  listen('pointerup', (event) => onPointerUp(event as PointerEvent));
  listen('pointercancel', (event) => onPointerCancel(event as PointerEvent));
  listen('pointerleave', (event) => feed({ kind: GestureEventKind.PointerLeave, pointerId: (event as PointerEvent).pointerId }));
  listen('lostpointercapture', (event) => onLostPointerCapture(event as PointerEvent));
  listen('dblclick', (event) => onDoubleClick(event as MouseEvent));
  listen('wheel', (event) => onWheel(event as WheelEvent), { passive: false });
  listen('keydown', (event) => onKeyDown(event as KeyboardEvent));
  listen('gesturestart', safariGesture(GestureEventKind.SafariGestureStart), { passive: false });
  listen('gesturechange', safariGesture(GestureEventKind.SafariGestureChange), { passive: false });
  listen('gestureend', safariGesture(GestureEventKind.SafariGestureEnd), { passive: false });

  return () => {
    if (disposed) return;
    disposed = true;
    for (const { type, listener, options: listenerOptions } of bound) target.removeEventListener(type, listener, listenerOptions);
    for (const pointerId of captured) {
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // Already released by the browser.
      }
    }
    captured.clear();

    const midGesture = state.phase === GesturePhase.Panning || state.phase === GesturePhase.Pinching;
    state = IDLE_GESTURE_STATE;
    if (midGesture) options.onAction({ kind: InputActionKind.PanEnd, cancelled: true });
  };
}
