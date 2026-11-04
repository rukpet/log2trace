/**
 * The frame plan: what the painters are told to draw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind } from '../../../src/core.ts';
import { createCamera, withWindow } from '../../../src/kit/geometry/camera1d.ts';
import { Chevron } from '../../../src/views/waterfall/model/rows.ts';
import { FramePlan, LabelMode, RowFlag, buildFramePlan, type PlanInput } from '../../../src/views/waterfall/model/plan.ts';
import { random, span, trace, treeTrace, type TreeNode } from '../../support/trace-builder.ts';
import { monospace, scene, type Scene } from '../../support/waterfall-scene.ts';

//   r [0, 1000]  events at 0, 500, 1000
//   ├ a [100, 400]  an error, a server span, four events
//   ├ b [450, 455]  a thin bar
//   └ c [900, 1000]
const TREE: TreeNode = {
  id: 'r', start: 0, end: 1000, events: [0, 500, 1000], children: [
    { id: 'a', start: 100, end: 400, status: 2, kind: SpanKind.Server, events: [150, 160, 170, 380] },
    { id: 'b', start: 450, end: 455 },
    { id: 'c', start: 900, end: 1000 },
  ],
};

function input(s: Scene, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    index: s.index,
    projection: s.projection,
    collapsed: s.collapsed,
    layout: s.layout,
    camera: s.camera,
    scrollTop: 0,
    measureText: monospace,
    ...overrides,
  };
}

function close(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-3, `${message ?? 'value'}: ${actual} is not ${expected}`);
}

test('the plan describes the rows in view: where, which kind, how wide', () => {
  const s = scene(treeTrace(TREE));
  const plan = new FramePlan();
  buildFramePlan(plan, input(s));

  assert.equal(plan.count, 4);
  assert.equal(plan.firstRow, 0);
  assert.equal(plan.scrollTop, 0);
  assert.deepEqual(Array.from(plan.idx.subarray(0, 4)), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(plan.y.subarray(0, 4)), [40, 75, 110, 145]);
  assert.deepEqual(Array.from(plan.kind.subarray(0, 4)), [1, 2, 1, 1]);

  const scale = 726 / 1000; // the plot is 1000 - 250 (gutter) - 24 (padding) wide
  const x0 = [0, 100 * scale, 450 * scale, 900 * scale];
  const x1 = [726, 400 * scale, 455 * scale, 726];
  for (let j = 0; j < 4; j++) {
    close(plan.barX0[j], x0[j], `barX0[${j}]`);
    close(plan.barX1[j], x1[j], `barX1[${j}]`);
  }
  assert.deepEqual(Array.from(plan.durationText.slice(0, 4)), ['1.00s', '300.00ms', '5.00ms', '100.00ms']);
});

test('flags and chevrons', () => {
  const s = scene(treeTrace(TREE));
  const plan = new FramePlan();
  buildFramePlan(plan, input(s));

  assert.deepEqual(Array.from(plan.flags.subarray(0, 4)), [
    RowFlag.BarVisible,
    RowFlag.BarVisible | RowFlag.Error,
    RowFlag.BarVisible,
    RowFlag.BarVisible,
  ]);
  assert.deepEqual(Array.from(plan.chevron.subarray(0, 4)), [Chevron.Expanded, Chevron.None, Chevron.None, Chevron.None]);

  const collapsed = scene(treeTrace(TREE), { collapsed: ['r'] });
  buildFramePlan(plan, input(collapsed));
  assert.equal(plan.count, 1);
  assert.equal(plan.chevron[0], Chevron.Collapsed);
});

test('context rows of a filter are flagged', () => {
  const s = scene(treeTrace(TREE), { matched: ['c'] });
  const plan = new FramePlan();
  buildFramePlan(plan, input(s));

  assert.equal(plan.count, 2);
  assert.equal(plan.flags[0] & RowFlag.Context, RowFlag.Context, 'the ancestor is context');
  assert.equal(plan.flags[1] & RowFlag.Context, 0, 'the match is not');
});

test('duration text goes inside the bar when it fits, else beside it, else nowhere', () => {
  const s = scene(treeTrace(TREE));
  const plan = new FramePlan();
  buildFramePlan(plan, input(s));

  assert.deepEqual(Array.from(plan.labelMode.subarray(0, 4)), [LabelMode.Inside, LabelMode.Inside, LabelMode.Right, LabelMode.Inside]);
  close(plan.labelX[0], 4);
  close(plan.labelX[1], 100 * 0.726 + 4);
  close(plan.labelX[2], 455 * 0.726 + 4, 'right of the thin bar');

  // a thin bar at the right edge has no room on its right, so the text goes to its left
  const edge = scene(treeTrace([{ id: 'r', start: 0, end: 1000 }, { id: 'late', start: 995, end: 996 }]));
  buildFramePlan(plan, input(edge));
  assert.equal(plan.labelMode[1], LabelMode.Left);
  close(plan.labelX[1], plan.barX0[1] - 4 - 6 * '1.00ms'.length);

  // a text wider than the whole plot fits nowhere
  buildFramePlan(plan, input(s, { measureText: () => 5000 }));
  assert.deepEqual(Array.from(plan.labelMode.subarray(0, 4)), [0, 0, 0, 0]);
});

test('event markers are placed per row and listed by offsets', () => {
  const s = scene(treeTrace(TREE));
  const plan = new FramePlan();
  buildFramePlan(plan, input(s));

  const markers = (j: number): number[] => Array.from(plan.evX.subarray(plan.evOff[j], plan.evOff[j + 1]));
  assert.deepEqual(markers(0).map(Math.round), [0, 363, 726]);
  assert.deepEqual(markers(1).map((x) => Math.round(x * 100) / 100), [108.9, 116.16, 123.42, 275.88]);
  assert.deepEqual(markers(2), [], 'a bar too thin for markers');
  assert.deepEqual(markers(3), []);
  assert.equal(plan.evOff[0], 0);
  assert.equal(plan.evOff[4], 7);
});

test('a bar outside the window is flagged hidden, and one cut by the window is flagged clipped', () => {
  const s = scene(treeTrace(TREE));
  const plan = new FramePlan();

  const left = withWindow(createCamera(1000, s.layout.plotWidth), 0, 100); // shows only the start
  buildFramePlan(plan, input(s, { camera: left }));
  assert.equal(plan.flags[3] & RowFlag.BarVisible, 0, 'c starts at 900 ms');
  assert.equal(plan.labelMode[3], LabelMode.Hidden);
  assert.equal(plan.evOff[4] - plan.evOff[3], 0);
  assert.equal(plan.flags[0] & RowFlag.ClippedRight, RowFlag.ClippedRight);

  const middle = withWindow(createCamera(1000, s.layout.plotWidth), 50, 150);
  buildFramePlan(plan, input(s, { camera: middle }));
  assert.equal(plan.flags[0] & (RowFlag.ClippedLeft | RowFlag.ClippedRight), RowFlag.ClippedLeft | RowFlag.ClippedRight);
  assert.equal(plan.barX0[0], -1);
  assert.equal(plan.barX1[0], s.layout.plotWidth + 1);
});

test('the arrays are rewritten in place frame after frame', () => {
  const s = scene(treeTrace(TREE));
  const plan = new FramePlan();
  buildFramePlan(plan, input(s));
  const arrays = [plan.idx, plan.y, plan.barX0, plan.barX1, plan.flags, plan.labelX, plan.evOff, plan.evX];

  buildFramePlan(plan, input(s, { camera: withWindow(s.camera, 100, 600) }));
  buildFramePlan(plan, input(s, { scrollTop: 10 }));

  assert.deepEqual([plan.idx, plan.y, plan.barX0, plan.barX1, plan.flags, plan.labelX, plan.evOff, plan.evX], arrays);
});

/** A trace of `count` roots, one per millisecond. */
function manyRoots(count: number) {
  return trace(['svc', Array.from({ length: count }, (_, i) => span(`s${i}`, undefined, i, i + 1))]);
}

