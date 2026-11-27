/**
 * The lanes controller against a real store: the glue between shared state and the view.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpanMask,
  buildSpanIndex,
  createTraceStore,
  type ChangeSet,
  type SpanIndex,
  type TraceData,
  type TraceStore,
} from '../../../src/core/index.ts';
import { LanesController } from '../../../src/views/lanes/controller.ts';
import { HitPart } from '../../../src/views/lanes/model/hit.ts';
import { LanesDirty } from '../../../src/views/lanes/model/interaction.ts';
import { LaneMode } from '../../../src/views/lanes/model/layout.ts';
import { LanesFramePlan, RunFlag } from '../../../src/views/lanes/model/plan.ts';
import { DEFAULT_LANES_SETTINGS } from '../../../src/views/lanes/settings.ts';
import { span, trace } from '../../support/trace-builder.ts';
import { fitText, wideTrace } from '../../support/lanes-scene.ts';

const SCALE = 756 / 1000;
const PLOT_LEFT = 220;

interface Harness {
  readonly store: TraceStore;
  readonly view: LanesController;
  readonly plan: LanesFramePlan;
  /** Delivers pending store changes to the controller and returns what it asks to redraw. */
  flush(): { dirty: number; scrollTo: boolean };
  /** Plan the frame the way the view does. */
  paint(): LanesFramePlan;
}

function harness(data: TraceData = wideTrace(), height = 600): Harness {
  const store = createTraceStore({ schedule: () => undefined });
  const index = buildSpanIndex(data);
  store.setData(index);
  const view = new LanesController({ store, origin: 'lanes-1' });
  view.resize(1000, height);

  const changes: ChangeSet[] = [];
  store.subscribe((change) => changes.push(change));
  store.flushSync();
  changes.length = 0;
  const plan = new LanesFramePlan();
  return {
    store,
    view,
    plan,
    flush() {
      store.flushSync();
      let dirty = 0;
      let scrollTo = false;
      for (const change of changes.splice(0)) {
        const result = view.update(change);
        dirty |= result.dirty;
        scrollTo ||= result.scrollTo;
      }
      return { dirty, scrollTo };
    },
    paint() {
      view.buildPlan(plan, fitText);
      return plan;
    },
  };
}

const rowOf = (index: SpanIndex, id: string): number => index.table.ids.indexOf(id);

function runOf(h: Harness, id: string): number {
  const model = h.view.model;
  const row = rowOf(h.view.index, id);
  for (let r = 0; r < h.plan.runCount; r++) {
    for (let i = h.plan.runFirst[r]; i < h.plan.runFirst[r] + h.plan.runItems[r]; i++) {
      if (model.itemRow[i] === row && model.itemGhost[i] === 0) return r;
    }
  }
  return -1;
}

test('a new controller shows the whole trace, every lane capped, laid out for its size', () => {
  const h = harness();

  assert.equal(h.view.layout.plotWidth, 756);
  assert.equal(h.view.state.camera.widthPx, 756);
  assert.equal(h.view.state.camera.t1, 1000);
  assert.deepEqual(Array.from(h.view.state.stack.lane, (l) => h.view.model.names[l]), ['web', 'api', 'postgres', 'bg']);
  assert.ok(Array.from(h.view.state.stack.modes).every((m) => m === LaneMode.Capped));
  assert.equal(h.view.selectedRow, -1);
  assert.equal(h.view.zoomReadout(), '100%');
  assert.deepEqual(h.view.settings, DEFAULT_LANES_SETTINGS);
});

test('resize fits the camera and says what to redraw', () => {
  const h = harness();
  assert.deepEqual(h.view.resize(1000, 600), { dirty: 0, scrollTo: false }, 'same size');
  const r = h.view.resize(1200, 300);
  assert.equal(r.dirty, LanesDirty.Size | LanesDirty.Camera | LanesDirty.Scroll);
  assert.equal(h.view.state.camera.widthPx, 1200 - 220 - 24);
  h.view.input({ type: 'scroll', top: 100 });
  const smaller = h.view.resize(1200, 600);
  assert.equal(smaller.scrollTo, true, 'the scroll position was clamped');
  assert.equal(h.view.state.scrollTop, 0);
});

