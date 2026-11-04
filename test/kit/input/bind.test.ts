/**
 * The DOM binding against a fake element: which listeners it registers, that
 * positions are in the element's own frame, pointer capture, presses on the
 * native scrollbar, wheel and Safari gestures (and when their default is
 * prevented), keys from form fields, and disposal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WHEEL_DELTA_PX, PINCH_ZOOM_K, WHEEL_ZOOM_K } from '../../../src/kit/geometry/camera1d.ts';
import { bindInput, type InputBindingOptions } from '../../../src/kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../../../src/kit/input/types.ts';
import { FakeInputTarget } from '../../support/fake-input-target.ts';

const NO_MODIFIERS = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

/** The element sits at (10, 20), so client (110, 70) is (100, 50) in its own frame. */
function rig(options: Partial<InputBindingOptions> = {}): { target: FakeInputTarget; actions: InputAction[]; dispose: () => void } {
  const target = new FakeInputTarget();
  const actions: InputAction[] = [];
  const dispose = bindInput(target, {
    onAction: (action) => {
      actions.push(action);
    },
    ...options,
  });
  return { target, actions, dispose };
}

function pointer(pointerId: number, clientX: number, clientY: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { pointerId, clientX, clientY, button: 0, ...NO_MODIFIERS, ...fields };
}

function wheel(fields: Record<string, unknown>): Record<string, unknown> {
  return { clientX: 110, clientY: 70, deltaX: 0, deltaY: 0, deltaMode: 0, ...NO_MODIFIERS, ...fields };
}

function keydown(key: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, ...NO_MODIFIERS, repeat: false, isComposing: false, ...fields };
}

function kinds(actions: readonly InputAction[]): InputActionKind[] {
  return actions.map((action) => action.kind);
}

test('registers what it needs, with the wheel and Safari gesture listeners non-passive', () => {
  const { target } = rig();
  const expected = [
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture',
    'dblclick', 'wheel', 'keydown', 'gesturestart', 'gesturechange', 'gestureend',
  ];
  for (const type of expected) assert.equal(target.listenerCount(type), 1, type);
  assert.equal(target.listenerCount(), expected.length, 'and nothing else');

  for (const type of ['wheel', 'gesturestart', 'gesturechange', 'gestureend']) {
    assert.deepEqual(target.optionsOf(type), { passive: false }, `${type} must be able to prevent the page zoom`);
  }
  assert.equal(target.optionsOf('pointerdown'), undefined);
  assert.equal(target.optionsOf('keydown'), undefined);
});

test('a click is reported in the element\'s own coordinates, and the press is left alone so the element can take focus', () => {
  const { target, actions } = rig();
  const press = target.fire('pointerdown', pointer(1, 110, 70));
  const release = target.fire('pointerup', pointer(1, 110, 70, { ctrlKey: true }));

  assert.deepEqual(actions, [{ kind: InputActionKind.Click, x: 100, y: 50, shiftKey: false, ctrlKey: true, altKey: false, metaKey: false }]);
  assert.equal(press.defaultPrevented, false);
  assert.equal(release.defaultPrevented, false);
  assert.deepEqual(target.captured, [], 'a click takes no capture');
});

test('coordinates are relative to the padding box, inside the border', () => {
  const { target, actions } = rig();
  target.clientLeft = 2;
  target.clientTop = 3;
  target.left = 100;
  target.top = 200;

  target.fire('pointerdown', pointer(1, 150, 260));
  target.fire('pointerup', pointer(1, 150, 260));
  assert.deepEqual([actions[0].kind, (actions[0] as { x: number }).x, (actions[0] as { y: number }).y], [InputActionKind.Click, 48, 57]);
});

test('a drag takes pointer capture when it starts and not before, and the browser\'s release afterwards is not a cancel', () => {
  const { target, actions } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointermove', pointer(1, 111, 70));
  assert.deepEqual(actions, []);
  assert.deepEqual(target.captured, [], 'nothing captured while it is still a press');

  target.fire('pointermove', pointer(1, 115, 70));
  assert.deepEqual(actions, [
    { kind: InputActionKind.PanStart, x: 100, y: 50 },
    { kind: InputActionKind.Pan, dx: 5, dy: 0 },
  ]);
  assert.deepEqual(target.captured, [1]);

  target.fire('pointermove', pointer(1, 120, 72));
  assert.deepEqual(actions[2], { kind: InputActionKind.Pan, dx: 5, dy: 2 });
  assert.deepEqual(target.captured, [1], 'captured once');

  target.fire('pointerup', pointer(1, 120, 72));
  assert.deepEqual(kinds(actions), [InputActionKind.PanStart, InputActionKind.Pan, InputActionKind.Pan, InputActionKind.PanEnd]);
  assert.deepEqual(actions[3], { kind: InputActionKind.PanEnd, cancelled: false });

  target.fire('lostpointercapture', pointer(1, 120, 72));
  assert.equal(actions.length, 4, 'the capture ending with the gesture is not news');
});

