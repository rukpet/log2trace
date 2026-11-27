import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceData } from '../../../src/core/index.ts';
import { MIN_WINDOW_MS, createCamera, withWindow } from '../../../src/kit/geometry/camera1d.ts';
import { HitPart } from '../../../src/views/lanes/model/hit.ts';
import { LaneMode, laneAt, laneHeight } from '../../../src/views/lanes/model/layout.ts';
import {
  KEY_ZOOM_STEP,
  LanesDirty,
  REVEAL_LEAD,
  anchoredScrollTop,
  fitViewState,
  initialViewState,
  reduceInteraction,
  revealTime,
  windowForSpan,
  type Effect,
  type InteractionContext,
  type InteractionResult,
  type LanesInput,
  type ViewState,
} from '../../../src/views/lanes/model/interaction.ts';
import { LanesFramePlan, selectionMasks, type SelectionMasks } from '../../../src/views/lanes/model/plan.ts';
import { span, trace } from '../../support/trace-builder.ts';
import { planOf, scene, wideTrace, type LanesScene, type SceneOptions } from '../../support/lanes-scene.ts';

const SCALE = 756 / 1000;
const PLOT_LEFT = 220;

/** A reducer with a store of its own: it keeps the state, the last plan and the selection the effects ask for. */
class Rig {
  readonly s: LanesScene;
  state: ViewState;
  plan = new LanesFramePlan();
  selectedRow = -1;
  selection: SelectionMasks | null = null;
  wheelZoom = false;
  readonly effects: Effect[] = [];
  readonly peers: boolean;

  constructor(data: TraceData, options: SceneOptions = {}) {
    this.s = scene(data, options);
    this.peers = options.peers ?? true;
    this.state = { ...initialViewState(this.spec()), stack: this.s.stack };
    this.replan();
  }

  private spec() {
    return { model: this.s.model, layout: this.s.layout, order: this.s.order, showPeers: this.peers };
  }

  replan(): void {
    planOf(this.s, { stack: this.state.stack, camera: this.state.camera, scrollTop: this.state.scrollTop, selection: this.selection }, this.plan);
  }

  ctx(): InteractionContext {
    return {
      ...this.spec(),
      plan: this.plan,
      matched: this.s.matched,
      selectedRow: this.selectedRow,
      selection: this.selection,
      wheelZoom: this.wheelZoom,
    };
  }

  send(input: LanesInput): InteractionResult {
    const result = reduceInteraction(this.state, input, this.ctx());
    this.state = result.state;
    for (const effect of result.effects) {
      this.effects.push(effect);
      if (effect.type === 'select') {
        this.selectedRow = effect.rows.length === 0 ? -1 : effect.primary;
        this.selection = effect.rows.length === 0 ? null : selectionMasks(this.s.index, effect.rows);
      }
    }
    this.replan();
    return result;
  }

  key(key: string, extra: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {}): InteractionResult {
    return this.send({ type: 'key', key, shift: extra.shift ?? false, ctrl: extra.ctrl ?? false, alt: extra.alt ?? false });
  }

  row(id: string): number {
    return this.s.index.table.ids.indexOf(id);
  }

  id(row: number): string {
    return this.s.index.table.ids[row];
  }

  select(id: string): void {
    this.selectedRow = this.row(id);
    this.selection = selectionMasks(this.s.index, [this.selectedRow]);
    this.replan();
  }

  /** Selected span, by id. */
  get selected(): string | null {
    return this.selectedRow < 0 ? null : this.id(this.selectedRow);
  }

  mode(name: string): LaneMode {
    return this.state.stack.modes[this.s.model.names.indexOf(name)] as LaneMode;
  }
}

const click = (x: number, y: number, additive = false): LanesInput => ({ type: 'click', x, y, additive });

/** Sequential spans of one service, 5 ms apart: a track of separate bars. */
function sequence(n: number) {
  return trace(['svc', Array.from({ length: n }, (_, i) => span(`s${i}`, undefined, i * 100, i * 100 + 50))]);
}

