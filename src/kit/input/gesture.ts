/**
 * Kit input: gesture reducer
 *
 * The pointer state machine, pure: `reduceGesture(state, event)` returns the
 * next state and the actions to report, and touches nothing else. A press that
 * is released without moving is a click; one that moves {@link PAN_SLOP_PX} or
 * more becomes a drag, which reports how far the content moved until the
 * pointer is released; a second finger turns the drag into a pinch that zooms
 * around the midpoint while the midpoint pans.
 *
 * ```
 *   Idle ──down──▶ Pressed ──move ≥ 3 px──▶ Panning ──up──▶ Idle   (PanEnd)
 *                    │  └──up──▶ Idle   (Click)             │
 *                    │                                      │
 *                    └───── second pointer down ────▶ Pinching ──a pointer up──▶ Ended ──all up──▶ Idle
 * ```
 *
 * `Ended` waits for the finger left over from a pinch to lift, so lifting a
 * pinch does not turn into a click or a drag. Pointers other than the one or two
 * that drive the gesture are remembered only to wait for their release, and
 * never produce actions. Only the primary button (or a touch or pen contact)
 * starts a gesture. Safari's `gesture*` events, which it sends for a trackpad
 * pinch and, redundantly, for a two-finger touch pinch, are accepted only while
 * no pointer gesture runs, so a pinch is never zoomed twice.
 */

import {
  GestureEventKind,
  InputActionKind,
  type DoubleClickEvent,
  type GestureEvent,
  type InputAction,
  type Modifiers,
  type PointerDownEvent,
  type PointerMoveEvent,
  type PointerUpEvent,
  type SafariGestureEvent,
} from './types.ts';

/** How far, px, a pointer must move from where it went down before the press becomes a drag. */
export const PAN_SLOP_PX = 3;

/** Where the gesture is. */
export enum GesturePhase {
  /** No pointer is down (a Safari gesture may be running). */
  Idle,
  /** One pointer is down and has not moved {@link PAN_SLOP_PX} yet. */
  Pressed,
  /** One pointer is dragging. */
  Panning,
  /** Two pointers are down. */
  Pinching,
  /** The gesture is over, but a pointer that belonged to it is still down. */
  Ended,
}

/** A pointer that is down, with its last position. */
export interface Contact {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** No pointer is down. */
export interface IdleState {
  readonly phase: GesturePhase.Idle;
  /** Safari gesture scale at the last report; 0 when no Safari gesture is running. */
  readonly safariScale: number;
}

/** One pointer went down and has not moved far yet. */
export interface PressedState {
  readonly phase: GesturePhase.Pressed;
  readonly pointer: Contact;
  /** Where it went down, for the drag threshold. */
  readonly originX: number;
  readonly originY: number;
}

/** One pointer is dragging; `pointer` is where the last `Pan` was reported. */
export interface PanningState {
  readonly phase: GesturePhase.Panning;
  readonly pointer: Contact;
}

/** Two pointers are down; `first` and `second` are their positions at the last report. */
export interface PinchingState {
  readonly phase: GesturePhase.Pinching;
  readonly first: Contact;
  readonly second: Contact;
  /** Pointers that went down after the two and are only waited for. */
  readonly ignored: readonly number[];
}

/** The gesture ended; these pointers are still down and are waited for. Never empty. */
export interface EndedState {
  readonly phase: GesturePhase.Ended;
  readonly ignored: readonly number[];
}

/** The state of the gesture machine; start from {@link IDLE_GESTURE_STATE}. */
export type GestureState = IdleState | PressedState | PanningState | PinchingState | EndedState;

/** What one event did: the next state and the actions to report, in order. */
export interface GestureStep {
  readonly state: GestureState;
  readonly actions: readonly InputAction[];
}

/** The state before any event. */
export const IDLE_GESTURE_STATE: IdleState = Object.freeze<IdleState>({ phase: GesturePhase.Idle, safariScale: 0 });

const NO_ACTIONS: readonly InputAction[] = Object.freeze([]);
const NOBODY: readonly number[] = Object.freeze([]);

function unchanged(state: GestureState): GestureStep {
  return { state, actions: NO_ACTIONS };
}

function moveTo(state: GestureState, actions: readonly InputAction[] = NO_ACTIONS): GestureStep {
  return { state, actions };
}

function modifiersOf(event: Modifiers): Modifiers {
  return { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey };
}

function without(ids: readonly number[], id: number): readonly number[] {
  const rest = ids.filter((other) => other !== id);
  return rest.length === 0 ? NOBODY : rest;
}

/** The two fingers of a pinch as a centre and a distance. */
function pinchOf(first: Contact, second: Contact): { readonly x: number; readonly y: number; readonly distance: number } {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    distance: Math.hypot(first.x - second.x, first.y - second.y),
  };
}

