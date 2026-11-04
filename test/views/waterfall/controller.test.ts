/**
 * The waterfall controller against a real store: the glue between shared state and the view.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpanMask,
  buildSpanIndex,
  createTraceStore,
  type ChangeSet,
  type SpanIndex,
  type TraceStore,
} from '../../../src/core.ts';
import { WaterfallController } from '../../../src/views/waterfall/controller.ts';
import { WaterfallDirty } from '../../../src/views/waterfall/model/interaction.ts';
import { FramePlan } from '../../../src/views/waterfall/model/plan.ts';
import { span, trace, treeTrace, type TreeNode } from '../../support/trace-builder.ts';
import { monospace } from '../../support/waterfall-scene.ts';

const PLOT_LEFT = 250;
const SCALE = 726 / 1000;

//   r [0, 1000] ├ a [100, 400] (children a1, a2) ├ b [450, 455] └ c [900, 1000]
const TREE: TreeNode = {
  id: 'r', start: 0, end: 1000, children: [
    { id: 'a', start: 100, end: 400, children: [{ id: 'a1', start: 110, end: 150 }, { id: 'a2', start: 160, end: 200 }] },
    { id: 'b', start: 450, end: 455 },
    { id: 'c', start: 900, end: 1000 },
  ],
};

interface Harness {
  readonly store: TraceStore;
  readonly view: WaterfallController;
  /** Delivers pending store changes to the controller and returns what it asks to redraw. */
  flush(): { dirty: number; scrollTo: boolean };
}

function harness(index: SpanIndex = buildSpanIndex(treeTrace(TREE)), height = 600): Harness {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(index);
  const view = new WaterfallController({ store, origin: 'wf-1' });
  view.resize(1000, height);

  const changes: ChangeSet[] = [];
  store.subscribe((change) => changes.push(change));
  store.flushSync();
  changes.length = 0;
  return {
    store,
    view,
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
  };
}

function ids(h: Harness): string[] {
  return Array.from(h.view.projection.rows, (row) => h.view.index.table.ids[row]);
}

test('a new controller shows every row, laid out for its size', () => {
  const h = harness();

  assert.deepEqual(ids(h), ['r', 'a', 'a1', 'a2', 'b', 'c']);
  assert.equal(h.view.layout.plotWidth, 726);
  assert.equal(h.view.state.camera.widthPx, 726);
  assert.equal(h.view.selectedRow, -1);
  assert.equal(h.view.zoomReadout(), '100%');
});

test('resizing refits the camera and reports what to redraw once', () => {
  const h = harness();

  const same = h.view.resize(1000, 600);
  assert.deepEqual(same, { dirty: 0, scrollTo: false });

  const wider = h.view.resize(1400, 600);
  assert.ok(wider.dirty & WaterfallDirty.Size);
  assert.equal(h.view.state.camera.widthPx, 1400 - 250 - 24);
  assert.deepEqual([h.view.state.camera.t0, h.view.state.camera.t1], [0, 1000], 'the window itself stays');
});

test('a click on a bar selects the span in the store, under the view\'s own origin', () => {
  const h = harness();
  const changes: ChangeSet[] = [];
  h.store.subscribe((change) => changes.push(change), 2);

  const result = h.view.input({ type: 'click', x: PLOT_LEFT + 450 * SCALE, y: 40 + 4 * 35 + 17, additive: false });
  h.store.flushSync();

  assert.equal(result.handled, true);
  assert.equal(h.store.state.selection.primary, 'b');
  assert.equal(h.store.state.selection.origin, 'wf-1');
  assert.equal(changes[0].origin, 'wf-1');
  assert.equal(h.view.selectedRow, 4);
  assert.equal(h.view.isSelected(h.view.index.spans.get('b')?.idx ?? -1), true);
  assert.equal(h.view.isSelected(0), false);
});

test('an additive click adds to the selection and keeps the first span as the primary one', () => {
  const h = harness();
  h.view.input({ type: 'click', x: 120, y: 40 + 35 + 10, additive: false }); // label of a
  h.view.input({ type: 'click', x: 120, y: 40 + 4 * 35 + 10, additive: true }); // label of b

  assert.deepEqual([...h.store.state.selection.ids], ['a', 'b']);
  assert.equal(h.store.state.selection.primary, 'b', 'the span just clicked is the one to describe');
});