test('scroll keeps the state in step with the scroller, clamped', () => {
  const rig = new Rig(wideTrace(), { height: 240 });
  const r = rig.send({ type: 'scroll', top: 120 });
  assert.equal(rig.state.scrollTop, 120);
  assert.equal(r.dirty, LanesDirty.Scroll);
  assert.equal(r.handled, false);
  assert.equal(r.scrollTo, false);
  assert.equal(rig.send({ type: 'scroll', top: 9999 }).dirty, LanesDirty.Scroll);
  assert.equal(rig.state.scrollTop, 202);
  assert.equal(rig.send({ type: 'scroll', top: 9999 }).dirty, 0, 'no change, nothing to redraw');
});

test('drag pans the window and stops at the ends of the trace', () => {
  const rig = new Rig(wideTrace());
  rig.state = { ...rig.state, camera: withWindow(rig.state.camera, 400, 600) };
  const r = rig.send({ type: 'pan', dx: 75.6 }); // content moves right: earlier times
  assert.equal(r.dirty, LanesDirty.Camera);
  assert.equal(r.handled, true);
  assert.ok(Math.abs(rig.state.camera.t0 - 380) < 1e-6);
  rig.send({ type: 'pan', dx: 1e6 });
  assert.equal(rig.state.camera.t0, 0);
  assert.equal(rig.send({ type: 'pan', dx: 10 }).dirty, 0, 'already at the start');
});

test('ctrl+wheel and pinch zoom around the pointer; a plain wheel scrolls unless wheel-zoom is on', () => {
  const rig = new Rig(wideTrace());
  const x = PLOT_LEFT + 378; // the middle of the plot: 500 ms
  const plain = rig.send({ type: 'wheel', x, dx: 0, dy: -100, ctrl: false, shift: false });
  assert.equal(plain.handled, false, 'native scrolling');
  assert.equal(plain.dirty, 0);

  const zoomed = rig.send({ type: 'wheel', x, dx: 0, dy: -100, ctrl: true, shift: false });
  assert.equal(zoomed.dirty, LanesDirty.Camera);
  assert.equal(zoomed.handled, true);
  const { t0, t1 } = rig.state.camera;
  assert.ok(t1 - t0 < 1000);
  assert.ok(Math.abs((t0 + t1) / 2 - 500) < 1e-6, 'the time under the pointer stays');

  rig.wheelZoom = true;
  const before = rig.state.camera;
  assert.equal(rig.send({ type: 'wheel', x, dx: 0, dy: 100, ctrl: false, shift: false }).dirty, LanesDirty.Camera);
  assert.ok(rig.state.camera.t1 - rig.state.camera.t0 > before.t1 - before.t0, 'positive dy zooms out');

  const pinch = rig.send({ type: 'pinch', x, scale: 2 });
  assert.equal(pinch.dirty, LanesDirty.Camera);
  const afterPinch = rig.state.camera;
  assert.ok(afterPinch.t1 - afterPinch.t0 < before.t1 - before.t0);
});

test('shift+wheel and a horizontal wheel pan', () => {
  const rig = new Rig(wideTrace());
  rig.state = { ...rig.state, camera: withWindow(rig.state.camera, 200, 400) };
  rig.send({ type: 'wheel', x: 300, dx: 0, dy: 40, ctrl: false, shift: true });
  assert.ok(rig.state.camera.t0 > 200, 'shift+wheel down shows later times');
  const t0 = rig.state.camera.t0;
  rig.send({ type: 'wheel', x: 300, dx: 37.8, dy: 5, ctrl: false, shift: false });
  assert.ok(rig.state.camera.t0 > t0, 'a positive horizontal delta shows later times');
});

test('zoomBy and reset', () => {
  const rig = new Rig(wideTrace());
  rig.send({ type: 'zoomBy', factor: 0.5 });
  assert.equal(rig.state.camera.t1 - rig.state.camera.t0, 500);
  assert.equal(rig.send({ type: 'reset' }).dirty, LanesDirty.Camera);
  assert.equal(rig.state.camera.t1, 1000);
  assert.equal(rig.send({ type: 'reset' }).dirty, 0);
});