test('capture lost in the middle of a drag cancels it', () => {
  const { target, actions } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointermove', pointer(1, 130, 70));
  target.fire('lostpointercapture', pointer(1, 130, 70));

  assert.deepEqual(actions[actions.length - 1], { kind: InputActionKind.PanEnd, cancelled: true });
  target.fire('pointerup', pointer(1, 130, 70));
  assert.equal(actions.length, 3, 'and the release afterwards does nothing');
});

test('a pointercancel ends a drag as cancelled', () => {
  const { target, actions } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointermove', pointer(1, 130, 70));
  target.fire('pointercancel', pointer(1, 130, 70));
  assert.deepEqual(actions[actions.length - 1], { kind: InputActionKind.PanEnd, cancelled: true });

  target.fire('pointermove', pointer(1, 140, 70));
  assert.equal(actions[actions.length - 1].kind, InputActionKind.Hover, 'idle again');
});

test('a pointer that cannot be captured does not break the drag', () => {
  const { target, actions } = rig();
  target.refuseCapture = true;
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointermove', pointer(1, 130, 70));
  target.fire('pointerup', pointer(1, 130, 70));
  assert.deepEqual(kinds(actions), [InputActionKind.PanStart, InputActionKind.Pan, InputActionKind.PanEnd]);
  assert.deepEqual(target.captured, []);

  target.fire('lostpointercapture', pointer(1, 130, 70));
  assert.equal(actions.length, 3, 'and nothing was captured, so nothing is lost');
});

test('two pointers make a pinch: announced at the midpoint, zoomed and panned in the element\'s frame', () => {
  const { target, actions } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointerdown', pointer(2, 210, 70));
  assert.deepEqual(actions, [{ kind: InputActionKind.PanStart, x: 150, y: 50 }]);
  assert.deepEqual(target.captured, [2], 'the pointer that started the drag is captured');

  target.fire('pointermove', pointer(2, 310, 70));
  assert.deepEqual(actions.slice(1), [
    { kind: InputActionKind.Pan, dx: 50, dy: 0 },
    { kind: InputActionKind.Zoom, x: 200, y: 50, factor: 0.5 },
  ]);
});

test('a press on the native scrollbar or the border is left to the browser', () => {
  for (const [what, clientX, clientY] of [
    ['the vertical scrollbar', 10 + 405, 70],
    ['its first pixel', 10 + 400, 70],
    ['the horizontal scrollbar', 110, 20 + 305],
    ['a left scrollbar or border', 10 - 1, 70],
    ['the top border', 110, 20 - 1],
  ] as const) {
    const { target, actions } = rig();
    target.fire('pointerdown', pointer(1, clientX, clientY));
    target.fire('pointermove', pointer(1, clientX - 50, clientY));
    target.fire('pointerup', pointer(1, clientX - 50, clientY));
    assert.deepEqual(actions.filter((action) => action.kind !== InputActionKind.Hover), [], what);
    assert.deepEqual(target.captured, [], `${what}: nothing captured`);
  }
});

test('a press on the content next to the scrollbar, or on a child at the same place, is not ignored', () => {
  const inside = rig();
  inside.target.fire('pointerdown', pointer(1, 10 + 399, 20 + 299));
  inside.target.fire('pointerup', pointer(1, 10 + 399, 20 + 299));
  assert.equal(inside.actions[0].kind, InputActionKind.Click, 'the last content pixel');

  const child = rig();
  const element = { tagName: 'DIV' };
  child.target.fire('pointerdown', pointer(1, 10 + 405, 70, { target: element }));
  child.target.fire('pointerup', pointer(1, 10 + 405, 70, { target: element }));
  assert.equal(child.actions[0].kind, InputActionKind.Click, 'a scrollbar belongs to the element itself, not to its children');
});

test('ctrl+wheel zooms at the cursor and stops the page from zooming too', () => {
  const { target, actions } = rig();
  const event = target.fire('wheel', wheel({ ctrlKey: true, deltaY: 20 }));

  assert.equal(actions.length, 1);
  const zoom = actions[0];
  assert.equal(zoom.kind, InputActionKind.Zoom);
  assert.ok(zoom.kind === InputActionKind.Zoom && zoom.x === 100 && zoom.y === 50);
  assert.ok(zoom.kind === InputActionKind.Zoom && Math.abs(zoom.factor - Math.exp(20 * PINCH_ZOOM_K)) < 1e-12);
  assert.equal(event.defaultPrevented, true);
});