test('the plan is built from the controller and picking agrees with it', () => {
  const h = harness();
  const plan = h.paint();
  assert.equal(h.view.plan, plan);
  assert.equal(plan.headerCount, 4);

  const hit = h.view.hit(PLOT_LEFT + 300, 49);
  assert.equal(hit.part, HitPart.Bar);
  assert.equal(h.view.index.table.ids[hit.row], 'w');
  assert.equal(h.view.describeHit(hit)?.title, 'w');
});

test('clicking a bar selects its span in the store, with the view as origin', () => {
  const h = harness();
  h.paint();
  const seen: string[] = [];
  h.store.subscribe((change) => seen.push(change.origin));

  const r = h.view.input({ type: 'click', x: PLOT_LEFT + 300, y: 67, additive: false });
  assert.equal(r.handled, true);
  assert.equal(h.store.state.selection.primary, 'w-call');
  assert.deepEqual([...h.store.state.selection.ids], ['w-call']);
  assert.equal(h.store.state.selection.origin, 'lanes-1');
  assert.equal(h.view.selectedRow, rowOf(h.view.index, 'w-call'));

  h.view.input({ type: 'click', x: PLOT_LEFT + 300, y: 49, additive: true });
  assert.deepEqual([...h.store.state.selection.ids].sort(), ['w', 'w-call']);
  assert.equal(h.store.state.selection.primary, 'w');
  h.store.flushSync();
  assert.ok(seen.every((origin) => origin === 'lanes-1'));
});

test('clicking a merged run selects its spans with a key and the longest as primary; a summary the requests in flight', () => {
  const spans = [span('a', undefined, 0, 5), span('b', undefined, 6, 30), span('c', undefined, 31, 40)];
  const h = harness(trace(['svc', spans], ['long', [span('l', undefined, 0, 4000)]]));
  h.paint();
  h.view.input({ type: 'click', x: PLOT_LEFT + 3, y: 49, additive: false });
  assert.deepEqual([...h.store.state.selection.ids].sort(), ['a', 'b', 'c']);
  assert.equal(h.store.state.selection.primary, 'b');
  assert.match(h.store.state.selection.key ?? '', /^run:\d+:3$/);

  const w = harness();
  w.view.input({ type: 'collapseAll' });
  w.paint();
  w.view.input({ type: 'click', x: PLOT_LEFT + 300, y: 40 + 5, additive: false });
  assert.deepEqual([...w.store.state.selection.ids], ['w']);
  assert.match(w.store.state.selection.key ?? '', /^summary:/);
  w.view.input({ type: 'key', key: 'Escape', shift: false, ctrl: false, alt: false });
});

test('hovering a bar or a run hovers its spans in the store; anything else clears the hover', () => {
  const h = harness();
  h.paint();
  h.view.input({ type: 'hover', x: PLOT_LEFT + 300, y: 49 });
  assert.deepEqual([...(h.store.state.hover?.ids ?? [])], ['w']);
  assert.equal(h.store.state.hover?.origin, 'lanes-1');
  assert.equal(h.view.isHovered(rowOf(h.view.index, 'w')), true);
  h.view.input({ type: 'hover', x: 50, y: 60 }); // a header
  assert.equal(h.store.state.hover, null);
  assert.equal(h.view.isHovered(rowOf(h.view.index, 'w')), false);

  const spans = [span('a', undefined, 0, 5), span('b', undefined, 6, 30), span('c', undefined, 31, 40)];
  const runs = harness(trace(['svc', spans], ['long', [span('l', undefined, 0, 4000)]]));
  runs.paint();
  runs.view.input({ type: 'hover', x: PLOT_LEFT + 3, y: 49 });
  assert.deepEqual([...(runs.store.state.hover?.ids ?? [])].sort(), ['a', 'b', 'c']);
  assert.equal(runs.store.state.hover?.primary, 'b');
  runs.view.input({ type: 'leave' });
  assert.equal(runs.store.state.hover, null);
});

test('a selection made elsewhere dims what is not on its causal tree, and ghosts follow their span', () => {
  const h = harness();
  h.store.setSelection(['p3'], { origin: 'api' });
  const r = h.flush();
  assert.ok(r.dirty & LanesDirty.Selection);
  assert.equal(h.view.selectedRow, rowOf(h.view.index, 'p3'));
  assert.equal(h.view.isSelected(rowOf(h.view.index, 'p3')), true);
  assert.equal(h.view.isSelected(rowOf(h.view.index, 'p4')), false);

  h.paint();
  const flags = (id: string): number => h.plan.runFlags[runOf(h, id)];
  for (const id of ['w', 'w-call', 'a', 'p3']) assert.ok(flags(id) & RunFlag.Related, id);
  for (const id of ['p4', 'b1']) assert.ok(flags(id) & RunFlag.Faded, id);
  assert.ok(flags('p3') & RunFlag.Selected);

  h.store.setSelection([], { origin: 'api' });
  h.flush();
  h.paint();
  for (let r2 = 0; r2 < h.plan.runCount; r2++) assert.equal(h.plan.runFlags[r2] & (RunFlag.Related | RunFlag.Faded), 0);
});