test('hover reports the element under the pointer once, and the cursor follows', () => {
  const rig = new Rig(wideTrace());
  const over = rig.send({ type: 'hover', x: PLOT_LEFT + 300, y: 49 });
  assert.equal(over.dirty, LanesDirty.Hover);
  assert.equal(over.handled, false);
  assert.equal(over.cursor, 'pointer');
  assert.equal(over.effects.length, 1);
  const effect = over.effects[0];
  assert.ok(effect.type === 'hover' && effect.target !== null && effect.target.part === HitPart.Bar);
  assert.equal(rig.state.hover?.row, rig.row('w'));

  const again = rig.send({ type: 'hover', x: PLOT_LEFT + 310, y: 49 });
  assert.equal(again.dirty, 0, 'still the same bar');
  assert.equal(again.effects.length, 0);

  const ruler = rig.send({ type: 'hover', x: PLOT_LEFT + 310, y: 10 });
  assert.equal(ruler.dirty, LanesDirty.Hover);
  assert.deepEqual(ruler.effects, [{ type: 'hover', target: null }]);
  assert.equal(ruler.cursor, 'default');

  rig.send({ type: 'hover', x: PLOT_LEFT + 300, y: 49 });
  const leave = rig.send({ type: 'leave' });
  assert.equal(leave.dirty, LanesDirty.Hover);
  assert.equal(rig.state.hover, null);
  assert.equal(rig.send({ type: 'leave' }).dirty, 0);
});

test('hovering an idle gap shows a grab cursor, a summary follows the pointer pixel by pixel', () => {
  const rig = new Rig(wideTrace(), { modes: { api: LaneMode.Collapsed } });
  const gap = rig.send({ type: 'hover', x: PLOT_LEFT + 930 * SCALE, y: 76 + 24 + 36 + 9 });
  assert.equal(rig.state.hover?.part, HitPart.IdleGap);
  assert.equal(gap.cursor, 'grab');

  rig.send({ type: 'hover', x: PLOT_LEFT + 100, y: 85 });
  assert.equal(rig.state.hover?.part, HitPart.Summary);
  const move = rig.send({ type: 'hover', x: PLOT_LEFT + 101, y: 85 });
  assert.equal(move.dirty, LanesDirty.Hover, 'the tooltip of a summary depends on the pixel');
});

test('clicking a bar selects its span; additive adds', () => {
  const rig = new Rig(wideTrace());
  const r = rig.send(click(PLOT_LEFT + 300, 49));
  assert.equal(r.handled, true);
  assert.deepEqual(r.effects, [{ type: 'select', rows: [rig.row('w')], primary: rig.row('w'), additive: false }]);
  assert.equal(rig.state.focusItem, rig.s.model.itemOfRow[rig.row('w')]);

  const add = rig.send(click(PLOT_LEFT + 300, 67, true));
  assert.deepEqual(add.effects, [{ type: 'select', rows: [rig.row('w-call')], primary: rig.row('w-call'), additive: true }]);
});

test('clicking a ghost focuses the ghost item, not the span\'s own', () => {
  const rig = new Rig(wideTrace());
  rig.send(click(PLOT_LEFT + 35 * SCALE, 388 + 9));
  const row = rig.row('a-db');
  assert.equal(rig.selected, 'a-db');
  assert.equal(rig.state.focusItem, rig.s.model.ghostItemOfRow[row]);
  assert.notEqual(rig.state.focusItem, rig.s.model.itemOfRow[row]);
});

test('clicking a merged run selects all its spans, the longest as primary, with a key', () => {
  const spans = [span('a', undefined, 0, 5), span('b', undefined, 6, 30), span('c', undefined, 31, 40)];
  const rig = new Rig(trace(['svc', spans], ['long', [span('l', undefined, 0, 4000)]]));
  const r = rig.send(click(PLOT_LEFT + 3, 49));
  assert.equal(r.effects.length, 1);
  const effect = r.effects[0];
  assert.ok(effect.type === 'select');
  assert.deepEqual(effect.rows.map((row) => rig.id(row)), ['a', 'b', 'c']);
  assert.equal(rig.id(effect.primary), 'b');
  assert.match(effect.key ?? '', /^run:\d+:3$/);
  assert.equal(rig.state.focusItem, rig.s.model.itemOfRow[rig.row('b')]);
});