function pointerDown(state: GestureState, event: PointerDownEvent): GestureStep {
  if (event.button !== 0) return unchanged(state);
  const contact: Contact = { id: event.pointerId, x: event.x, y: event.y };

  switch (state.phase) {
    case GesturePhase.Idle:
      if (state.safariScale !== 0) return unchanged(state);
      return moveTo({ phase: GesturePhase.Pressed, pointer: contact, originX: event.x, originY: event.y });

    case GesturePhase.Pressed:
      if (state.pointer.id === contact.id) {
        return moveTo({ phase: GesturePhase.Pressed, pointer: contact, originX: event.x, originY: event.y });
      }
      return startPinch(state.pointer, contact, true);

    case GesturePhase.Panning:
      return state.pointer.id === contact.id ? unchanged(state) : startPinch(state.pointer, contact, false);

    case GesturePhase.Pinching:
      if (contact.id === state.first.id || contact.id === state.second.id || state.ignored.includes(contact.id)) return unchanged(state);
      return moveTo({ ...state, ignored: [...state.ignored, contact.id] });

    case GesturePhase.Ended:
      return state.ignored.includes(contact.id) ? unchanged(state) : moveTo({ phase: GesturePhase.Ended, ignored: [...state.ignored, contact.id] });
  }
}

/** A second pointer joined: the drag, or the press, becomes a pinch. A press has not told the view of a drag yet, so it is told now. */
function startPinch(first: Contact, second: Contact, announce: boolean): GestureStep {
  const centre = pinchOf(first, second);
  const actions: readonly InputAction[] = announce ? [{ kind: InputActionKind.PanStart, x: centre.x, y: centre.y }] : NO_ACTIONS;
  return moveTo({ phase: GesturePhase.Pinching, first, second, ignored: NOBODY }, actions);
}

function pointerMove(state: GestureState, event: PointerMoveEvent): GestureStep {
  switch (state.phase) {
    case GesturePhase.Idle:
      return moveTo(state, [{ kind: InputActionKind.Hover, x: event.x, y: event.y }]);

    case GesturePhase.Pressed: {
      if (event.pointerId !== state.pointer.id) return unchanged(state);
      if (Math.hypot(event.x - state.originX, event.y - state.originY) < PAN_SLOP_PX) return unchanged(state);
      return moveTo({ phase: GesturePhase.Panning, pointer: { id: event.pointerId, x: event.x, y: event.y } }, [
        { kind: InputActionKind.PanStart, x: state.originX, y: state.originY },
        { kind: InputActionKind.Pan, dx: event.x - state.originX, dy: event.y - state.originY },
      ]);
    }

    case GesturePhase.Panning: {
      if (event.pointerId !== state.pointer.id) return unchanged(state);
      const dx = event.x - state.pointer.x;
      const dy = event.y - state.pointer.y;
      if (dx === 0 && dy === 0) return unchanged(state);
      return moveTo({ phase: GesturePhase.Panning, pointer: { id: event.pointerId, x: event.x, y: event.y } }, [
        { kind: InputActionKind.Pan, dx, dy },
      ]);
    }

    case GesturePhase.Pinching: {
      const moved: Contact = { id: event.pointerId, x: event.x, y: event.y };
      let first = state.first;
      let second = state.second;
      if (event.pointerId === first.id) first = moved;
      else if (event.pointerId === second.id) second = moved;
      else return unchanged(state);

      const before = pinchOf(state.first, state.second);
      const after = pinchOf(first, second);
      const actions: InputAction[] = [];
      if (after.x !== before.x || after.y !== before.y) {
        actions.push({ kind: InputActionKind.Pan, dx: after.x - before.x, dy: after.y - before.y });
      }
      if (before.distance > 0 && after.distance > 0) {
        const factor = before.distance / after.distance;
        if (factor !== 1 && Number.isFinite(factor) && factor > 0) {
          actions.push({ kind: InputActionKind.Zoom, x: after.x, y: after.y, factor });
        }
      }
      return moveTo({ ...state, first, second }, actions);
    }

    case GesturePhase.Ended:
      return unchanged(state);
  }
}

/** One of the two pointers of a pinch ended it; the other is waited for. */
function endPinch(state: PinchingState, pointerId: number, cancelled: boolean): GestureStep {
  let rest: Contact;
  if (pointerId === state.first.id) rest = state.second;
  else if (pointerId === state.second.id) rest = state.first;
  else return state.ignored.includes(pointerId) ? moveTo({ ...state, ignored: without(state.ignored, pointerId) }) : unchanged(state);

  return moveTo({ phase: GesturePhase.Ended, ignored: [rest.id, ...state.ignored] }, [{ kind: InputActionKind.PanEnd, cancelled }]);
}

/** A pointer that was only being waited for lifted. */
function release(state: EndedState, pointerId: number): GestureStep {
  if (!state.ignored.includes(pointerId)) return unchanged(state);
  const rest = without(state.ignored, pointerId);
  return moveTo(rest.length === 0 ? IDLE_GESTURE_STATE : { phase: GesturePhase.Ended, ignored: rest });
}

