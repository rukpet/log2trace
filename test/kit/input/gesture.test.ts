/**
 * The pointer gesture machine: a click is a release without movement, a drag
 * starts at 3 px and reports exactly how far the content moved, a drag can be
 * cancelled, a second finger makes a pinch, lifting a pinch does not click, and
 * Safari's gesture events never double a pinch. The reducer is pure, so the
 * tests feed it events and read actions, with a seeded random walk on top for
 * the invariants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GesturePhase,
  IDLE_GESTURE_STATE,
  PAN_SLOP_PX,
  reduceGesture,
  type GestureState,
  type GestureStep,
} from '../../../src/kit/input/gesture.ts';
import {
  GestureEventKind,
  InputActionKind,
  type GestureEvent,
  type InputAction,
  type Modifiers,
} from '../../../src/kit/input/types.ts';

const NO_MODIFIERS: Modifiers = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

function down(pointerId: number, x: number, y: number, fields: Partial<Modifiers> & { button?: number } = {}): GestureEvent {
  return { kind: GestureEventKind.PointerDown, pointerId, x, y, button: 0, ...NO_MODIFIERS, ...fields };
}

function move(pointerId: number, x: number, y: number): GestureEvent {
  return { kind: GestureEventKind.PointerMove, pointerId, x, y };
}

function up(pointerId: number, x: number, y: number, fields: Partial<Modifiers> = {}): GestureEvent {
  return { kind: GestureEventKind.PointerUp, pointerId, x, y, ...NO_MODIFIERS, ...fields };
}

function cancel(pointerId: number): GestureEvent {
  return { kind: GestureEventKind.PointerCancel, pointerId };
}

function leave(pointerId: number): GestureEvent {
  return { kind: GestureEventKind.PointerLeave, pointerId };
}

function doubleClick(x: number, y: number, fields: Partial<Modifiers> = {}): GestureEvent {
  return { kind: GestureEventKind.DoubleClick, x, y, ...NO_MODIFIERS, ...fields };
}

function safari(kind: GestureEventKind.SafariGestureStart | GestureEventKind.SafariGestureChange | GestureEventKind.SafariGestureEnd, scale: number, x = 50, y = 60): GestureEvent {
  return { kind, x, y, scale };
}

/** Feed events one after another; `actions` is everything reported, in order. */
function run(events: readonly GestureEvent[], from: GestureState = IDLE_GESTURE_STATE): { state: GestureState; actions: InputAction[]; steps: GestureStep[] } {
  let state = from;
  const actions: InputAction[] = [];
  const steps: GestureStep[] = [];
  for (const event of events) {
    const step = reduceGesture(state, event);
    state = step.state;
    actions.push(...step.actions);
    steps.push(step);
  }
  return { state, actions, steps };
}

