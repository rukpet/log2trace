/**
 * Interaction: how the waterfall reacts to input, with no DOM involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PINCH_ZOOM_K,
  WHEEL_ZOOM_K,
  createCamera,
  pxToTime,
  timeToPx,
  withWindow,
} from '../../../src/kit/geometry/camera1d.ts';
import { HitPart } from '../../../src/views/waterfall/model/hit.ts';
import {
  KEY_PAN_PX,
  KEY_ZOOM_STEP,
  WaterfallDirty,
  anchoredScrollTop,
  fitViewState,
  initialViewState,
  reduceInteraction,
  revealTime,
  windowForSpan,
  type Effect,
  type InteractionContext,
  type InteractionResult,
  type ViewState,
  type WaterfallInput,
} from '../../../src/views/waterfall/model/interaction.ts';
import { computeLayout, DEFAULT_METRICS } from '../../../src/views/waterfall/model/layout.ts';
import { projectRows } from '../../../src/views/waterfall/model/rows.ts';
import { span, trace, treeTrace, type TreeNode } from '../../support/trace-builder.ts';
import { scene, type Scene } from '../../support/waterfall-scene.ts';

//   r [0, 1000]  events at 0, 500, 1000          row 0
//   ├ a [100, 400]  four events                    row 1
//   ├ b [450, 455]                                 row 2
//   └ c [900, 1000]                                row 3
const TREE: TreeNode = {
  id: 'r', start: 0, end: 1000, events: [0, 500, 1000], children: [
    { id: 'a', start: 100, end: 400, events: [150, 160, 170, 380] },
    { id: 'b', start: 450, end: 455 },
    { id: 'c', start: 900, end: 1000 },
  ],
};
const PLOT_LEFT = 250;
const SCALE = 726 / 1000;

function context(s: Scene, overrides: Partial<InteractionContext> = {}): InteractionContext {
  return { index: s.index, projection: s.projection, collapsed: s.collapsed, layout: s.layout, selectedRow: -1, wheelZoom: false, ...overrides };
}

function run(s: Scene, input: WaterfallInput, state: ViewState = initialViewState(s.index, s.layout), overrides: Partial<InteractionContext> = {}): InteractionResult {
  return reduceInteraction(state, input, context(s, overrides));
}

const key = (name: string, modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {}): WaterfallInput => ({
  type: 'key', key: name, shift: modifiers.shift ?? false, ctrl: modifiers.ctrl ?? false, alt: modifiers.alt ?? false,
});

test('a new state shows the whole trace from the top', () => {
  const s = scene(treeTrace(TREE));
  const state = initialViewState(s.index, s.layout);

  assert.deepEqual(state.camera, { t0: 0, t1: 1000, total: 1000, widthPx: s.layout.plotWidth });
  assert.equal(state.scrollTop, 0);
  assert.equal(state.hover, null);
});

test('native scrolling is tracked and clamped, and changes nothing else', () => {
  const tall = scene(trace(['svc', Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i, i + 1))]), { height: 40 + 350 });

  const scrolled = run(tall, { type: 'scroll', top: 700 });
  assert.equal(scrolled.state.scrollTop, 700);
  assert.equal(scrolled.dirty, WaterfallDirty.Scroll);
  assert.equal(scrolled.scrollTo, false, 'the scroller is already there');
  assert.equal(scrolled.handled, false);

  assert.equal(run(tall, { type: 'scroll', top: 1e9 }).state.scrollTop, 100 * 35 - 350);
  assert.equal(run(tall, { type: 'scroll', top: -50 }).dirty, 0, 'already at the top');
});

test('a plain wheel is left to the scroller; ctrl+wheel zooms around the pointer', () => {
  const s = scene(treeTrace(TREE));
  const x = PLOT_LEFT + 400;
  const before = initialViewState(s.index, s.layout);

  const plain = run(s, { type: 'wheel', x, dx: 0, dy: 100, ctrl: false, shift: false });
  assert.equal(plain.handled, false);
  assert.equal(plain.dirty, 0);

  const zoomIn = run(s, { type: 'wheel', x, dx: 0, dy: -100, ctrl: true, shift: false });
  assert.equal(zoomIn.handled, true);
  assert.equal(zoomIn.dirty, WaterfallDirty.Camera);
  const factor = Math.exp(-100 * PINCH_ZOOM_K);
  assert.ok(Math.abs((zoomIn.state.camera.t1 - zoomIn.state.camera.t0) - 1000 * factor) < 1e-6);
  // the time under the pointer stays under the pointer
  const under = pxToTime(before.camera, 400);
  assert.ok(Math.abs(timeToPx(zoomIn.state.camera, under) - 400) < 1e-6);

  const zoomOut = run(s, { type: 'wheel', x, dx: 0, dy: 100, ctrl: true, shift: false }, zoomIn.state);
  assert.ok(zoomOut.state.camera.t1 - zoomOut.state.camera.t0 > zoomIn.state.camera.t1 - zoomIn.state.camera.t0);

  assert.equal(run(s, { type: 'wheel', x, dx: 0, dy: 0, ctrl: true, shift: false }).dirty, 0, 'a wheel with no delta');
});

test('with wheel-zoom the plain wheel zooms at the old, gentler speed', () => {
  const s = scene(treeTrace(TREE));
  const result = run(s, { type: 'wheel', x: PLOT_LEFT + 100, dx: 0, dy: -100, ctrl: false, shift: false }, undefined, { wheelZoom: true });

  assert.equal(result.handled, true);
  assert.ok(Math.abs((result.state.camera.t1 - result.state.camera.t0) - 1000 * Math.exp(-100 * WHEEL_ZOOM_K)) < 1e-6);
});

test('zooming with the pointer over the gutter anchors at the left edge of the plot', () => {
  const s = scene(treeTrace(TREE));
  const start = run(s, { type: 'wheel', x: 10, dx: 0, dy: -300, ctrl: true, shift: false }).state.camera;
  assert.equal(start.t0, 0);
  assert.ok(start.t1 < 1000);
});

test('shift+wheel and horizontal wheel pan the time window', () => {
  const s = scene(treeTrace(TREE));
  const zoomed = withWindow(initialViewState(s.index, s.layout).camera, 400, 600);
  const state: ViewState = { ...initialViewState(s.index, s.layout), camera: zoomed };

  const right = run(s, { type: 'wheel', x: 300, dx: 0, dy: 100, ctrl: false, shift: true }, state);
  assert.equal(right.handled, true);
  assert.ok(right.state.camera.t0 > 400, 'scrolling forward shows later times');
  assert.ok(Math.abs((right.state.camera.t1 - right.state.camera.t0) - 200) < 1e-9, 'the window keeps its length');

  const left = run(s, { type: 'wheel', x: 300, dx: -100, dy: 3, ctrl: false, shift: false }, state);
  assert.ok(left.state.camera.t0 < 400, 'a mostly horizontal wheel pans too');

  assert.equal(run(s, { type: 'wheel', x: 300, dx: 4, dy: 100, ctrl: false, shift: false }, state).handled, false, 'mostly vertical: scroll');
});

test('dragging pans the window; the content follows the pointer', () => {
  const s = scene(treeTrace(TREE));
  const zoomed = withWindow(initialViewState(s.index, s.layout).camera, 400, 600);
  const state: ViewState = { ...initialViewState(s.index, s.layout), camera: zoomed };

  const right = run(s, { type: 'pan', dx: 100 }, state);
  assert.ok(right.state.camera.t0 < 400, 'dragging right reveals earlier times');
  assert.equal(right.dirty, WaterfallDirty.Camera);
  assert.equal(run(s, { type: 'pan', dx: 100 }).dirty, 0, 'the whole trace cannot pan');
  assert.equal(run(s, { type: 'pan', dx: 0 }, state).dirty, 0);
});

test('a pinch zooms around its centre by the scale of the gesture', () => {
  const s = scene(treeTrace(TREE));
  const x = PLOT_LEFT + 363;
  const result = run(s, { type: 'pinch', x, scale: 2 });

  assert.ok(Math.abs((result.state.camera.t1 - result.state.camera.t0) - 500) < 1e-6);
  assert.ok(Math.abs(timeToPx(result.state.camera, pxToTime(createCamera(1000, s.layout.plotWidth), 363)) - 363) < 1e-6);
  assert.equal(run(s, { type: 'pinch', x, scale: 0 }).dirty, 0, 'a broken gesture is ignored');
  assert.equal(run(s, { type: 'pinch', x, scale: -1 }).dirty, 0);
});

function effects(result: InteractionResult): Effect[] {
  return [...result.effects];
}

test('a click selects what is under it, and toggles when it is the chevron', () => {
  const s = scene(treeTrace(TREE));

  assert.deepEqual(effects(run(s, { type: 'click', x: 10, y: 50, additive: false })), [{ type: 'toggle', span: 0 }]);
  assert.deepEqual(effects(run(s, { type: 'click', x: 120, y: 90, additive: false })), [{ type: 'select', span: 1, event: -1, additive: false }], 'a label');
  assert.deepEqual(effects(run(s, { type: 'click', x: PLOT_LEFT + 450 * SCALE, y: 125, additive: true })), [{ type: 'select', span: 2, event: -1, additive: true }], 'a bar, with ctrl held');
  assert.deepEqual(effects(run(s, { type: 'click', x: PLOT_LEFT + 600, y: 125, additive: false })), [{ type: 'select', span: 2, event: -1, additive: false }], 'empty space in a row');

  const onEvent = run(s, { type: 'click', x: PLOT_LEFT + 150 * SCALE, y: 75 + 17.5, additive: false });
  const [event] = effects(onEvent);
  assert.equal(event.type, 'select');
  assert.ok(event.type === 'select' && s.index.table.evT[event.event] === 150, 'an event marker reports which event');

  const nothing = run(s, { type: 'click', x: 300, y: 10, additive: false });
  assert.equal(nothing.effects.length, 0, 'the ruler');
  assert.equal(nothing.handled, false);
});

test('double click zooms to a span, or back to the whole trace on empty space', () => {
  const s = scene(treeTrace(TREE));
  const onBar = run(s, { type: 'doubleClick', x: PLOT_LEFT + 200 * SCALE, y: 90 });
  const { t0, t1 } = windowForSpan(100, 400);

  assert.equal(onBar.state.camera.t0, t0);
  assert.equal(onBar.state.camera.t1, t1);
  assert.deepEqual([t0, t1], [85, 415]);
  assert.equal(onBar.dirty, WaterfallDirty.Camera);

  const label = run(s, { type: 'doubleClick', x: 120, y: 90 });
  assert.equal(label.state.camera.t0, 85, 'a label counts as its span');

  const reset = run(s, { type: 'doubleClick', x: PLOT_LEFT + 700, y: 125 }, onBar.state);
  assert.deepEqual([reset.state.camera.t0, reset.state.camera.t1], [0, 1000]);

  assert.equal(run(s, { type: 'doubleClick', x: 10, y: 50 }, onBar.state).dirty, 0, 'a chevron is left alone');
});

test('hover reports a change of element once, and sets the cursor', () => {
  const s = scene(treeTrace(TREE));
  const first = run(s, { type: 'hover', x: PLOT_LEFT + 450 * SCALE, y: 125 });

  assert.equal(first.dirty, WaterfallDirty.Hover);
  assert.equal(first.cursor, 'pointer');
  assert.equal(first.effects.length, 1);
  const [effect] = effects(first);
  assert.ok(effect.type === 'hover' && effect.target !== null && effect.target.span === 2 && effect.target.part === HitPart.Bar);

  const again = run(s, { type: 'hover', x: PLOT_LEFT + 450 * SCALE + 1, y: 130 }, first.state);
  assert.equal(again.dirty, 0, 'still the same bar');
  assert.equal(again.effects.length, 0);

  const emptyRow = run(s, { type: 'hover', x: PLOT_LEFT + 650, y: 125 }, first.state);
  assert.equal(emptyRow.cursor, 'grab');
  assert.equal(emptyRow.dirty, WaterfallDirty.Hover);

  const left = run(s, { type: 'leave' }, first.state);
  assert.deepEqual(effects(left), [{ type: 'hover', target: null }]);
  assert.equal(left.cursor, 'default');
  assert.equal(run(s, { type: 'leave' }, left.state).effects.length, 0, 'leaving twice is one change');

  assert.equal(run(s, { type: 'hover', x: 300, y: 10 }, left.state).dirty, 0, 'over the ruler is still nothing');
});

test('hover tells the marker apart from its bar', () => {
  const s = scene(treeTrace(TREE));
  const onMarker = run(s, { type: 'hover', x: PLOT_LEFT + 160 * SCALE, y: 75 + 17.5 });
  // 165 ms is 3.63 px from the markers at 160 and 170 ms: out of reach of both
  const onBar = run(s, { type: 'hover', x: PLOT_LEFT + 165 * SCALE, y: 75 + 17.5 }, onMarker.state);

  assert.equal(onMarker.state.hover?.part, HitPart.Event);
  assert.equal(onBar.state.hover?.part, HitPart.Bar);
  assert.equal(onBar.dirty, WaterfallDirty.Hover);
});

test('arrow keys move the selection one row, starting at the first', () => {
  const s = scene(treeTrace(TREE));
  const select = (result: InteractionResult): number[] =>
    effects(result).map((e) => (e.type === 'select' ? e.span : -99));

  assert.deepEqual(select(run(s, key('ArrowDown'))), [0], 'nothing selected: the first row');
  assert.deepEqual(select(run(s, key('ArrowUp'))), [0]);
  assert.deepEqual(select(run(s, key('ArrowDown'), undefined, { selectedRow: 1 })), [2]);
  assert.deepEqual(select(run(s, key('ArrowUp'), undefined, { selectedRow: 1 })), [0]);
  assert.deepEqual(select(run(s, key('ArrowDown'), undefined, { selectedRow: 3 })), [3], 'stops at the last');
  assert.deepEqual(select(run(s, key('ArrowUp'), undefined, { selectedRow: 0 })), [0], 'and at the first');
  assert.equal(run(s, key('ArrowDown')).handled, true);
});

test('moving the selection scrolls it into view and pans the window to it', () => {
  const tall = scene(trace(['svc', Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i * 10, i * 10 + 5))]), { height: 40 + 350 });
  const down = run(tall, key('ArrowDown'), undefined, { selectedRow: 9 }); // row 10 is just below the ten rows in view

  assert.equal(down.scrollTo, true, 'the scroller has to move');
  assert.equal(down.dirty & WaterfallDirty.Scroll, WaterfallDirty.Scroll);
  assert.equal(down.state.scrollTop, 35, 'by just enough to show the row');

  const zoomed: ViewState = { ...initialViewState(tall.index, tall.layout), camera: withWindow(createCamera(tall.index.table.extentMs, tall.layout.plotWidth), 0, 100) };
  const far = run(tall, key('ArrowDown'), zoomed, { selectedRow: 49 }); // the span at 500 ms is far outside the window
  assert.equal(far.dirty & WaterfallDirty.Camera, WaterfallDirty.Camera);
  assert.ok(far.state.camera.t0 < 502.5 && far.state.camera.t1 > 502.5, 'now centred on the span');
  assert.equal(far.state.camera.t1 - far.state.camera.t0, 100, 'without zooming');
});

test('left and right pan by a step; plus, minus, 0 and Home zoom and reset', () => {
  const s = scene(treeTrace(TREE));
  const zoomed = withWindow(initialViewState(s.index, s.layout).camera, 400, 600);
  const state: ViewState = { ...initialViewState(s.index, s.layout), camera: zoomed };
  const pxPerMs = s.layout.plotWidth / 200;

  assert.ok(Math.abs(run(s, key('ArrowLeft'), state).state.camera.t0 - (400 - KEY_PAN_PX / pxPerMs)) < 1e-9);
  assert.ok(Math.abs(run(s, key('ArrowRight'), state).state.camera.t0 - (400 + KEY_PAN_PX / pxPerMs)) < 1e-9);

  const zoomIn = run(s, key('+'), state).state.camera;
  assert.ok(Math.abs((zoomIn.t1 - zoomIn.t0) - 200 / KEY_ZOOM_STEP) < 1e-9);
  assert.ok(Math.abs((zoomIn.t0 + zoomIn.t1) / 2 - 500) < 1e-9, 'around the middle of the window');
  const fromWhole = run(s, key('=')).state.camera;
  assert.ok(Math.abs((fromWhole.t1 - fromWhole.t0) - 1000 / KEY_ZOOM_STEP) < 1e-9);
  const zoomOut = run(s, key('-'), state).state.camera;
  assert.ok(Math.abs((zoomOut.t1 - zoomOut.t0) - 200 * KEY_ZOOM_STEP) < 1e-9);

  for (const name of ['0', 'Home']) {
    const reset = run(s, key(name), state);
    assert.deepEqual([reset.state.camera.t0, reset.state.camera.t1], [0, 1000]);
  }
  assert.equal(run(s, key('0')).dirty, 0, 'already showing everything');
});

test('shift+left collapses the selected span, shift+right expands it, and only when that applies', () => {
  const open = scene(treeTrace(TREE));
  const closed = scene(treeTrace(TREE), { collapsed: ['r'] });

  assert.deepEqual(effects(run(open, key('ArrowLeft', { shift: true }), undefined, { selectedRow: 0 })), [{ type: 'collapse', span: 0, collapsed: true }]);
  assert.deepEqual(effects(run(open, key('ArrowRight', { shift: true }), undefined, { selectedRow: 0 })), [], 'already expanded');
  assert.deepEqual(effects(run(closed, key('ArrowRight', { shift: true }), undefined, { selectedRow: 0 })), [{ type: 'collapse', span: 0, collapsed: false }]);
  assert.deepEqual(effects(run(closed, key('ArrowLeft', { shift: true }), undefined, { selectedRow: 0 })), [], 'already collapsed');
  assert.deepEqual(effects(run(open, key('ArrowLeft', { shift: true }), undefined, { selectedRow: 2 })), [], 'a leaf');
  assert.deepEqual(effects(run(open, key('ArrowLeft', { shift: true }))), [], 'nothing selected');
});

test('page keys scroll by the height of the view', () => {
  const tall = scene(trace(['svc', Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i, i + 1))]), { height: 40 + 350 });

  const down = run(tall, key('PageDown'));
  assert.equal(down.state.scrollTop, 350);
  assert.equal(down.scrollTo, true);
  assert.equal(run(tall, key('PageUp'), down.state).state.scrollTop, 0);
  assert.equal(run(tall, key('PageUp')).dirty, 0, 'already at the top');
  assert.equal(run(tall, key('PageDown'), { ...down.state, scrollTop: 3150 }).state.scrollTop, 3150, 'clamped at the end');
});

test('keys with ctrl or alt, and keys the view does not use, are left to the browser', () => {
  const s = scene(treeTrace(TREE));

  for (const input of [key('0', { ctrl: true }), key('ArrowDown', { alt: true }), key('+', { ctrl: true }), key('a'), key('Enter'), key('Escape'), key(' ')]) {
    const result = run(s, input);
    assert.equal(result.handled, false, JSON.stringify(input));
    assert.equal(result.dirty, 0);
    assert.equal(result.effects.length, 0);
  }
});

test('zoomBy and reset serve the toolbar', () => {
  const s = scene(treeTrace(TREE));
  const zoomed = run(s, { type: 'zoomBy', factor: 0.5 });
  assert.deepEqual([zoomed.state.camera.t0, zoomed.state.camera.t1], [250, 750]);

  const reset = run(s, { type: 'reset' }, zoomed.state);
  assert.deepEqual([reset.state.camera.t0, reset.state.camera.t1], [0, 1000]);
  assert.equal(reset.dirty, WaterfallDirty.Camera);
});

test('reveal brings a span into view: scroll by the alignment asked for, pan only if it is off the window', () => {
  const tall = scene(trace(['svc', Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i * 10, i * 10 + 5))]), { height: 40 + 350 });

  const nearest = run(tall, { type: 'reveal', span: 30, align: 'nearest' });
  assert.equal(nearest.state.scrollTop, 31 * 35 - 350, 'the row ends at the bottom of the view');
  assert.equal(nearest.scrollTo, true);

  const centre = run(tall, { type: 'reveal', span: 30, align: 'center' });
  assert.equal(centre.state.scrollTop, 30 * 35 + 17.5 - 175);

  assert.equal(run(tall, { type: 'reveal', span: 3, align: 'nearest' }).dirty, 0, 'already in view');
  assert.equal(run(tall, { type: 'reveal', span: -1, align: 'nearest' }).dirty, 0);

  const hidden = scene(treeTrace(TREE), { collapsed: ['r'] });
  assert.equal(run(hidden, { type: 'reveal', span: 2, align: 'center' }).dirty, 0, 'a span hidden by collapsing stays hidden');
});

test('revealTime and windowForSpan', () => {
  const camera = withWindow(createCamera(1000, 500), 400, 500);

  assert.equal(revealTime(camera, 450, 460), camera, 'inside: unchanged');
  assert.equal(revealTime(camera, 480, 900), camera, 'overlapping: unchanged');

  const short = revealTime(camera, 100, 110);
  assert.deepEqual([short.t0, short.t1], [55, 155], 'a short span is centred');
  const long = revealTime(camera, 600, 900);
  assert.deepEqual([long.t0, long.t1], [590, 690], 'a long span starts a tenth in');

  assert.deepEqual(windowForSpan(100, 400), { t0: 85, t1: 415 });
  const instant = windowForSpan(5, 5);
  assert.ok(instant.t1 > instant.t0, 'a zero-length span still gives a window');
});

test('the scroll position follows the same span when rows appear or disappear above it', () => {
  const tree = scene(treeTrace(TREE), { height: 40 + 35 * 2 }); // two rows in view
  const before = { projection: tree.projection, layout: tree.layout, scrollTop: 35 };

  // collapse r: only r and nothing else remains, so the anchor (row 1, span a) is gone
  const collapsed = scene(treeTrace(TREE), { height: 40 + 35 * 2, collapsed: ['r'] });
  assert.equal(anchoredScrollTop(before, -1, { projection: collapsed.projection, layout: collapsed.layout }), 0, 'anchor hidden: just clamped');

  // collapse b's siblings above? build a trace where a collapse above the anchor shifts it up
  const wide = treeTrace([
    { id: 'p', start: 0, end: 50, children: [{ id: 'p1', start: 1, end: 2 }, { id: 'p2', start: 3, end: 4 }, { id: 'p3', start: 5, end: 6 }] },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, start: 60 + i, end: 61 + i })),
  ]);
  const open = scene(wide, { height: 40 + 35 * 5 });
  const closed = scene(wide, { height: 40 + 35 * 5, collapsed: ['p'] });
  const scrollTop = 35 * 6; // q1 is the first row in view
  const anchored = anchoredScrollTop({ projection: open.projection, layout: open.layout, scrollTop }, -1, { projection: closed.projection, layout: closed.layout });
  assert.equal(anchored, scrollTop - 3 * 35, 'three rows vanished above the anchor');

  const selectedSpan = open.index.spans.get('q5')?.idx ?? -1; // visible at the bottom of the view: row 10 of 0..
  const kept = anchoredScrollTop({ projection: open.projection, layout: open.layout, scrollTop: 35 * 8 }, selectedSpan, { projection: closed.projection, layout: closed.layout });
  assert.equal(kept, 35 * 8 - 3 * 35, 'a selected span in view is the anchor');
});

test('fitViewState adapts to a resize and a shorter list', () => {
  const s = scene(trace(['svc', Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i, i + 1))]), { height: 40 + 350 });
  const state: ViewState = { ...initialViewState(s.index, s.layout), scrollTop: 3000 };

  const untouched = initialViewState(s.index, s.layout);
  assert.equal(fitViewState(untouched, s.layout, 100), untouched, 'nothing to change: the same object comes back');

  const wider = computeLayout(DEFAULT_METRICS, 1400, 390, 0);
  const fitted = fitViewState(state, wider, 100);
  assert.equal(fitted.camera.widthPx, wider.plotWidth);
  assert.equal(fitted.scrollTop, 3000, 'still within range');

  const fewer = fitViewState(state, wider, 20);
  assert.equal(fewer.scrollTop, 20 * 35 - 350, 'clamped to the shorter list');
  assert.equal(projectRows(s.index, null, null).count, 100);
});