test('clicking a summary selects what the lane has in flight there; an idle spot selects nothing', () => {
  const rig = new Rig(wideTrace(), { modes: { web: LaneMode.Collapsed } });
  const r = rig.send(click(PLOT_LEFT + 300, 50));
  const effect = r.effects[0];
  assert.ok(effect.type === 'select');
  assert.deepEqual(effect.rows.map((row) => rig.id(row)), ['w']);
  assert.match(effect.key ?? '', /^summary:0:/);
  assert.equal(r.handled, true);

  const bg = new Rig(wideTrace(), { modes: { bg: LaneMode.Collapsed } });
  const idle = bg.send(click(PLOT_LEFT + 800 * SCALE, 76 + 312 + 36 + 5));
  assert.deepEqual(idle.effects, []);
  assert.equal(idle.handled, true);
});

test('clicking empty room does nothing', () => {
  const rig = new Rig(wideTrace());
  const r = rig.send(click(PLOT_LEFT + 500 * SCALE, 76 + 14 * 18 + 9));
  assert.equal(r.handled, false);
  assert.deepEqual(r.effects, []);
  assert.equal(rig.send(click(PLOT_LEFT + 10, 10)).handled, false, 'the ruler');
});

test('clicking a lane header collapses it and expands it again', () => {
  const rig = new Rig(wideTrace(), { height: 300 });
  const r = rig.send(click(50, 40 + 100));
  assert.equal(rig.mode('api'), LaneMode.Collapsed);
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.equal(r.handled, true);
  assert.equal(rig.state.stack.levels[1], 0);
  assert.equal(laneHeight(rig.state.stack, 1), 24);
  assert.equal(rig.state.stack.contentHeight, 36 + 24 + 36 + 18);

  rig.send(click(50, 40 + 36 + 5));
  assert.equal(rig.mode('api'), LaneMode.Capped, 'a collapsed lane opens capped');
  assert.equal(rig.state.stack.hidden[1], 5);
  assert.equal(rig.mode('web'), LaneMode.Capped, 'the other lanes are untouched');
});

test('a mode change keeps the lane at the top of the viewport where it is on screen', () => {
  const rig = new Rig(wideTrace(), { height: 200, modes: { api: LaneMode.Full } }); // 160 px of body
  rig.send({ type: 'scroll', top: 250 }); // inside api (36 … 414)
  rig.select('w');
  const before = rig.state.stack.top[1] - rig.state.scrollTop;
  const r = rig.key('Enter'); // collapses web, which is scrolled out of view
  assert.equal(rig.mode('web'), LaneMode.Collapsed);
  assert.equal(rig.state.stack.top[1] - rig.state.scrollTop, before, 'api did not move on screen');
  assert.equal(r.scrollTo, true);
  assert.ok(r.dirty & LanesDirty.Scroll);
  assert.equal(rig.state.scrollTop, 238);
});

test('a mode change drops the hover and tells the store', () => {
  const rig = new Rig(wideTrace());
  rig.send({ type: 'hover', x: PLOT_LEFT + 300, y: 49 });
  const r = rig.send(click(50, 60));
  assert.equal(rig.state.hover, null);
  assert.deepEqual(r.effects, [{ type: 'hover', target: null }]);
  assert.ok(r.dirty & LanesDirty.Hover);
});

test('clicking the overflow row shows the lane in full', () => {
  const rig = new Rig(wideTrace());
  const r = rig.send(click(PLOT_LEFT + 10, 364 + 10));
  assert.equal(rig.mode('api'), LaneMode.Full);
  assert.equal(rig.state.stack.levels[1], 21);
  assert.equal(rig.state.stack.hidden[1], 0);
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.equal(rig.send(click(PLOT_LEFT + 10, 364 + 10)).dirty & LanesDirty.Lanes, 0, 'no overflow row any more: nothing to expand');
});

