/**
 * The flame graph's model: boxes by call path, weights, layout and navigation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, createTraceStore } from '../../../src/core.ts';
import {
  MIN_BAR_WIDTH, boxName, boxesMatched, boxesOfSpans, buildFlameTree, describeBox, flameTree, layoutFlame, neighbour, spansOfBox,
} from '../../../src/views/flame/model.ts';
import { span, trace } from '../../support/trace-builder.ts';

/** root 0–100 with db 10–30, db 40–70 and cache 80–90 under it. */
function sample() {
  return buildSpanIndex(trace(['svc', [
    span('r', undefined, 0, 100, { name: 'root' }),
    span('d1', 'r', 10, 30, { name: 'db' }),
    span('d2', 'r', 40, 70, { name: 'db' }),
    span('c', 'r', 80, 90, { name: 'cache' }),
  ]]));
}

test('spans with the same call path share a box, heaviest child first', () => {
  const tree = buildFlameTree(sample(), null);
  assert.equal(tree.count, 3);
  assert.equal(tree.total, 100);
  const root = tree.boxOfRow[0];
  assert.equal(boxName(tree, root), 'root');
  assert.deepEqual([...tree.children.subarray(tree.childOff[root], tree.childOff[root + 1])].map((b) => boxName(tree, b)), ['db', 'cache']);
  const db = tree.boxOfRow[1];
  assert.equal(tree.boxOfRow[2], db);
  assert.equal(tree.weight[db], 50);
  assert.equal(tree.spans[db], 2);
  assert.equal(tree.self[root], 100 - 60);
});

test('parallel children widen the box instead of overflowing it', () => {
  const index = buildSpanIndex(trace(['svc', [
    span('r', undefined, 0, 50, { name: 'root' }),
    span('a', 'r', 0, 40, { name: 'a' }),
    span('b', 'r', 0, 40, { name: 'b' }),
  ]]));
  const tree = buildFlameTree(index, null);
  assert.equal(tree.weight[0], 80);
  assert.equal(tree.self[0], 0);
  assert.equal(tree.total, 80);
});

test('the time window clips the weights', () => {
  const tree = buildFlameTree(sample(), { t0: 0, t1: 20 });
  assert.equal(tree.total, 20);
  assert.equal(tree.weight[tree.boxOfRow[1]], 10);
  assert.equal(tree.weight[tree.boxOfRow[3]], 0);
});

test('the selector keeps the tree until the data or the window changes', () => {
  const store = createTraceStore();
  store.setData(sample());
  const first = store.derive(flameTree);
  store.setHover([...store.state.data.index.spans.keys()].slice(0, 1));
  assert.equal(store.derive(flameTree), first);
  store.setWindow({ t0: 0, t1: 50 });
  const second = store.derive(flameTree);
  assert.notEqual(second, first);
  assert.equal(second.window?.t1, 50);
});

test('the focus box fills the width and its ancestors stay above it', () => {
  const tree = buildFlameTree(sample(), null);
  const whole = layoutFlame(tree, -1, 200);
  assert.equal(whole.n, 3);
  const db = tree.boxOfRow[1];
  assert.equal(whole.w[whole.slotOfBox[db]], 100);
  assert.equal(whole.x[whole.slotOfBox[tree.boxOfRow[3]]], 100);

  const focused = layoutFlame(tree, db, 200);
  assert.equal(focused.n, 2);
  assert.equal(focused.w[focused.slotOfBox[db]], 200);
  assert.equal(focused.w[focused.slotOfBox[tree.boxOfRow[0]]], 200);
  assert.equal(focused.slotOfBox[tree.boxOfRow[3]], -1);
});

test('boxes narrower than the minimum are left out', () => {
  const tree = buildFlameTree(sample(), null);
  const layout = layoutFlame(tree, -1, 10 * MIN_BAR_WIDTH); // cache is 10% of 15px = 1.5px, db is 50%
  assert.equal(layout.slotOfBox[tree.boxOfRow[3]] >= 0, true);
  assert.equal(layoutFlame(tree, -1, 9 * MIN_BAR_WIDTH).slotOfBox[tree.boxOfRow[3]], -1);
  assert.equal(layoutFlame(tree, -1, 0).n, 0);
});

test('a box names its spans, and the longest one stands for it', () => {
  const tree = buildFlameTree(sample(), null);
  const db = tree.boxOfRow[1];
  assert.deepEqual(spansOfBox(tree, db), { ids: ['d1', 'd2'], primary: 'd2' });
  assert.deepEqual([...boxesOfSpans(tree, new Set(['d1', 'c', 'nope']))].sort(), [db, tree.boxOfRow[3]].sort());
  assert.equal(boxesOfSpans(tree, null).size, 0);
});

test('the filter result marks the boxes that hold a match', () => {
  const store = createTraceStore();
  const index = sample();
  store.setData(index);
  store.setMatched(new Set(['c']));
  const tree = buildFlameTree(index, null);
  const marked = boxesMatched(tree, store.state.matched);
  assert.deepEqual([...(marked ?? [])], [0, 0, 1]);
  assert.equal(boxesMatched(tree, null), null);
});

test('the arrow keys find the parent, the heaviest child and the siblings', () => {
  const tree = buildFlameTree(sample(), null);
  const [root, db, cache] = [tree.boxOfRow[0], tree.boxOfRow[1], tree.boxOfRow[3]];
  assert.equal(neighbour(tree, root, 'child'), db);
  assert.equal(neighbour(tree, db, 'parent'), root);
  assert.equal(neighbour(tree, db, 'next'), cache);
  assert.equal(neighbour(tree, cache, 'previous'), db);
  assert.equal(neighbour(tree, cache, 'next'), -1);
  assert.equal(neighbour(tree, root, 'parent'), -1);
  assert.equal(neighbour(tree, cache, 'child'), -1);
});

test('a box is described for the tooltip', () => {
  const tree = buildFlameTree(sample(), null);
  const info = describeBox(tree, tree.boxOfRow[1]);
  assert.equal(info.title, 'db');
  assert.equal(info.subtitle, 'svc');
  assert.deepEqual(info.sections[0].rows?.map(([label]) => label), ['Total', 'Self', 'Spans', 'Share of trace']);
  assert.equal(info.sections[0].rows?.[3][1], '50.0%');
});

test('an empty trace has no boxes and nothing to draw', () => {
  const tree = buildFlameTree(createTraceStore().state.data.index, null);
  assert.equal(tree.count, 0);
  assert.equal(layoutFlame(tree, -1, 300).n, 0);
});