test('hovering sets and clears the hover in the store', () => {
  const h = harness();

  h.view.input({ type: 'hover', x: PLOT_LEFT + 450 * SCALE, y: 40 + 4 * 35 + 17 });
  assert.deepEqual([...(h.store.state.hover?.ids ?? [])], ['b']);
  assert.equal(h.view.isHovered(h.view.index.spans.get('b')?.idx ?? -1), true);

  h.view.input({ type: 'leave' });
  assert.equal(h.store.state.hover, null);
});

test('the chevron collapses a span: the store changes, the rows follow after the flush', () => {
  const h = harness();
  const chevronY = 40 + 35 + 17;

  h.view.input({ type: 'click', x: 8 + 20 + 4, y: chevronY, additive: false }); // a is at depth 1
  assert.equal(h.store.state.collapsed.has('a'), true);
  assert.deepEqual(ids(h), ['r', 'a', 'a1', 'a2', 'b', 'c'], 'the rows wait for the notification');

  const { dirty } = h.flush();
  assert.deepEqual(ids(h), ['r', 'a', 'b', 'c']);
  assert.ok(dirty & WaterfallDirty.Rows);
});

test('keyboard collapse and expand go through the store too', () => {
  const h = harness();
  h.store.setSelection(['a']);
  h.flush();

  h.view.input({ type: 'key', key: 'ArrowLeft', shift: true, ctrl: false, alt: false });
  h.flush();
  assert.deepEqual(ids(h), ['r', 'a', 'b', 'c']);

  h.view.input({ type: 'key', key: 'ArrowRight', shift: true, ctrl: false, alt: false });
  h.flush();
  assert.deepEqual(ids(h), ['r', 'a', 'a1', 'a2', 'b', 'c']);
});

test('a filter shows matches under dimmed ancestors, and clearing it brings every row back', () => {
  const h = harness();

  h.store.setMatched(SpanMask.of(h.view.index, ['a2']));
  const { dirty } = h.flush();
  assert.deepEqual(ids(h), ['r', 'a', 'a2']);
  assert.deepEqual(Array.from(h.view.projection.context), [1, 1, 0]);
  assert.ok(dirty & WaterfallDirty.Rows);

  h.store.setMatched(null);
  h.flush();
  assert.equal(h.view.projection.count, 6);
});

test('after rows disappear above the first visible row, the scroll position follows it', () => {
  const spans = [span('p', undefined, 0, 50), ...['p1', 'p2', 'p3'].map((id, k) => span(id, 'p', k + 1, k + 2))];
  for (let i = 0; i < 30; i++) spans.push(span(`q${i}`, undefined, 60 + i, 61 + i));
  const h = harness(buildSpanIndex(trace(['svc', spans])), 40 + 35 * 6);
  h.view.input({ type: 'scroll', top: 35 * 8 });
  assert.equal(h.view.state.scrollTop, 280);

  h.store.toggleCollapse('p');
  const { dirty, scrollTo } = h.flush();

  assert.equal(h.view.state.scrollTop, 280 - 3 * 35, 'the same rows stay under the ruler');
  assert.equal(scrollTo, true);
  assert.ok(dirty & WaterfallDirty.Scroll);
});

test('new data resets the view', () => {
  const h = harness();
  h.view.input({ type: 'zoomBy', factor: 0.5 });
  assert.equal(h.view.state.camera.t1 - h.view.state.camera.t0, 500);

  const other = buildSpanIndex(trace(['svc', [span('x', undefined, 0, 10), span('y', 'x', 2, 5)]]));
  h.store.setData(other);
  const { dirty } = h.flush();

  assert.equal(h.view.index, other);
  assert.deepEqual(ids(h), ['x', 'y']);
  assert.deepEqual([h.view.state.camera.t0, h.view.state.camera.t1], [0, 10]);
  assert.ok(dirty & WaterfallDirty.Rows && dirty & WaterfallDirty.Camera);
});