test('a hover made elsewhere is flagged in the plan', () => {
  const h = harness();
  h.store.setHover(['a-db2'], { origin: 'api' });
  assert.ok(h.flush().dirty & LanesDirty.Hover);
  h.paint();
  assert.ok(h.plan.runFlags[runOf(h, 'a-db2')] & RunFlag.Hovered);
});

test('reveal expands a capped lane that hides the span, scrolls to it and pans the window', () => {
  const h = harness(wideTrace(), 240);
  h.view.input({ type: 'zoomBy', factor: 0.1 });
  const r = h.view.reveal('p19');
  const api = h.view.model.names.indexOf('api');

  assert.equal(h.view.state.stack.modes[api], LaneMode.Full);
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.ok(r.dirty & LanesDirty.Scroll);
  assert.equal(r.scrollTo, true);
  const camera = h.view.state.camera;
  assert.ok(camera.t0 < 419 && camera.t1 > 119, 'p19 [119, 419] overlaps the window');
  const k = h.view.state.stack.positionOfLane[api];
  const top = h.view.state.stack.top[k] + 20 * 18;
  assert.ok(top >= h.view.state.scrollTop && top + 18 <= h.view.state.scrollTop + h.view.layout.bodyHeight);
  assert.equal(h.store.state.selection.primary, null, 'reveal does not select');

  assert.equal(h.view.reveal('nope').handled, false);
  assert.equal(h.view.reveal('nope').dirty, 0);
});

test('an external window moves the camera; its own window is ignored', () => {
  const h = harness();
  h.store.setWindow({ t0: 100, t1: 300 }, { origin: 'api' });
  const r = h.flush();
  assert.ok(r.dirty & LanesDirty.Camera);
  assert.equal(h.view.state.camera.t0, 100);
  assert.equal(h.view.state.camera.t1, 300);
  assert.equal(h.view.state.camera.widthPx, 756);

  h.store.setWindow({ t0: 500, t1: 600 }, { origin: 'lanes-1' });
  assert.equal(h.flush().dirty & LanesDirty.Camera, 0);
  assert.equal(h.view.state.camera.t0, 100);

  h.store.setWindow(null, { origin: 'api' });
  assert.equal(h.flush().dirty, 0, 'a cleared window changes nothing here, like the waterfall');
});

test('getState and setState round trip the camera, the scroll position and the lane modes by name', () => {
  const h = harness(wideTrace(), 240);
  h.view.input({ type: 'laneMode', lane: h.view.model.names.indexOf('bg'), mode: LaneMode.Collapsed });
  h.view.input({ type: 'laneMode', lane: h.view.model.names.indexOf('api'), mode: LaneMode.Full });
  h.view.input({ type: 'pan', dx: 0 });
  h.view.input({ type: 'zoomBy', factor: 0.25 });
  h.view.input({ type: 'scroll', top: 90 });
  const saved = h.view.getState();

  assert.equal(saved.generation, h.store.state.data.generation);
  assert.equal(saved.scrollTop, 90);
  assert.equal(saved.t1 - saved.t0, 250);
  assert.deepEqual(saved.laneModes, { web: 'capped', api: 'full', bg: 'collapsed', postgres: 'capped' });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, 'plain data');

  const fresh = new LanesController({ store: h.store, origin: 'lanes-2' });
  fresh.resize(1000, 240);
  const r = fresh.setState(saved);
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.equal(r.scrollTo, true);
  assert.deepEqual(fresh.getState(), saved);
  assert.equal(fresh.state.stack.contentHeight, h.view.state.stack.contentHeight);
});

