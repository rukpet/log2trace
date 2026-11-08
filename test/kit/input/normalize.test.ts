/**
 * Wheel and key normalisation: what a wheel event means (zoom, pan, or left to
 * the browser) for `deltaMode` pixels, lines and pages and for Ctrl, Meta and
 * Shift, the speed constants coming from the camera helpers, which keys are
 * translated (and not with Ctrl, Alt or Meta), and what counts as a form field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WHEEL_DELTA_PX,
  PINCH_ZOOM_K,
  WHEEL_LINE_PX,
  WHEEL_ZOOM_K,
  WheelDeltaMode,
  normalizeWheelDelta,
  zoomFactor,
} from '../../../src/kit/geometry/camera1d.ts';
import { interpretWheel, isFormField, normalizeKey, type KeyLike, type WheelOptions } from '../../../src/kit/input/normalize.ts';
import { InputActionKind, Key, type WheelInput } from '../../../src/kit/input/types.ts';

const PAGE = 700;
const NO_MODIFIERS = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
const SCROLLS: WheelOptions = { pageSizePx: PAGE, wheelZoom: false };
const ZOOMS: WheelOptions = { pageSizePx: PAGE, wheelZoom: true };

function wheel(fields: Partial<WheelInput> = {}): WheelInput {
  return { x: 120, y: 40, deltaX: 0, deltaY: 0, deltaMode: WheelDeltaMode.Pixel, ...NO_MODIFIERS, ...fields };
}

function zoomOf(input: WheelInput, options: WheelOptions = SCROLLS): number {
  const action = interpretWheel(input, options);
  assert.ok(action !== null && action.kind === InputActionKind.Zoom, `expected a zoom, got ${JSON.stringify(action)}`);
  return action.factor;
}

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${what}: ${actual} vs ${expected}`);
}

test('ctrl+wheel zooms around the cursor at the pinch speed; scrolling down zooms out', () => {
  const action = interpretWheel(wheel({ ctrlKey: true, deltaY: 10 }), SCROLLS);
  assert.ok(action !== null && action.kind === InputActionKind.Zoom);
  assert.equal(action.x, 120);
  assert.equal(action.y, 40);
  assertClose(action.factor, Math.exp(10 * PINCH_ZOOM_K), 'ctrl+wheel down');
  assert.ok(action.factor > 1, 'positive deltaY zooms out');

  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: -10 })), Math.exp(-10 * PINCH_ZOOM_K), 'ctrl+wheel up');
  assert.ok(zoomOf(wheel({ ctrlKey: true, deltaY: -10 })) < 1, 'negative deltaY zooms in');
});

test('the wheel is normalised by deltaMode: pixels, lines times 16, pages times the viewport height', () => {
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 40 })), Math.exp(40 * PINCH_ZOOM_K), 'pixels');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 3, deltaMode: WheelDeltaMode.Line })), Math.exp(3 * WHEEL_LINE_PX * PINCH_ZOOM_K), 'three lines');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 0.25, deltaMode: WheelDeltaMode.Page }), { pageSizePx: 400, wheelZoom: false }), Math.exp(100 * PINCH_ZOOM_K), 'a quarter page of 400 px');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 0.25, deltaMode: WheelDeltaMode.Page }), { pageSizePx: 800, wheelZoom: false }), Math.exp(200 * PINCH_ZOOM_K), 'the page size is the options\'');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 40, deltaMode: 7 })), Math.exp(40 * PINCH_ZOOM_K), 'an unknown mode counts as pixels');

  // The same numbers the camera helpers give, so a wheel zooms alike wherever it is read.
  for (const [deltaY, deltaMode] of [[5, 0], [-2, 1], [0.3, 2], [100, 1]] as const) {
    const expected = zoomFactor(normalizeWheelDelta(deltaY, deltaMode, PAGE), PINCH_ZOOM_K);
    assert.equal(zoomOf(wheel({ ctrlKey: true, deltaY, deltaMode })), expected, `deltaY ${deltaY}, mode ${deltaMode}`);
  }
});

test('one wheel event never zooms by more than |dy| of 240 px', () => {
  const most = Math.exp(MAX_WHEEL_DELTA_PX * PINCH_ZOOM_K);
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 5000 })), most, 'a hard flick down');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: -5000 })), 1 / most, 'a hard flick up');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 1, deltaMode: WheelDeltaMode.Page })), most, 'a page is clamped too');
  assertClose(zoomOf(wheel({ deltaY: 5000 }), ZOOMS), Math.exp(MAX_WHEEL_DELTA_PX * WHEEL_ZOOM_K), 'and with the plain-wheel speed');
});

test('Meta+wheel zooms at the plain-wheel speed, Ctrl at the pinch speed, both together at the pinch speed', () => {
  assertClose(zoomOf(wheel({ metaKey: true, deltaY: 50 })), Math.exp(50 * WHEEL_ZOOM_K), 'meta');
  assertClose(zoomOf(wheel({ ctrlKey: true, deltaY: 50 })), Math.exp(50 * PINCH_ZOOM_K), 'ctrl');
  assertClose(zoomOf(wheel({ ctrlKey: true, metaKey: true, deltaY: 50 })), Math.exp(50 * PINCH_ZOOM_K), 'both');
});

test('a plain vertical wheel is left to the native scroller, unless wheel-zoom is on', () => {
  assert.equal(interpretWheel(wheel({ deltaY: 100 }), SCROLLS), null);
  assert.equal(interpretWheel(wheel({ deltaY: -100 }), SCROLLS), null);
  assert.equal(interpretWheel(wheel({ deltaY: 100, deltaX: 3 }), SCROLLS), null, 'a slightly diagonal swipe is still a scroll');
  assert.equal(interpretWheel(wheel({ altKey: true, deltaY: 100 }), SCROLLS), null);

  assertClose(zoomOf(wheel({ deltaY: 100 }), ZOOMS), Math.exp(100 * WHEEL_ZOOM_K), 'wheel-zoom, down');
  assertClose(zoomOf(wheel({ deltaY: -100 }), ZOOMS), Math.exp(-100 * WHEEL_ZOOM_K), 'wheel-zoom, up');
  assert.equal(interpretWheel(wheel({ deltaY: 0 }), ZOOMS), null, 'nothing to zoom by');
  assert.equal(interpretWheel(wheel(), SCROLLS), null);
});

test('a gesture that is more horizontal than vertical pans, and a wheel that scrolls right moves the content left', () => {
  assert.deepEqual(interpretWheel(wheel({ deltaX: 40, deltaY: 5 }), SCROLLS), { kind: InputActionKind.Pan, dx: -40, dy: 0 });
  assert.deepEqual(interpretWheel(wheel({ deltaX: -40, deltaY: 5 }), SCROLLS), { kind: InputActionKind.Pan, dx: 40, dy: 0 });
  assert.deepEqual(interpretWheel(wheel({ deltaX: 2, deltaMode: WheelDeltaMode.Line }), SCROLLS), { kind: InputActionKind.Pan, dx: -2 * WHEEL_LINE_PX, dy: 0 });
  assert.deepEqual(interpretWheel(wheel({ deltaX: 40, deltaY: 5 }), ZOOMS), { kind: InputActionKind.Pan, dx: -40, dy: 0 }, 'wheel-zoom does not take horizontal wheels');
  assert.equal(interpretWheel(wheel({ deltaX: 5, deltaY: 5 }), SCROLLS), null, 'a tie is a scroll');
});

test('Shift+wheel pans, whether the browser reports the movement as deltaX or leaves it in deltaY', () => {
  assert.deepEqual(interpretWheel(wheel({ shiftKey: true, deltaY: 30 }), SCROLLS), { kind: InputActionKind.Pan, dx: -30, dy: 0 });
  assert.deepEqual(interpretWheel(wheel({ shiftKey: true, deltaX: 30, deltaY: 0 }), SCROLLS), { kind: InputActionKind.Pan, dx: -30, dy: 0 });
  assert.deepEqual(interpretWheel(wheel({ shiftKey: true, deltaX: 30, deltaY: 80 }), SCROLLS), { kind: InputActionKind.Pan, dx: -30, dy: 0 }, 'deltaX wins when both are there');
  assert.deepEqual(interpretWheel(wheel({ shiftKey: true, deltaY: 100 }), ZOOMS), { kind: InputActionKind.Pan, dx: -100, dy: 0 }, 'Shift beats wheel-zoom');
  assert.equal(interpretWheel(wheel({ shiftKey: true }), SCROLLS), null, 'no movement, nothing to do');

  const zoom = interpretWheel(wheel({ shiftKey: true, ctrlKey: true, deltaY: 30 }), SCROLLS);
  assert.equal(zoom?.kind, InputActionKind.Zoom, 'Ctrl beats Shift');
});

test('ctrl+wheel with nothing to scroll still counts as a zoom, by 1, so the page does not zoom', () => {
  assert.equal(zoomOf(wheel({ ctrlKey: true })), 1);
  assert.equal(zoomOf(wheel({ metaKey: true, deltaX: 20 })), 1);
});

test('deltas that are not numbers count as zero', () => {
  assert.equal(zoomOf(wheel({ ctrlKey: true, deltaY: NaN })), 1);
  assert.equal(zoomOf(wheel({ ctrlKey: true, deltaY: Infinity })), 1);
  assert.equal(interpretWheel(wheel({ deltaX: NaN, deltaY: NaN }), ZOOMS), null);
  assert.equal(interpretWheel(wheel({ deltaX: Infinity, deltaY: 3 }), SCROLLS), null);
});

test('zoom factors are positive and finite whatever the event says', () => {
  for (const deltaY of [-1e9, -240, -1, 0, 1, 240, 1e9, NaN, Infinity, -Infinity]) {
    for (const deltaMode of [0, 1, 2]) {
      const factor = zoomOf(wheel({ ctrlKey: true, deltaY, deltaMode }));
      assert.ok(Number.isFinite(factor) && factor > 0, `deltaY ${deltaY}, mode ${deltaMode}: ${factor}`);
    }
  }
});

test('the cursor position comes through unchanged', () => {
  const zoom = interpretWheel(wheel({ ctrlKey: true, deltaY: 1, x: -3.5, y: 612.25 }), SCROLLS);
  assert.ok(zoom !== null && zoom.kind === InputActionKind.Zoom);
  assert.deepEqual([zoom.x, zoom.y], [-3.5, 612.25]);
});

function key(name: string, fields: Partial<KeyLike> = {}): KeyLike {
  return { key: name, ...NO_MODIFIERS, repeat: false, ...fields };
}

test('the keys a view handles map to names, several physical keys to one', () => {
  const expected: Array<[string, Key]> = [
    ['ArrowUp', Key.ArrowUp],
    ['ArrowDown', Key.ArrowDown],
    ['ArrowLeft', Key.ArrowLeft],
    ['ArrowRight', Key.ArrowRight],
    ['Home', Key.Home],
    ['End', Key.End],
    ['PageUp', Key.PageUp],
    ['PageDown', Key.PageDown],
    ['Enter', Key.Enter],
    [' ', Key.Space],
    ['Escape', Key.Escape],
    ['+', Key.Plus],
    ['=', Key.Plus],
    ['-', Key.Minus],
    ['_', Key.Minus],
    ['0', Key.Zero],
    ['i', Key.I],
    ['I', Key.I],
    ['f', Key.F],
    ['F', Key.F],
    ['r', Key.R],
    ['R', Key.R],
    ['e', Key.E],
    ['E', Key.E],
  ];
  for (const [name, expectedKey] of expected) {
    assert.deepEqual(normalizeKey(key(name)), { key: expectedKey, shiftKey: false, repeat: false }, JSON.stringify(name));
  }
});

test('Shift and auto-repeat are reported', () => {
  assert.deepEqual(normalizeKey(key('ArrowLeft', { shiftKey: true })), { key: Key.ArrowLeft, shiftKey: true, repeat: false });
  assert.deepEqual(normalizeKey(key('ArrowDown', { repeat: true })), { key: Key.ArrowDown, shiftKey: false, repeat: true });
  assert.deepEqual(normalizeKey(key('+', { shiftKey: true })), { key: Key.Plus, shiftKey: true, repeat: false }, '+ needs Shift on many keyboards');
});

test('chords with Ctrl, Alt or Meta belong to the browser and are not translated', () => {
  for (const name of ['0', '+', '-', '=', 'ArrowLeft', 'Home', 'Enter', ' ', 'f', 'i', 'r', 'e']) {
    for (const held of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      assert.equal(normalizeKey(key(name, { [held]: true })), null, `${held}+${JSON.stringify(name)}`);
    }
  }
});

test('other keys are not translated, so the browser keeps them', () => {
  for (const name of ['a', 'b', 'Tab', 'Shift', 'Control', 'Backspace', 'Delete', 'F5', '1', ')', 'Dead', 'Unidentified', '']) {
    assert.equal(normalizeKey(key(name)), null, JSON.stringify(name));
  }
});

test('form fields are inputs, textareas, selects and anything contenteditable', () => {
  for (const tagName of ['INPUT', 'input', 'TEXTAREA', 'textarea', 'SELECT', 'Select']) {
    assert.equal(isFormField({ tagName }), true, tagName);
  }
  assert.equal(isFormField({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isFormField({ tagName: 'SPAN', isContentEditable: true }), true);

  for (const tagName of ['DIV', 'BUTTON', 'CANVAS', 'A', 'TRACE-VISUALIZER', '']) {
    assert.equal(isFormField({ tagName }), false, tagName);
    assert.equal(isFormField({ tagName, isContentEditable: false }), false, `${tagName}, not editable`);
  }
  for (const nonElement of [null, undefined, 'INPUT', 42, true, {}, { tagName: 5 }]) {
    assert.equal(isFormField(nonElement), false, JSON.stringify(nonElement));
  }
});