test('a shared time window from another view moves the camera; the view\'s own echo does not', () => {
  const h = harness();

  h.store.setWindow({ t0: 200, t1: 400 }, { origin: 'flame-1' });
  const { dirty } = h.flush();
  assert.deepEqual([h.view.state.camera.t0, h.view.state.camera.t1], [200, 400]);
  assert.ok(dirty & WaterfallDirty.Camera);

  h.view.input({ type: 'reset' });
  h.store.setWindow({ t0: 10, t1: 20 }, { origin: 'wf-1' });
  assert.equal(h.flush().dirty & WaterfallDirty.Camera, 0);
  assert.deepEqual([h.view.state.camera.t0, h.view.state.camera.t1], [0, 1000]);
});

test('selecting from outside expands the ancestors and reveals the span', () => {
  const h = harness();
  h.store.toggleCollapse('a');
  h.flush();
  assert.deepEqual(ids(h), ['r', 'a', 'b', 'c']);

  h.view.select('a2', true);
  h.flush();
  assert.deepEqual(ids(h), ['r', 'a', 'a1', 'a2', 'b', 'c']);
  assert.equal(h.store.state.selection.primary, 'a2');
  assert.deepEqual([h.view.state.camera.t0, h.view.state.camera.t1], [0, 1000], 'already in the window');

  h.view.select('nope', true);
  assert.equal(h.store.state.selection.primary, 'a2', 'an unknown id is ignored');
});

test('buildPlan and hit read the controller\'s own state', () => {
  const h = harness();
  const plan = new FramePlan();
  h.view.input({ type: 'zoomBy', factor: 0.5 }); // shows 250..750

  h.view.buildPlan(plan, monospace);
  assert.equal(plan.count, 6);
  assert.equal(plan.barX0[0], -1, 'the root starts before the window');
  assert.equal(h.view.hit(PLOT_LEFT + 100, 40 + 17).span, 0);
});

test('commands act on the view and report the zoom level', () => {
  const h = harness();
  const commands = new Map(h.view.commands().map((command) => [command.id, command]));

  commands.get('zoom-in')?.run();
  assert.ok(h.view.state.camera.t1 - h.view.state.camera.t0 < 1000);
  assert.notEqual(commands.get('zoom-reset')?.readout?.(), '100%');
  commands.get('zoom-reset')?.run();
  assert.equal(commands.get('zoom-reset')?.readout?.(), '100%');

  commands.get('collapse-all')?.run();
  h.flush();
  assert.deepEqual(ids(h), ['r']);
  commands.get('expand-all')?.run();
  h.flush();
  assert.equal(h.view.projection.count, 6);
});

test('the view state can be saved and restored, for tab switches', () => {
  const h = harness();
  h.view.input({ type: 'zoomBy', factor: 0.25 });
  const saved = h.view.getState();

  h.view.input({ type: 'reset' });
  const restored = h.view.setState(saved);

  assert.deepEqual([h.view.state.camera.t0, h.view.state.camera.t1], [saved.t0, saved.t1]);
  assert.equal(restored.scrollTo, true);
});

test('the accessibility tree lists the rows in view with their levels and states', () => {
  const h = harness();
  h.store.toggleCollapse('a');
  h.store.setSelection(['b']);
  h.flush();

  const tree = h.view.a11y('Trace');
  assert.equal(tree.role, 'tree');
  assert.equal(tree.size, 4);
  assert.equal(tree.activeId, 'b');
  assert.deepEqual(tree.items.map((item) => [item.id, item.level, item.expanded, item.selected, item.position]), [
    ['r', 0, true, false, 1],
    ['a', 1, false, false, 2],
    ['b', 1, undefined, true, 3],
    ['c', 1, undefined, false, 4],
  ]);
  assert.equal(tree.items[0].label, 'svc: r');
});

test('the accessibility tree is windowed for a long trace', () => {
  const spans = Array.from({ length: 5000 }, (_, i) => span(`s${i}`, undefined, i, i + 1));
  const h = harness(buildSpanIndex(trace(['svc', spans])), 40 + 35 * 10);
  h.view.input({ type: 'scroll', top: 35 * 2000 });

  const tree = h.view.a11y('Trace', 3);
  assert.equal(tree.size, 5000);
  assert.equal(tree.items[0].position, 2000 - 3 + 1);
  assert.ok(tree.items.length <= 10 + 7 + 1, `${tree.items.length} items`);
});