test('a plain wheel scrolls natively unless wheel-zoom is on, which is read on every event', () => {
  let wheelZoom = false;
  const { target, actions } = rig({ wheelZoom: () => wheelZoom });

  const scrolled = target.fire('wheel', wheel({ deltaY: 100 }));
  assert.equal(actions.length, 0);
  assert.equal(scrolled.defaultPrevented, false, 'the native scroller gets the event');

  wheelZoom = true;
  const zoomed = target.fire('wheel', wheel({ deltaY: 100 }));
  assert.equal(actions.length, 1);
  assert.ok(actions[0].kind === InputActionKind.Zoom && Math.abs(actions[0].factor - Math.exp(100 * WHEEL_ZOOM_K)) < 1e-12);
  assert.equal(zoomed.defaultPrevented, true);

  wheelZoom = false;
  target.fire('wheel', wheel({ deltaY: 100 }));
  assert.equal(actions.length, 1);
});

test('a horizontal wheel pans and is consumed', () => {
  const { target, actions } = rig();
  const event = target.fire('wheel', wheel({ deltaX: 40, deltaY: 3 }));
  assert.deepEqual(actions, [{ kind: InputActionKind.Pan, dx: -40, dy: 0 }]);
  assert.equal(event.defaultPrevented, true);
});

test('the default is kept when the callback says it did not handle the action', () => {
  const { target, actions } = rig({
    onAction: (action) => {
      void action;
      return false;
    },
  });
  const wheelEvent = target.fire('wheel', wheel({ ctrlKey: true, deltaY: 20 }));
  const keyEvent = target.fire('keydown', keydown('ArrowLeft'));
  assert.equal(wheelEvent.defaultPrevented, false);
  assert.equal(keyEvent.defaultPrevented, false);
  assert.deepEqual(actions, []);

  const answersTrue = rig({ onAction: () => true });
  assert.equal(answersTrue.target.fire('keydown', keydown('ArrowLeft')).defaultPrevented, true);
});

test('wheels that report pages use the element\'s height, or the page size the options give', () => {
  const byHeight = rig();
  byHeight.target.fire('wheel', wheel({ ctrlKey: true, deltaY: 1, deltaMode: 2 }));
  assert.ok(byHeight.actions[0].kind === InputActionKind.Zoom);
  assert.ok(Math.abs((byHeight.actions[0] as { factor: number }).factor - Math.exp(MAX_WHEEL_DELTA_PX * PINCH_ZOOM_K)) < 1e-12, '300 px, clamped to 240');

  const custom = rig({ pageSizePx: () => 100 });
  custom.target.fire('wheel', wheel({ ctrlKey: true, deltaY: 1, deltaMode: 2 }));
  assert.ok(Math.abs((custom.actions[0] as { factor: number }).factor - Math.exp(100 * PINCH_ZOOM_K)) < 1e-12);
});

test('a handled key is reported with its modifiers and its default is prevented', () => {
  const { target, actions } = rig();
  const plain = target.fire('keydown', keydown('ArrowLeft'));
  assert.deepEqual(actions, [{ kind: InputActionKind.KeyDown, key: Key.ArrowLeft, shiftKey: false, repeat: false }]);
  assert.equal(plain.defaultPrevented, true);

  const shifted = target.fire('keydown', keydown('ArrowRight', { shiftKey: true, repeat: true }));
  assert.deepEqual(actions[1], { kind: InputActionKind.KeyDown, key: Key.ArrowRight, shiftKey: true, repeat: true });
  assert.equal(shifted.defaultPrevented, true);

  target.fire('keydown', keydown('=', { target: { tagName: 'DIV' } }));
  assert.equal(actions[2].kind, InputActionKind.KeyDown, 'a key from a plain child element is handled');
});

test('keys typed into form fields are left alone, even when the event is retargeted to the host', () => {
  const { target, actions } = rig();

  for (const [what, origin] of [
    ['an input', { tagName: 'INPUT' }],
    ['a textarea', { tagName: 'TEXTAREA' }],
    ['a select', { tagName: 'SELECT' }],
    ['a contenteditable div', { tagName: 'DIV', isContentEditable: true }],
  ] as const) {
    // Inside a shadow root the listener sees the host as `target`; only composedPath() knows the real origin.
    const retargeted = target.fire('keydown', keydown('ArrowLeft', { target, composedPath: () => [origin, target] }));
    assert.equal(retargeted.defaultPrevented, false, `${what} via composedPath`);

    const plainEvent = target.fire('keydown', keydown('0', { target: origin }));
    assert.equal(plainEvent.defaultPrevented, false, `${what} via target`);
  }
  assert.deepEqual(actions, []);

  const fromCanvasArea = target.fire('keydown', keydown('ArrowLeft', { composedPath: () => [{ tagName: 'DIV' }, target] }));
  assert.equal(fromCanvasArea.defaultPrevented, true, 'while a key from a non-field is handled');
  assert.equal(actions.length, 1);
});