test('setState ignores a state of another trace, and anything malformed', () => {
  const h = harness();
  const saved = h.view.getState();
  const other = harness();
  other.store.setData(buildSpanIndex(trace(['x', [span('x', undefined, 0, 10)]])));
  other.flush();
  const before = other.view.getState();

  assert.deepEqual(other.view.setState({ ...saved, t0: 100, t1: 200, laneModes: { x: 'collapsed' } }), { dirty: 0, scrollTo: false });
  assert.deepEqual(other.view.getState(), before);
  assert.deepEqual(h.view.setState(null), { dirty: 0, scrollTo: false });
  assert.deepEqual(h.view.setState('x'), { dirty: 0, scrollTo: false });

  h.view.setState({ generation: saved.generation, t0: 'a', t1: NaN, scrollTop: -5, laneModes: { web: 'bogus', api: 'collapsed', ghost: 'full' } });
  assert.equal(h.view.state.camera.t0, 0);
  assert.equal(h.view.state.camera.t1, 1000);
  assert.equal(h.view.state.scrollTop, 0);
  assert.equal(h.view.state.stack.modes[h.view.model.names.indexOf('web')], LaneMode.Capped);
  assert.equal(h.view.state.stack.modes[h.view.model.names.indexOf('api')], LaneMode.Collapsed);
});

test('a filter dims spans that do not match; nothing is repacked or moved', () => {
  const h = harness();
  const before = h.paint();
  const x0 = Array.from(before.runX0.subarray(0, before.runCount));
  const first = Array.from(before.runFirst.subarray(0, before.runCount));
  const levels = Array.from(before.rowLevel.subarray(0, before.rowCount));
  const count = before.runCount;

  h.store.setMatched(SpanMask.of(h.view.index, ['a-db', 'p3']));
  const r = h.flush();
  assert.ok(r.dirty & LanesDirty.Filter);
  const after = h.paint();

  assert.equal(after.runCount, count);
  assert.deepEqual(Array.from(after.runX0.subarray(0, count)), x0);
  assert.deepEqual(Array.from(after.runFirst.subarray(0, count)), first);
  assert.deepEqual(Array.from(after.rowLevel.subarray(0, after.rowCount)), levels);
  assert.equal(after.runFlags[runOf(h, 'a-db')] & RunFlag.Dimmed, 0);
  assert.ok(after.runFlags[runOf(h, 'p4')] & RunFlag.Dimmed);

  h.store.setMatched(null);
  assert.ok(h.flush().dirty & LanesDirty.Filter);
  h.paint();
  for (let k = 0; k < h.plan.runCount; k++) assert.equal(h.plan.runFlags[k] & RunFlag.Dimmed, 0);
});

test('collapsed summaries count only matched spans while a filter is active', () => {
  const h = harness();
  h.view.input({ type: 'collapseAll' });
  const plain = h.paint();
  const api = h.view.model.names.indexOf('api');
  const slot = (p: LanesFramePlan): number => Array.from({ length: p.summaryCount }, (_, k) => k).find((k) => p.summaryLane[k] === api) ?? -1;
  const unfiltered = plain.summaryPath[slot(plain)];
  assert.notEqual(unfiltered, '');

  h.store.setMatched(SpanMask.of(h.view.index, ['w']));
  h.flush();
  const filtered = h.paint();
  assert.equal(filtered.summaryPath[slot(filtered)], '', 'no matched request in api');

  h.store.setMatched(SpanMask.of(h.view.index, ['a']));
  h.flush();
  assert.notEqual(h.paint().summaryPath[slot(h.plan)], '');
});

test('the collapse state of the store is ignored', () => {
  const h = harness();
  const before = h.paint();
  const count = before.runCount;
  h.store.collapseAll({ origin: 'api' });
  assert.equal(h.flush().dirty, 0);
  assert.equal(h.paint().runCount, count);
});

test('new data resets the view', () => {
  const h = harness();
  h.view.input({ type: 'collapseAll' });
  h.view.input({ type: 'zoomBy', factor: 0.5 });
  const generation = h.view.getState().generation;
  h.store.setData(buildSpanIndex(trace(['solo', [span('s', undefined, 0, 50)]])));
  const r = h.flush();

  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.ok(r.dirty & LanesDirty.Camera);
  assert.equal(r.scrollTo, true);
  assert.deepEqual(h.view.model.names, ['solo']);
  assert.equal(h.view.state.camera.t1, 50);
  assert.equal(h.view.state.camera.widthPx, 756);
  assert.equal(h.view.state.stack.modes[0], LaneMode.Capped);
  assert.equal(h.view.plan.model, null, 'the old plan does not answer for the new data');
  assert.ok(h.view.getState().generation > generation);
});