function pointerUp(state: GestureState, event: PointerUpEvent): GestureStep {
  switch (state.phase) {
    case GesturePhase.Idle:
      return unchanged(state);

    case GesturePhase.Pressed:
      if (event.pointerId !== state.pointer.id) return unchanged(state);
      return moveTo(IDLE_GESTURE_STATE, [{ kind: InputActionKind.Click, x: event.x, y: event.y, ...modifiersOf(event) }]);

    case GesturePhase.Panning: {
      if (event.pointerId !== state.pointer.id) return unchanged(state);
      const actions: InputAction[] = [];
      const dx = event.x - state.pointer.x;
      const dy = event.y - state.pointer.y;
      if (dx !== 0 || dy !== 0) actions.push({ kind: InputActionKind.Pan, dx, dy });
      actions.push({ kind: InputActionKind.PanEnd, cancelled: false });
      return moveTo(IDLE_GESTURE_STATE, actions);
    }

    case GesturePhase.Pinching:
      return endPinch(state, event.pointerId, false);

    case GesturePhase.Ended:
      return release(state, event.pointerId);
  }
}

function pointerCancel(state: GestureState, pointerId: number): GestureStep {
  switch (state.phase) {
    case GesturePhase.Idle:
      return unchanged(state);

    case GesturePhase.Pressed:
      return pointerId === state.pointer.id ? moveTo(IDLE_GESTURE_STATE) : unchanged(state);

    case GesturePhase.Panning:
      if (pointerId !== state.pointer.id) return unchanged(state);
      return moveTo(IDLE_GESTURE_STATE, [{ kind: InputActionKind.PanEnd, cancelled: true }]);

    case GesturePhase.Pinching:
      return endPinch(state, pointerId, true);

    case GesturePhase.Ended:
      return release(state, pointerId);
  }
}

function pointerLeave(state: GestureState, pointerId: number): GestureStep {
  switch (state.phase) {
    case GesturePhase.Idle:
      return moveTo(state, [{ kind: InputActionKind.HoverEnd }]);
    case GesturePhase.Pressed:
      return pointerId === state.pointer.id ? moveTo(IDLE_GESTURE_STATE) : unchanged(state);
    default:
      return unchanged(state);
  }
}

function doubleClick(state: GestureState, event: DoubleClickEvent): GestureStep {
  if (state.phase !== GesturePhase.Idle) return unchanged(state);
  return moveTo(state, [{ kind: InputActionKind.DoubleClick, x: event.x, y: event.y, ...modifiersOf(event) }]);
}

function safariGesture(state: GestureState, event: SafariGestureEvent): GestureStep {
  if (state.phase !== GesturePhase.Idle) return unchanged(state);

  switch (event.kind) {
    case GestureEventKind.SafariGestureStart:
      return state.safariScale === 0 ? moveTo({ phase: GesturePhase.Idle, safariScale: 1 }) : unchanged(state);

    case GestureEventKind.SafariGestureChange: {
      if (state.safariScale === 0 || !(event.scale > 0 && event.scale < Infinity)) return unchanged(state);
      const factor = state.safariScale / event.scale;
      const actions: readonly InputAction[] =
        factor !== 1 && Number.isFinite(factor) && factor > 0 ? [{ kind: InputActionKind.Zoom, x: event.x, y: event.y, factor }] : NO_ACTIONS;
      return moveTo({ phase: GesturePhase.Idle, safariScale: event.scale }, actions);
    }

    case GestureEventKind.SafariGestureEnd:
      return state.safariScale === 0 ? unchanged(state) : moveTo(IDLE_GESTURE_STATE);
  }
}

/**
 * Advance the gesture machine by one event. Pure: the state is never changed
 * (a new one is returned) and nothing outside the arguments is read.
 *
 * @param state - The current state; start from {@link IDLE_GESTURE_STATE}.
 * @param event - What happened, in the bound element's coordinates.
 * @returns The next state and the actions to report, in order.
 */
export function reduceGesture(state: GestureState, event: GestureEvent): GestureStep {
  switch (event.kind) {
    case GestureEventKind.PointerDown:
      return pointerDown(state, event);
    case GestureEventKind.PointerMove:
      return pointerMove(state, event);
    case GestureEventKind.PointerUp:
      return pointerUp(state, event);
    case GestureEventKind.PointerCancel:
      return pointerCancel(state, event.pointerId);
    case GestureEventKind.PointerLeave:
      return pointerLeave(state, event.pointerId);
    case GestureEventKind.DoubleClick:
      return doubleClick(state, event);
    case GestureEventKind.SafariGestureStart:
    case GestureEventKind.SafariGestureChange:
    case GestureEventKind.SafariGestureEnd:
      return safariGesture(state, event);
  }
}