test('chords, other keys, composition and keys somebody already handled are left alone', () => {
  const { target, actions } = rig();
  for (const event of [
    keydown('0', { ctrlKey: true }),
    keydown('-', { metaKey: true }),
    keydown('ArrowLeft', { altKey: true }),
    keydown('f', { ctrlKey: true }),
    keydown('Tab'),
    keydown('a'),
    keydown('ArrowLeft', { isComposing: true }),
    keydown('ArrowLeft', { defaultPrevented: true }),
  ]) {
    const fired = target.fire('keydown', event);
    assert.equal(fired.defaultPrevented, event.defaultPrevented === true, JSON.stringify(event.key));
  }
  assert.deepEqual(actions, []);
});

test('Safari gestures zoom around the gesture point, and always stop the page from zooming', () => {
  const { target, actions } = rig();
  const start = target.fire('gesturestart', { clientX: 110, clientY: 70, scale: 1 });
  const change = target.fire('gesturechange', { clientX: 110, clientY: 70, scale: 2 });
  const end = target.fire('gestureend', { clientX: 110, clientY: 70, scale: 2 });

  assert.deepEqual(actions, [{ kind: InputActionKind.Zoom, x: 100, y: 50, factor: 0.5 }]);
  for (const event of [start, change, end]) assert.equal(event.defaultPrevented, true, event.type);
});

test('Safari gestures that duplicate a two-finger pinch do nothing, but still do not zoom the page', () => {
  const { target, actions } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointerdown', pointer(2, 210, 70));
  actions.length = 0;

  const start = target.fire('gesturestart', { clientX: 160, clientY: 70, scale: 1 });
  target.fire('gesturechange', { clientX: 160, clientY: 70, scale: 3 });
  assert.deepEqual(actions, []);
  assert.equal(start.defaultPrevented, true);
});

test('hovering, leaving and double clicks are reported in the element\'s coordinates', () => {
  const { target, actions } = rig();
  target.fire('pointermove', pointer(1, 110, 70));
  target.fire('pointerleave', pointer(1, 0, 0));
  target.fire('dblclick', { clientX: 130, clientY: 90, ...NO_MODIFIERS, metaKey: true });

  assert.deepEqual(actions, [
    { kind: InputActionKind.Hover, x: 100, y: 50 },
    { kind: InputActionKind.HoverEnd },
    { kind: InputActionKind.DoubleClick, x: 120, y: 70, shiftKey: false, ctrlKey: false, altKey: false, metaKey: true },
  ]);
});

test('an exception from the callback does not swallow the rest of the event\'s actions, and surfaces afterwards', () => {
  const seen: InputAction[] = [];
  const { target } = rig({
    onAction: (action) => {
      seen.push(action);
      if (action.kind === InputActionKind.PanStart) throw new Error('view failed');
    },
  });
  target.fire('pointerdown', pointer(1, 110, 70));
  assert.throws(() => target.fire('pointermove', pointer(1, 130, 70)), /view failed/);
  assert.deepEqual(kinds(seen), [InputActionKind.PanStart, InputActionKind.Pan], 'the pan after the failed start was still reported');

  target.fire('pointermove', pointer(1, 140, 70));
  assert.equal(seen[seen.length - 1].kind, InputActionKind.Pan, 'and the machine carries on');
});

test('dispose removes every listener and releases capture, and says so if a drag was cut short', () => {
  const { target, actions, dispose } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointermove', pointer(1, 130, 70));
  assert.deepEqual(target.captured, [1]);
  const before = actions.length;

  dispose();
  assert.equal(target.listenerCount(), 0);
  assert.deepEqual(target.released, [1]);
  assert.deepEqual(actions.slice(before), [{ kind: InputActionKind.PanEnd, cancelled: true }]);

  target.fire('pointermove', pointer(1, 150, 70));
  target.fire('wheel', wheel({ ctrlKey: true, deltaY: 5 }));
  assert.equal(actions.length, before + 1, 'nothing is heard any more');

  dispose();
  assert.equal(actions.length, before + 1, 'a second dispose does nothing');
});

test('disposing an idle binding reports nothing', () => {
  const { target, actions, dispose } = rig();
  target.fire('pointerdown', pointer(1, 110, 70));
  target.fire('pointerup', pointer(1, 110, 70));
  const before = actions.length;
  dispose();
  assert.equal(actions.length, before);
  assert.deepEqual(target.released, []);
});