test('theme and config changes ask for a repaint', () => {
  const h = harness();
  h.store.touch(128, { origin: 'shell' });
  assert.equal(h.flush().dirty, LanesDirty.Theme);
});

test('commands: zoom, reset with a readout, expand all and collapse all', () => {
  const h = harness();
  const results: number[] = [];
  const commands = h.view.commands((result) => results.push(result.dirty));
  assert.deepEqual(commands.map((c) => c.id), ['zoom-in', 'zoom-out', 'zoom-reset', 'expand-all', 'collapse-all']);
  const byId = (id: string) => commands.find((c) => c.id === id);

  assert.deepEqual(byId('zoom-in')?.keys, ['+', '=']);
  assert.deepEqual(byId('expand-all')?.keys, ['e', 'E']);
  assert.deepEqual(byId('collapse-all')?.keys, ['g', 'G']);

  byId('zoom-in')?.run();
  assert.ok(h.view.state.camera.t1 < 1000);
  assert.equal(byId('zoom-reset')?.readout?.(), '120%');
  assert.deepEqual(results, [LanesDirty.Camera]);
  byId('zoom-out')?.run();
  byId('zoom-reset')?.run();
  assert.equal(byId('zoom-reset')?.readout?.(), '100%');

  assert.equal(byId('expand-all')?.enabled?.(), false, 'nothing is collapsed');
  assert.equal(byId('collapse-all')?.enabled?.(), true);
  byId('collapse-all')?.run();
  assert.ok(Array.from(h.view.state.stack.modes).every((m) => m === LaneMode.Collapsed));
  assert.equal(byId('collapse-all')?.enabled?.(), false);
  assert.equal(byId('expand-all')?.enabled?.(), true);
  byId('expand-all')?.run();
  assert.ok(Array.from(h.view.state.stack.modes).every((m) => m === LaneMode.Capped));
});

test('settings: max rows, row height, peers, order and the wheel', () => {
  const h = harness();
  const api = h.view.model.names.indexOf('api');

  let r = h.view.applySettings({ maxRows: 4 });
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.equal(h.view.state.stack.levels[h.view.state.stack.positionOfLane[api]], 4);
  assert.equal(h.view.state.stack.hidden[h.view.state.stack.positionOfLane[api]], 17);

  h.view.applySettings({ rowHeight: 24 });
  assert.equal(h.view.layout.rowHeight, 24);
  assert.equal(h.view.layout.barHeight, 22);

  r = h.view.applySettings({ peers: false });
  assert.ok(r.dirty & LanesDirty.Lanes);
  assert.deepEqual(Array.from(h.view.state.stack.lane, (l) => h.view.model.names[l]), ['web', 'api', 'bg']);
  h.paint();
  assert.equal(h.plan.headerName.slice(0, h.plan.headerCount).includes('postgres'), false);
  h.view.applySettings({ peers: true });
  assert.equal(h.view.state.stack.count, 4);

  h.view.applySettings({ order: 'name' });
  assert.deepEqual(Array.from(h.view.state.stack.lane, (l) => h.view.model.names[l]), ['api', 'bg', 'postgres', 'web']);

  h.view.applySettings({ gutterWidth: 100 });
  assert.equal(h.view.layout.plotLeft, 100);
  assert.equal(h.view.state.camera.widthPx, 1000 - 100 - 24);

  h.view.applySettings({ wheelZoom: true });
  const before = h.view.state.camera;
  h.view.input({ type: 'wheel', x: 400, dx: 0, dy: -100, ctrl: false, shift: false });
  assert.ok(h.view.state.camera.t1 - h.view.state.camera.t0 < before.t1 - before.t0);

  h.view.setMetrics({ summaryHeight: 30 });
  assert.equal(h.view.layout.summaryHeight, 30);
});

test('lane modes survive a settings change', () => {
  const h = harness();
  h.view.input({ type: 'laneMode', lane: 0, mode: LaneMode.Collapsed });
  h.view.applySettings({ maxRows: 8 });
  assert.equal(h.view.state.stack.modes[0], LaneMode.Collapsed);
});

test('describeHit: a ghost bar says whom it calls', () => {
  const h = harness();
  h.paint();
  const hit = h.view.hit(PLOT_LEFT + 35 * SCALE, 388 + 9);
  const info = h.view.describeHit(hit);
  assert.equal(info?.title, 'a-db');
  const rows = info?.sections[0].rows ?? [];
  assert.deepEqual(rows[rows.length - 1], ['Seen as', 'call to postgres']);
});