test('double-click on a bar zooms to it with a little room; on a run to its whole extent', () => {
  const rig = new Rig(wideTrace());
  rig.send({ type: 'doubleClick', x: PLOT_LEFT + 300, y: 67 }); // w-call [10, 990]
  const expected = windowForSpan(10, 990);
  assert.ok(Math.abs(rig.state.camera.t0 - Math.max(0, expected.t0)) < 1e-9);
  assert.ok(Math.abs(rig.state.camera.t1 - Math.min(1000, expected.t1)) < 1e-9);

  const spans = [span('a', undefined, 0, 5), span('b', undefined, 6, 30), span('c', undefined, 31, 40)];
  const runs = new Rig(trace(['svc', spans], ['long', [span('l', undefined, 0, 4000)]]));
  runs.send({ type: 'doubleClick', x: PLOT_LEFT + 3, y: 49 });
  const run = windowForSpan(0, 40); // [-2, 42] is shifted to start at 0
  assert.ok(Math.abs(runs.state.camera.t0) < 1e-9);
  assert.ok(Math.abs(runs.state.camera.t1 - (run.t1 - run.t0)) < 1e-9);
});

test('double-click on an idle gap zooms to the gap, on nothing resets, on a header does nothing', () => {
  const rig = new Rig(wideTrace());
  rig.send({ type: 'doubleClick', x: PLOT_LEFT + 930 * SCALE, y: 424 + 9 });
  const gap = windowForSpan(910, 950);
  assert.ok(Math.abs(rig.state.camera.t0 - gap.t0) < 1e-6);
  assert.ok(Math.abs(rig.state.camera.t1 - gap.t1) < 1e-6);

  rig.send({ type: 'doubleClick', x: PLOT_LEFT + 5, y: 10 });
  assert.equal(rig.state.camera.t1, 1000, 'whole trace again');

  // the stretch before the first span of a lane is a gap to zoom to as well
  const whole = rig.state.camera;
  rig.send({ type: 'doubleClick', x: PLOT_LEFT + 800 * SCALE, y: 424 + 9 });
  const leading = windowForSpan(0, 900);
  const expected = withWindow(whole, leading.t0, leading.t1);
  assert.ok(Math.abs(rig.state.camera.t0 - expected.t0) < 1e-6);
  assert.ok(Math.abs(rig.state.camera.t1 - expected.t1) < 1e-6);
  assert.ok(rig.state.camera.t1 >= 900, 'the whole stretch is in view');
  rig.send({ type: 'doubleClick', x: PLOT_LEFT + 5, y: 10 });

  const zoomed = withWindow(rig.state.camera, 100, 200);
  rig.state = { ...rig.state, camera: zoomed };
  const header = rig.send({ type: 'doubleClick', x: 50, y: 60 });
  assert.equal(header.dirty, 0);
  assert.equal(rig.state.camera, zoomed);
});

test('arrow keys move along the track in time order and stop at its ends', () => {
  const rig = new Rig(sequence(5));
  const r = rig.key('ArrowRight');
  assert.equal(rig.selected, 's0', 'with nothing selected the first bar is taken');
  assert.equal(r.handled, true);
  assert.equal(r.effects.length, 1);
  rig.key('ArrowRight');
  assert.equal(rig.selected, 's1');
  rig.key('ArrowRight');
  rig.key('ArrowRight');
  rig.key('ArrowRight');
  assert.equal(rig.selected, 's4');
  const end = rig.key('ArrowRight');
  assert.equal(rig.selected, 's4', 'no next item');
  assert.equal(end.handled, true);
  assert.deepEqual(end.effects, []);
  rig.key('ArrowLeft');
  assert.equal(rig.selected, 's3');
  assert.equal(rig.state.focusItem, rig.s.model.itemOfRow[rig.row('s3')]);
});

test('with nothing selected, an arrow key takes the first bar at the window start', () => {
  const rig = new Rig(sequence(5));
  rig.state = { ...rig.state, camera: withWindow(rig.state.camera, 220, 400) };
  rig.key('ArrowLeft');
  assert.equal(rig.selected, 's2', 's2 [200, 250] is the first that ends in the window');
});

test('arrow keys move along a ghost track when the ghost is the focus', () => {
  const rig = new Rig(wideTrace());
  rig.send(click(PLOT_LEFT + 35 * SCALE, 388 + 9)); // a-db's ghost, level 0 of postgres
  assert.equal(rig.selected, 'a-db');
  rig.key('ArrowRight'); // nothing follows it on that track: a-db2 overlaps, so it is on level 1
  assert.equal(rig.selected, 'a-db');
  const pg = rig.s.model.names.indexOf('postgres');
  assert.equal(rig.s.model.levelCount[pg], 2);
});