function kinds(actions: readonly InputAction[]): InputActionKind[] {
  return actions.map((action) => action.kind);
}

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what}: ${actual} vs ${expected}`);
}

test('a press released without moving is a click at the release point', () => {
  const { state, actions } = run([down(1, 10, 20), up(1, 10, 20)]);
  assert.deepEqual(actions, [{ kind: InputActionKind.Click, x: 10, y: 20, ...NO_MODIFIERS }]);
  assert.equal(state.phase, GesturePhase.Idle);
});

test('a click survives jitter below the 3 px threshold and keeps the modifiers of the release', () => {
  const { actions, steps } = run([
    down(1, 100, 100),
    move(1, 101, 101),
    move(1, 102, 100),
    move(1, 98, 99),
    up(1, 102, 101, { ctrlKey: true, shiftKey: true }),
  ]);
  assert.deepEqual(actions, [{ kind: InputActionKind.Click, x: 102, y: 101, shiftKey: true, ctrlKey: true, altKey: false, metaKey: false }]);
  assert.equal(steps[3].state.phase, GesturePhase.Pressed, 'still a press after the jitter');
});

test('a press becomes a drag at exactly 3 px, measured from where it went down, in any direction', () => {
  assert.equal(PAN_SLOP_PX, 3);

  for (const [x, y] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2.2, 2.2], [-2.2, 2.2]] as const) {
    const { actions, state } = run([down(1, 50, 50), move(1, 50 + x, 50 + y)]);
    assert.deepEqual(kinds(actions), [InputActionKind.PanStart, InputActionKind.Pan], `(${x}, ${y})`);
    assert.equal(state.phase, GesturePhase.Panning);
  }
  for (const [x, y] of [[2.99, 0], [0, -2.99], [2, 2], [-1.5, 2.5]] as const) {
    const { actions, state } = run([down(1, 50, 50), move(1, 50 + x, 50 + y)]);
    assert.deepEqual(actions, [], `(${x}, ${y}) is still a press`);
    assert.equal(state.phase, GesturePhase.Pressed);
  }
});

test('a drag reports where it began, then how far the content moved, and ends with the release', () => {
  const { actions, state } = run([
    down(1, 100, 100),
    move(1, 102, 100), // under the threshold: nothing yet
    move(1, 110, 105), // over it: the drag begins and the content catches up with the pointer
    move(1, 112, 105),
    move(1, 112, 105), // no movement: nothing
    up(1, 115, 110),
  ]);
  assert.deepEqual(actions, [
    { kind: InputActionKind.PanStart, x: 100, y: 100 },
    { kind: InputActionKind.Pan, dx: 10, dy: 5 },
    { kind: InputActionKind.Pan, dx: 2, dy: 0 },
    { kind: InputActionKind.Pan, dx: 3, dy: 5 },
    { kind: InputActionKind.PanEnd, cancelled: false },
  ]);
  assert.equal(state.phase, GesturePhase.Idle);
});

test('the pans of a drag add up to the displacement of the pointer, so the content sticks to it', () => {
  const path: Array<[number, number]> = [[100, 100], [103, 99], [140, 120], [90, 130], [60, 60], [61, 59.5], [200, 10]];
  const [[x0, y0], ...rest] = path;
  const last = path[path.length - 1];
  const { actions } = run([down(1, x0, y0), ...rest.slice(0, -1).map(([x, y]) => move(1, x, y)), up(1, last[0], last[1])]);

  let dx = 0;
  let dy = 0;
  for (const action of actions) {
    if (action.kind === InputActionKind.Pan) {
      dx += action.dx;
      dy += action.dy;
    }
  }
  assertClose(dx, last[0] - x0, 'total dx');
  assertClose(dy, last[1] - y0, 'total dy');
});

test('a drag that returns to where it began is still a drag, not a click', () => {
  const { actions } = run([down(1, 100, 100), move(1, 150, 100), move(1, 100, 100), up(1, 100, 100)]);
  assert.ok(!kinds(actions).includes(InputActionKind.Click));
  assert.equal(actions[actions.length - 1].kind, InputActionKind.PanEnd);
});

test('a cancelled drag ends as cancelled and is never a click', () => {
  const { actions, state } = run([down(1, 100, 100), move(1, 150, 100), cancel(1)]);
  assert.deepEqual(actions.slice(2), [{ kind: InputActionKind.PanEnd, cancelled: true }]);
  assert.equal(state.phase, GesturePhase.Idle);
});

test('a press cancelled before it became a drag reports nothing', () => {
  const { actions, state } = run([down(1, 100, 100), move(1, 101, 100), cancel(1)]);
  assert.deepEqual(actions, []);
  assert.equal(state.phase, GesturePhase.Idle);

  assert.deepEqual(run([cancel(1)]).actions, [], 'a cancel with nothing down is ignored');
});

test('leaving the element cancels a press, is ignored mid-drag (the pointer is captured), and ends a hover', () => {
  const pressed = run([down(1, 5, 5), leave(1)]);
  assert.deepEqual(pressed.actions, []);
  assert.equal(pressed.state.phase, GesturePhase.Idle);
  assert.deepEqual(run([down(1, 5, 5), leave(1), up(1, 5, 5)]).actions, [], 'no click after the pointer left');

  const dragging = run([down(1, 5, 5), move(1, 50, 5), leave(1)]);
  assert.equal(dragging.state.phase, GesturePhase.Panning);
  assert.deepEqual(kinds(dragging.actions), [InputActionKind.PanStart, InputActionKind.Pan]);

  assert.deepEqual(run([leave(1)]).actions, [{ kind: InputActionKind.HoverEnd }]);
  assert.deepEqual(run([down(1, 5, 5), leave(2)]).state.phase, GesturePhase.Pressed, 'another pointer leaving does not matter');
});

test('moving with nothing pressed is a hover', () => {
  const { actions, state } = run([move(1, 10, 20), move(1, 12, 22)]);
  assert.deepEqual(actions, [
    { kind: InputActionKind.Hover, x: 10, y: 20 },
    { kind: InputActionKind.Hover, x: 12, y: 22 },
  ]);
  assert.equal(state, IDLE_GESTURE_STATE);
});

test('only the primary button starts a gesture', () => {
  for (const button of [1, 2, 3, 4, 5]) {
    const { actions, state } = run([down(1, 10, 10, { button }), move(1, 100, 100), up(1, 100, 100)]);
    assert.ok(!kinds(actions).some((kind) => kind === InputActionKind.Click || kind === InputActionKind.PanStart), `button ${button}`);
    assert.equal(state.phase, GesturePhase.Idle);
  }
});

test('a pointer that is not the one driving the gesture is ignored', () => {
  const { actions, state } = run([
    down(1, 0, 0),
    move(2, 500, 500),
    up(2, 500, 500),
    cancel(2),
    leave(2),
    move(1, 10, 0),
    up(1, 10, 0),
  ]);
  assert.deepEqual(actions, [
    { kind: InputActionKind.PanStart, x: 0, y: 0 },
    { kind: InputActionKind.Pan, dx: 10, dy: 0 },
    { kind: InputActionKind.PanEnd, cancelled: false },
  ]);
  assert.equal(state.phase, GesturePhase.Idle);
});

test('a double click is reported when nothing is pressed, with its modifiers', () => {
  assert.deepEqual(run([doubleClick(7, 8, { shiftKey: true })]).actions, [
    { kind: InputActionKind.DoubleClick, x: 7, y: 8, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false },
  ]);
  assert.deepEqual(run([down(1, 0, 0), doubleClick(7, 8)]).actions, [], 'not in the middle of a press');
});

test('a second finger turns a press into a pinch, announced at the midpoint', () => {
  const { actions, state } = run([down(1, 100, 100), down(2, 200, 100)]);
  assert.deepEqual(actions, [{ kind: InputActionKind.PanStart, x: 150, y: 100 }]);
  assert.equal(state.phase, GesturePhase.Pinching);
});

test('spreading the fingers zooms in around their midpoint, and moving the midpoint pans', () => {
  const { actions } = run([down(1, 100, 100), down(2, 200, 100), move(2, 300, 100)]);
  assert.deepEqual(actions.slice(1), [
    { kind: InputActionKind.Pan, dx: 50, dy: 0 },
    { kind: InputActionKind.Zoom, x: 200, y: 100, factor: 0.5 },
  ], 'the midpoint went from 150 to 200 and the fingers from 100 to 200 apart: the window halves');

  const pinchIn = run([down(1, 100, 100), down(2, 300, 100), move(2, 200, 100)]);
  const zoom = pinchIn.actions.find((action) => action.kind === InputActionKind.Zoom);
  assert.deepEqual(zoom, { kind: InputActionKind.Zoom, x: 150, y: 100, factor: 2 }, 'bringing them together zooms out');
});

test('moving both fingers together is a pan that zooms by nothing in the end', () => {
  const steps: GestureEvent[] = [down(1, 100, 100), down(2, 200, 100)];
  for (let i = 1; i <= 10; i++) steps.push(move(1, 100 + 5 * i, 100 + 2 * i), move(2, 200 + 5 * i, 100 + 2 * i));
  const { actions } = run(steps);

  let product = 1;
  let dx = 0;
  let dy = 0;
  for (const action of actions) {
    if (action.kind === InputActionKind.Zoom) product *= action.factor;
    if (action.kind === InputActionKind.Pan) {
      dx += action.dx;
      dy += action.dy;
    }
  }
  assertClose(product, 1, 'net zoom');
  assertClose(dx, 50, 'net pan x');
  assertClose(dy, 20, 'net pan y');
});

test('a pinch that starts from a drag carries on without a second announcement and without a jump', () => {
  const { actions, state } = run([down(1, 0, 0), move(1, 50, 0), down(2, 100, 0)]);
  assert.deepEqual(kinds(actions), [InputActionKind.PanStart, InputActionKind.Pan], 'the second finger announces nothing');
  assert.equal(state.phase, GesturePhase.Pinching);

  const next = reduceGesture(state, move(2, 120, 0));
  assert.deepEqual(next.actions, [
    { kind: InputActionKind.Pan, dx: 10, dy: 0 },
    { kind: InputActionKind.Zoom, x: 85, y: 0, factor: 50 / 70 },
  ], 'measured from the midpoint of the two fingers as they were, not from the drag');
});

test('fingers on the same spot pan but cannot zoom, and never divide by zero', () => {
  const { actions } = run([down(1, 10, 10), down(2, 10, 10), move(2, 20, 10), move(2, 10, 10)]);
  assert.deepEqual(actions, [
    { kind: InputActionKind.PanStart, x: 10, y: 10 },
    { kind: InputActionKind.Pan, dx: 5, dy: 0 },
    { kind: InputActionKind.Pan, dx: -5, dy: 0 },
  ]);
});

test('lifting one finger ends the pinch and waits for the other, so there is no click or drag from it', () => {
  const { actions, state } = run([down(1, 100, 100), down(2, 200, 100), up(1, 100, 100)]);
  assert.deepEqual(actions.slice(1), [{ kind: InputActionKind.PanEnd, cancelled: false }]);
  assert.equal(state.phase, GesturePhase.Ended);

  const after = run([move(2, 300, 300), move(2, 400, 400), up(2, 400, 400)], state);
  assert.deepEqual(after.actions, [], 'the remaining finger does nothing: no pan, no click');
  assert.equal(after.state.phase, GesturePhase.Idle);

  const again = run([down(1, 5, 5), up(1, 5, 5)], after.state);
  assert.equal(again.actions[0].kind, InputActionKind.Click, 'and the machine works again afterwards');
});

test('a cancelled pinch ends as cancelled and also waits for the remaining finger', () => {
  const { actions, state } = run([down(1, 100, 100), down(2, 200, 100), cancel(2)]);
  assert.deepEqual(actions.slice(1), [{ kind: InputActionKind.PanEnd, cancelled: true }]);
  assert.equal(state.phase, GesturePhase.Ended);
  assert.equal(run([up(1, 100, 100)], state).state.phase, GesturePhase.Idle);
});

test('a third finger is ignored, and the machine stays busy until it lifts too', () => {
  const pinching = run([down(1, 100, 100), down(2, 200, 100), down(3, 400, 400)]);
  assert.deepEqual(kinds(pinching.actions), [InputActionKind.PanStart], 'no action for the third finger');
  assert.deepEqual(run([move(3, 450, 450), up(3, 450, 450)], pinching.state).actions, [], 'it neither zooms nor ends anything');
  assert.equal(run([up(3, 450, 450)], pinching.state).state.phase, GesturePhase.Pinching, 'the pinch goes on');

  const lifted = run([up(1, 100, 100), up(2, 200, 100)], pinching.state);
  assert.equal(lifted.state.phase, GesturePhase.Ended, 'the third finger is still down');
  assert.equal(run([up(3, 400, 400)], lifted.state).state.phase, GesturePhase.Idle);
});

test('a finger that lands after the gesture ended is waited for too, so its movement is not a hover', () => {
  const { state } = run([down(1, 0, 0), down(2, 10, 0), up(1, 0, 0)]);
  const landed = run([down(3, 50, 50), move(3, 60, 60)], state);
  assert.deepEqual(landed.actions, []);
  assert.equal(run([up(2, 10, 0)], landed.state).state.phase, GesturePhase.Ended, 'finger 3 is still down');
  assert.equal(run([up(2, 10, 0), up(3, 60, 60)], landed.state).state.phase, GesturePhase.Idle);
});

test('Safari gestures zoom by the change of scale since the last report, around the gesture\'s point', () => {
  const { actions, state } = run([
    safari(GestureEventKind.SafariGestureStart, 1),
    safari(GestureEventKind.SafariGestureChange, 1.5, 30, 40),
    safari(GestureEventKind.SafariGestureChange, 3, 31, 41),
    safari(GestureEventKind.SafariGestureChange, 3),
    safari(GestureEventKind.SafariGestureEnd, 3),
  ]);
  assert.deepEqual(actions, [
    { kind: InputActionKind.Zoom, x: 30, y: 40, factor: 1 / 1.5 },
    { kind: InputActionKind.Zoom, x: 31, y: 41, factor: 0.5 },
  ]);
  assertClose((actions[0] as { factor: number }).factor * (actions[1] as { factor: number }).factor, 1 / 3, 'the factors multiply to 1 / scale');
  assert.equal(state, IDLE_GESTURE_STATE);

  const pinchIn = run([safari(GestureEventKind.SafariGestureStart, 1), safari(GestureEventKind.SafariGestureChange, 0.5)]);
  assert.deepEqual(pinchIn.actions, [{ kind: InputActionKind.Zoom, x: 50, y: 60, factor: 2 }]);
});

test('Safari gesture events that make no sense are ignored', () => {
  assert.deepEqual(run([safari(GestureEventKind.SafariGestureChange, 2)]).actions, [], 'a change without a start');
  assert.deepEqual(run([safari(GestureEventKind.SafariGestureEnd, 2)]).actions, []);
  for (const scale of [0, -1, NaN, Infinity]) {
    const { actions, state } = run([safari(GestureEventKind.SafariGestureStart, 1), safari(GestureEventKind.SafariGestureChange, scale)]);
    assert.deepEqual(actions, [], `scale ${scale}`);
    assert.equal(state.phase === GesturePhase.Idle && state.safariScale, 1, 'and the gesture goes on from where it was');
  }
  const afterEnd = run([safari(GestureEventKind.SafariGestureStart, 1), safari(GestureEventKind.SafariGestureEnd, 1), safari(GestureEventKind.SafariGestureChange, 2)]);
  assert.deepEqual(afterEnd.actions, []);
});

test('a pinch is zoomed once: Safari\'s gesture events are ignored while pointers drive it, and pointers while Safari does', () => {
  const pinching = run([down(1, 0, 0), down(2, 100, 0)]);
  const duplicate = run(
    [safari(GestureEventKind.SafariGestureStart, 1), safari(GestureEventKind.SafariGestureChange, 2), safari(GestureEventKind.SafariGestureEnd, 2)],
    pinching.state,
  );
  assert.deepEqual(duplicate.actions, []);
  assert.equal(duplicate.state.phase, GesturePhase.Pinching);

  const pressed = run([down(1, 0, 0), safari(GestureEventKind.SafariGestureStart, 1), safari(GestureEventKind.SafariGestureChange, 2)]);
  assert.deepEqual(pressed.actions, [], 'a press owns the gesture');

  const trackpad = run([safari(GestureEventKind.SafariGestureStart, 1), down(1, 0, 0), move(1, 50, 50), up(1, 50, 50)]);
  assert.deepEqual(trackpad.actions.filter((action) => action.kind !== InputActionKind.Hover), [], 'pointer presses are ignored during the gesture');
});

test('the reducer never changes the state it is given, and gives the same answer to the same input', () => {
  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  }

  const events: GestureEvent[] = [
    down(1, 0, 0), move(1, 20, 5), down(2, 100, 0), move(2, 140, 10), down(3, 7, 7), up(1, 20, 5), up(3, 7, 7), cancel(2),
    move(9, 1, 1), down(4, 0, 0), up(4, 0, 0), safari(GestureEventKind.SafariGestureStart, 1), safari(GestureEventKind.SafariGestureChange, 2),
    safari(GestureEventKind.SafariGestureEnd, 2), doubleClick(1, 1), leave(1),
  ];
  let state: GestureState = deepFreeze({ ...IDLE_GESTURE_STATE });
  for (const event of events) {
    const first = reduceGesture(state, deepFreeze({ ...event }));
    const second = reduceGesture(state, event);
    assert.deepEqual(first, second, `deterministic for ${GestureEventKind[event.kind]}`);
    state = deepFreeze(first.state);
  }
});

/** Deterministic PRNG (mulberry32): same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random event sequences keep the invariants: finite numbers, balanced drags, no click inside a drag, back to idle when everything lifts', () => {
  const random = mulberry32(20261104);

  for (let round = 0; round < 600; round++) {
    let state: GestureState = IDLE_GESTURE_STATE;
    let inDrag = false;
    const log: string[] = [];

    const feed = (event: GestureEvent): void => {
      log.push(`${GestureEventKind[event.kind]}${'pointerId' in event ? ` #${event.pointerId}` : ''}`);
      const step = reduceGesture(state, event);
      state = step.state;
      for (const action of step.actions) {
        for (const [field, value] of Object.entries(action)) {
          if (typeof value === 'number') assert.ok(Number.isFinite(value), `${field} is ${value} after ${log.join(', ')}`);
        }
        switch (action.kind) {
          case InputActionKind.PanStart:
            assert.equal(inDrag, false, `PanStart inside a drag after ${log.join(', ')}`);
            inDrag = true;
            break;
          case InputActionKind.PanEnd:
            assert.equal(inDrag, true, `PanEnd outside a drag after ${log.join(', ')}`);
            inDrag = false;
            break;
          case InputActionKind.Pan:
            assert.equal(inDrag, true, `Pan outside a drag after ${log.join(', ')}`);
            break;
          case InputActionKind.Zoom:
            assert.ok(action.factor > 0, `zoom factor ${action.factor}`);
            break;
          case InputActionKind.Click:
            assert.equal(inDrag, false, `Click inside a drag after ${log.join(', ')}`);
            break;
          default:
            break;
        }
      }
    };

    const x = (): number => Math.round(random() * 300) / 2;
    for (let i = 0; i < 40; i++) {
      const id = 1 + Math.floor(random() * 3);
      const roll = random();
      if (roll < 0.2) feed(down(id, x(), x(), { button: random() < 0.1 ? 2 : 0 }));
      else if (roll < 0.55) feed(move(id, x(), x()));
      else if (roll < 0.75) feed(up(id, x(), x()));
      else if (roll < 0.82) feed(cancel(id));
      else if (roll < 0.88) feed(leave(id));
      else if (roll < 0.91) feed(doubleClick(x(), x()));
      else if (roll < 0.94) feed(safari(GestureEventKind.SafariGestureStart, 1, x(), x()));
      else if (roll < 0.98) feed(safari(GestureEventKind.SafariGestureChange, 0.25 + random() * 3, x(), x()));
      else feed(safari(GestureEventKind.SafariGestureEnd, 1, x(), x()));
    }

    for (const id of [1, 2, 3]) feed(up(id, 0, 0));
    feed(safari(GestureEventKind.SafariGestureEnd, 1));
    for (const id of [1, 2, 3]) feed(up(id, 0, 0));
    assert.equal(state.phase, GesturePhase.Idle, `not idle after lifting everything: ${log.join(', ')}`);
    assert.equal(state.phase === GesturePhase.Idle && state.safariScale, 0);
    assert.equal(inDrag, false, `a drag is still open: ${log.join(', ')}`);
  }
});