test('the plan grows when more rows are in view than it has room for', () => {
  const tall = scene(manyRoots(200), { height: 40 + 35 * 90 });
  const plan = new FramePlan(16);
  buildFramePlan(plan, input(tall));

  assert.equal(plan.count, 90);
  assert.ok(plan.capacity >= 90);
  assert.equal(plan.idx.length, plan.capacity);
  assert.deepEqual(Array.from(plan.idx.subarray(0, 3)), [0, 1, 2]);
  assert.equal(plan.idx[89], 89);
});

test('overscan, explicit rows, scroll clamping and an empty list', () => {
  const s = scene(manyRoots(100), { height: 40 + 35 * 10 }); // ten rows in view
  const plan = new FramePlan();

  buildFramePlan(plan, input(s));
  assert.equal(plan.count, 10);
  buildFramePlan(plan, input(s, { overscan: 3 }));
  assert.deepEqual([plan.firstRow, plan.count], [0, 13], 'no rows above the first');
  buildFramePlan(plan, input(s, { scrollTop: 35 * 50, overscan: 3 }));
  assert.deepEqual([plan.firstRow, plan.count], [47, 16]);
  close(plan.y[3], 40 + 50 * 35 - 35 * 50, 'the first visible row is right under the ruler');

  buildFramePlan(plan, input(s, { rows: { first: 5, last: 7 } }));
  assert.deepEqual([plan.firstRow, plan.count], [5, 3]);
  buildFramePlan(plan, input(s, { rows: { first: 98, last: 500 } }));
  assert.deepEqual([plan.firstRow, plan.count], [98, 2], 'clamped to the rows that exist');
  buildFramePlan(plan, input(s, { rows: { first: 200, last: 300 } }));
  assert.equal(plan.count, 0);

  buildFramePlan(plan, input(s, { scrollTop: 1e9 }));
  assert.equal(plan.scrollTop, 100 * 35 - 350, 'scrolled to the end, not beyond');
  assert.equal(plan.firstRow + plan.count, 100);

  const empty = scene(trace(['svc', []]));
  buildFramePlan(plan, input(empty));
  assert.equal(plan.count, 0);
  assert.equal(plan.evOff[0], 0);
});

test('whatever the zoom, the plan holds only finite, bounded numbers', () => {
  const next = random(5);
  for (const width of [320, 1000, 4096, 1e6, 1e8]) {
    const s = scene(treeTrace(TREE), { width, height: 600 });
    const plan = new FramePlan();
    const plot = s.layout.plotWidth;
    for (let trial = 0; trial < 40; trial++) {
      const size = trial === 0 ? 0.001 : Math.max(0.001, 1000 * next() ** 3);
      const t0 = next() * (1000 - Math.min(size, 1000));
      buildFramePlan(plan, input(s, { camera: withWindow(createCamera(1000, plot), t0, t0 + size) }));

      for (let j = 0; j < plan.count; j++) {
        for (const value of [plan.y[j], plan.barX0[j], plan.barX1[j], plan.labelX[j]]) {
          assert.ok(Number.isFinite(value), `width ${width}, window ${t0} + ${size}`);
        }
        assert.ok(plan.barX0[j] >= -1 && plan.barX1[j] <= Math.fround(plot + 1), 'bars stay within a pixel of the plot');
        assert.ok(plan.barX1[j] - plan.barX0[j] >= 0);
      }
      for (let k = 0; k < plan.evOff[plan.count]; k++) assert.ok(Number.isFinite(plan.evX[k]));
    }
  }
});