test('up goes to the parent span in any lane, down to the first child', () => {
  const rig = new Rig(wideTrace(), { modes: { api: LaneMode.Full } });
  rig.select('p3');
  rig.key('ArrowUp');
  assert.equal(rig.selected, 'a');
  rig.key('ArrowUp');
  assert.equal(rig.selected, 'w-call', 'the parent is in another lane');
  rig.key('ArrowUp');
  assert.equal(rig.selected, 'w');
  const top = rig.key('ArrowUp');
  assert.equal(rig.selected, 'w');
  assert.deepEqual(top.effects, []);
  assert.equal(top.handled, true);

  rig.key('ArrowDown');
  assert.equal(rig.selected, 'w-call');
  rig.key('ArrowDown');
  assert.equal(rig.selected, 'a');
  rig.key('ArrowDown');
  assert.equal(rig.selected, 'a-db', 'the first child by start');
  assert.equal(rig.key('ArrowDown').effects.length, 0, 'a leaf has no child');
});

test('moving to a span in a collapsed or capped lane opens the lane, scrolls and pans to it', () => {
  const rig = new Rig(wideTrace(), { height: 240, modes: { api: LaneMode.Collapsed } });
  rig.select('w-call');
  const r = rig.key('ArrowDown'); // a, in the collapsed api lane
  assert.equal(rig.selected, 'a');
  assert.equal(rig.mode('api'), LaneMode.Capped);
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.equal(rig.state.focusItem, rig.s.model.itemOfRow[rig.row('a')]);

  rig.select('p17'); // level 18: hidden behind the overflow row
  const hidden = rig.send({ type: 'reveal', row: rig.row('p17'), align: 'nearest' });
  assert.equal(rig.mode('api'), LaneMode.Full);
  assert.ok(hidden.dirty & LanesDirty.Lanes);
  assert.equal(hidden.handled, false);
});

test('reveal expands the lane if it hides the level, scrolls the row in and pans to the span', () => {
  const rig = new Rig(wideTrace(), { height: 240 });
  rig.state = { ...rig.state, camera: withWindow(rig.state.camera, 0, 100) };
  const r = rig.send({ type: 'reveal', row: rig.row('p19'), align: 'center' });
  const k = 1;
  const top = rig.state.stack.top[k] + 20 * 18; // level 20
  assert.equal(rig.mode('api'), LaneMode.Full);
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.ok(r.dirty & LanesDirty.Scroll);
  assert.ok(r.dirty & LanesDirty.Camera);
  assert.equal(r.scrollTo, true);
  assert.ok(top >= rig.state.scrollTop && top + 18 <= rig.state.scrollTop + 200, 'the row is in the body');
  assert.ok(Math.abs(rig.state.camera.t0 - (119 - REVEAL_LEAD * 100)) < 1e-9, 'p19 [119, 419] is longer than the window: it starts a tenth in');
  assert.ok(Math.abs(rig.state.camera.t1 - rig.state.camera.t0 - 100) < 1e-9, 'the window keeps its length');
});

test('reveal of a span in a collapsed lane shows the lane capped, or full if the level needs it', () => {
  const rig = new Rig(wideTrace(), { modes: { api: LaneMode.Collapsed } });
  rig.send({ type: 'reveal', row: rig.row('a-db'), align: 'nearest' });
  assert.equal(rig.mode('api'), LaneMode.Capped);
  rig.send({ type: 'laneMode', lane: 1, mode: LaneMode.Collapsed });
  rig.send({ type: 'reveal', row: rig.row('p18'), align: 'nearest' });
  assert.equal(rig.mode('api'), LaneMode.Full);
  assert.equal(rig.send({ type: 'reveal', row: -1, align: 'nearest' }).dirty, 0);
});

test('reveal changes nothing when the span is already in view', () => {
  const rig = new Rig(wideTrace());
  const state = rig.state;
  const r = rig.send({ type: 'reveal', row: rig.row('w'), align: 'nearest' });
  assert.equal(r.dirty, 0);
  assert.equal(rig.state, state);
});