test('describeHit: a run, a summary, an overflow row, an idle gap, a header and the ruler', () => {
  const spans = [span('a', undefined, 0, 5), span('b', undefined, 6, 30, { status: { code: 2 } }), span('c', undefined, 31, 40)];
  const r = harness(trace(['svc', spans], ['long', [span('l', undefined, 0, 4000)]]));
  r.paint();
  const run = r.view.describeHit(r.view.hit(PLOT_LEFT + 3, 49));
  assert.equal(run?.title, '3 spans');
  assert.equal(run?.subtitle, 'svc');
  assert.equal(run?.status, 'error');
  assert.deepEqual(run?.sections[0].rows, [
    ['Spans', '3'],
    ['Total', '38.00ms'],
    ['Range', '+0µs – +40.00ms'],
    ['Errors', '1'],
  ]);

  const h = harness();
  h.view.input({ type: 'laneMode', lane: h.view.model.names.indexOf('web'), mode: LaneMode.Collapsed });
  h.paint();
  const summary = h.view.describeHit(h.view.hit(PLOT_LEFT + 300, 50));
  assert.equal(summary?.title, 'web');
  assert.equal(summary?.subtitle, 'Summary');
  const summaryRows = new Map(summary?.sections[0].rows);
  assert.equal(summaryRows.get('In flight'), '1');
  assert.equal(summaryRows.get('Peak'), '1');
  assert.equal(summaryRows.get('Busy'), '100%');
  assert.match(summaryRows.get('At') ?? '', /^\+/);

  // the overflow row of api: 5 levels hidden, the workers p15 … p19 are in flight at 300 ms
  const apiTop = 40 + 24 + 16 * 18;
  const overflow = h.view.describeHit(h.view.hit(PLOT_LEFT + 300 * SCALE, apiTop + 10));
  assert.equal(overflow?.title, '+5 rows');
  assert.equal(overflow?.subtitle, 'api');
  const overflowRows = new Map(overflow?.sections[0].rows);
  assert.equal(overflowRows.get('In flight'), '5');
  assert.equal(overflowRows.get('Peak'), '5');
  assert.equal(overflowRows.get('Levels'), '21');

  const idle = h.view.describeHit(h.view.hit(PLOT_LEFT + 930 * SCALE, 40 + 24 + 312 + 36 + 9));
  assert.equal(idle?.title, 'Idle 40.00ms');
  assert.equal(idle?.subtitle, 'bg');
  assert.deepEqual(idle?.sections[0].rows, [['From', '+910.00ms'], ['To', '+950.00ms']]);

  const header = h.view.describeHit(h.view.hit(50, 40 + 24 + 100));
  assert.equal(header?.title, 'api');
  assert.equal(header?.subtitle, 'Service lane');
  assert.equal(header?.status, 'error');
  const headerRows = new Map(header?.sections[0].rows);
  assert.equal(headerRows.get('Spans'), '23');
  assert.equal(headerRows.get('Errors'), '1');
  assert.equal(headerRows.get('Peak'), '1');
  assert.equal(headerRows.get('Busy'), '96%');
  assert.equal(headerRows.get('Self time'), '6.66s', 'the workers\' 6 s and the rest of a');

  const peer = h.view.describeHit(h.view.hit(50, 40 + 24 + 312 + 10));
  assert.equal(peer?.title, 'postgres');
  assert.equal(peer?.subtitle, 'Peer lane');
  assert.equal(new Map(peer?.sections[0].rows).has('Self time'), false);

  assert.equal(h.view.describeHit(h.view.hit(PLOT_LEFT + 10, 10)), null, 'the ruler has nothing to say');
  assert.equal(h.view.describeHit(h.view.hit(-5, 10)), null);
});

test('the self-time of a lane header follows the shared window', () => {
  const h = harness();
  h.paint();
  const hit = { ...h.view.hit(50, 100) };
  const all = new Map(h.view.describeHit(hit)?.sections[0].rows).get('Self time');
  h.store.setWindow({ t0: 100, t1: 200 }, { origin: 'api' });
  h.flush();
  const windowed = new Map(h.view.describeHit(hit)?.sections[0].rows).get('Self time');
  assert.notEqual(windowed, all);
});