test('revealing a ghost whose peer lane is hidden falls back to the span\'s own bar', () => {
  const rig = new Rig(wideTrace(), { peers: false, height: 240 });
  const row = rig.row('a-db');
  rig.state = { ...rig.state, focusItem: rig.s.model.ghostItemOfRow[row] };
  const r = rig.send({ type: 'reveal', row, align: 'nearest' });
  assert.equal(rig.state.stack.positionOfLane[rig.s.model.names.indexOf('postgres')], -1);
  assert.equal(r.handled, false);
  // a-db is level 1 of api: its own row is in view
  const top = rig.state.stack.top[1] + 18;
  assert.ok(top >= rig.state.scrollTop && top + 18 <= rig.state.scrollTop + 200);
});

test('zoom keys: plus, minus, zero', () => {
  const rig = new Rig(wideTrace());
  rig.key('+');
  assert.ok(Math.abs(rig.state.camera.t1 - rig.state.camera.t0 - 1000 / KEY_ZOOM_STEP) < 1e-6);
  rig.key('=');
  rig.key('-');
  rig.key('_');
  rig.key('0');
  assert.equal(rig.state.camera.t1, 1000);
  assert.equal(rig.state.camera.t0, 0);
  rig.key('+');
  rig.key('Home');
  assert.equal(rig.state.camera.t1, 1000);
});

test('F zooms to the selection, with nothing selected it does nothing', () => {
  const rig = new Rig(wideTrace());
  const none = rig.key('f');
  assert.equal(none.handled, true);
  assert.equal(none.dirty, 0);

  rig.select('b2'); // [950, 960]
  rig.key('F');
  const expected = windowForSpan(950, 960);
  assert.ok(Math.abs(rig.state.camera.t0 - expected.t0) < 1e-6);
  assert.ok(Math.abs(rig.state.camera.t1 - Math.min(1000, expected.t1)) < 1e-6 || rig.state.camera.t1 <= 1000);

  rig.send({ type: 'reset' });
  rig.selectedRow = rig.row('p0');
  rig.selection = selectionMasks(rig.s.index, [rig.row('p0'), rig.row('p19')]);
  rig.key('f');
  assert.ok(rig.state.camera.t0 < 100 && rig.state.camera.t1 > 419, 'the extent of the whole selection');
});

test('Enter and Space toggle the lane of the selection', () => {
  const rig = new Rig(wideTrace());
  rig.select('a');
  const r = rig.key('Enter');
  assert.equal(rig.mode('api'), LaneMode.Collapsed);
  assert.equal(r.handled, true);
  rig.key(' ');
  assert.equal(rig.mode('api'), LaneMode.Capped);

  const none = new Rig(wideTrace());
  assert.equal(none.key('Enter').handled, false);
  assert.equal(none.key(' ').handled, true, 'Space must not scroll the page');
});

test('Enter on a ghost toggles the peer lane', () => {
  const rig = new Rig(wideTrace());
  rig.send(click(PLOT_LEFT + 35 * SCALE, 388 + 9));
  rig.key('Enter');
  assert.equal(rig.mode('postgres'), LaneMode.Collapsed);
  assert.equal(rig.mode('api'), LaneMode.Capped);
});

test('E expands every collapsed lane, G collapses all', () => {
  const rig = new Rig(wideTrace(), { modes: { web: LaneMode.Collapsed, api: LaneMode.Full } });
  const e = rig.key('E', { shift: true });
  assert.equal(rig.mode('web'), LaneMode.Capped);
  assert.equal(rig.mode('api'), LaneMode.Full, 'lanes that are open stay as they are');
  assert.ok(e.dirty & LanesDirty.Lanes);
  assert.equal(rig.key('e').dirty & LanesDirty.Lanes, 0, 'nothing left to expand');

  const g = rig.key('g');
  for (const name of rig.s.model.names) assert.equal(rig.mode(name), LaneMode.Collapsed, name);
  assert.ok(g.dirty & LanesDirty.Lanes);
  assert.equal(rig.state.stack.contentHeight, 4 * 24);
  rig.send({ type: 'expandAll' });
  assert.equal(rig.mode('api'), LaneMode.Capped);
  rig.send({ type: 'collapseAll' });
  assert.equal(rig.mode('web'), LaneMode.Collapsed);
});

test('the laneMode input sets one lane', () => {
  const rig = new Rig(wideTrace());
  rig.send({ type: 'laneMode', lane: 1, mode: LaneMode.Full });
  assert.equal(rig.mode('api'), LaneMode.Full);
  assert.equal(rig.send({ type: 'laneMode', lane: 99, mode: LaneMode.Full }).dirty, 0);
  assert.equal(rig.send({ type: 'laneMode', lane: 1, mode: LaneMode.Full }).dirty, 0, 'no change');
});

test('Escape, unknown keys and modified keys are not handled', () => {
  const rig = new Rig(wideTrace());
  assert.equal(rig.key('Escape').handled, false);
  assert.equal(rig.key('x').handled, false);
  assert.equal(rig.key('+', { ctrl: true }).handled, false);
  assert.equal(rig.key('e', { alt: true }).handled, false);
});

test('PageDown scrolls by a body height', () => {
  const rig = new Rig(wideTrace(), { height: 240 });
  const r = rig.key('PageDown');
  assert.equal(rig.state.scrollTop, 200);
  assert.equal(r.scrollTo, true);
  assert.equal(rig.key('PageDown').dirty & LanesDirty.Scroll, LanesDirty.Scroll);
  assert.equal(rig.state.scrollTop, 202);
  assert.equal(rig.key('PageDown').dirty, 0);
  rig.key('PageUp');
  assert.equal(rig.state.scrollTop, 2);
});

test('resize fits the camera to the new plot and clamps the scroll position', () => {
  const rig = new Rig(wideTrace(), { height: 240 });
  rig.send({ type: 'scroll', top: 200 });
  const bigger = new Rig(wideTrace(), { height: 2000, width: 1200 });
  const r = reduceInteraction(rig.state, { type: 'resize' }, bigger.ctx());
  assert.equal(r.state.camera.widthPx, bigger.s.layout.plotWidth);
  assert.equal(r.state.scrollTop, 0);
  assert.equal(r.scrollTo, true);
  assert.equal(r.dirty, LanesDirty.Size | LanesDirty.Camera | LanesDirty.Scroll);
  assert.equal(r.handled, false);
});

test('fitViewState returns the same state when nothing changes', () => {
  const rig = new Rig(wideTrace());
  assert.equal(fitViewState(rig.state, rig.s.layout), rig.state);
});

test('anchoredScrollTop keeps a lane still when the lanes above it change height', () => {
  const rig = new Rig(wideTrace(), { height: 240 });
  const before = rig.state.stack;
  const collapsedWeb = new Rig(wideTrace(), { height: 240, modes: { web: LaneMode.Collapsed } }).state.stack;
  // api starts at 36; scrolled 50 px into it. After web collapses to 24 px, api starts at 24.
  assert.equal(anchoredScrollTop(before, collapsedWeb, rig.s.layout, 50, 1), 50 - 12);
  assert.equal(anchoredScrollTop(before, collapsedWeb, rig.s.layout, 0, -1), 0, 'the lane at the top of the viewport is web: it stays at the top');
  assert.equal(laneAt(before, 50), 1);
  // anchored on the lane at the top of the viewport
  assert.equal(anchoredScrollTop(before, collapsedWeb, rig.s.layout, 50, -1), 50 - 12);
});

test('revealTime centres a short span and leads a long one; windowForSpan pads', () => {
  const camera = createCamera(1000, 756);
  const window = withWindow(camera, 100, 200);
  assert.equal(revealTime(window, 150, 160), window, 'already inside');
  const centred = revealTime(window, 500, 510);
  assert.equal(centred.t1 - centred.t0, 100);
  assert.equal((centred.t0 + centred.t1) / 2, 505);
  const long = revealTime(window, 500, 900);
  assert.ok(Math.abs(long.t0 - (500 - REVEAL_LEAD * 100)) < 1e-9);

  assert.deepEqual(windowForSpan(100, 200), { t0: 95, t1: 205 });
  const instant = windowForSpan(5, 5);
  assert.ok(instant.t1 - instant.t0 >= 2 * MIN_WINDOW_MS);
});
