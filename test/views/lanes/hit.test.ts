import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanMask } from '../../../src/core/index.ts';
import { withWindow } from '../../../src/kit/geometry/camera1d.ts';
import { LaneMode } from '../../../src/views/lanes/model/layout.ts';
import {
  HitPart,
  OVERFLOW_BUTTON_WIDTH,
  RUN_TOLERANCE,
  createHitResult,
  hitTest,
  rowsInFlight,
  rowsOfRun,
} from '../../../src/views/lanes/model/hit.ts';
import { LanesFramePlan } from '../../../src/views/lanes/model/plan.ts';
import { span, trace } from '../../support/trace-builder.ts';
import { largeTrace, planOf, scene, wideTrace } from '../../support/lanes-scene.ts';

const SCALE = 756 / 1000;
const PLOT_LEFT = 220;

function hit(plan: LanesFramePlan, x: number, y: number) {
  return { ...hitTest(plan, x, y, createHitResult()) };
}

/** `n` spans of one service on one level: `length` ms long, every `period` ms. */
function sequence(n: number, period: number, length: number) {
  return trace(['svc', Array.from({ length: n }, (_, i) => span(`s${i}`, undefined, i * period, i * period + length))]);
}

// Layout of the default wide scene (view coordinates): ruler 0..40, web 40..76 (two levels), api 76..388
// (16 level rows of 18 px, overflow row 364..388), postgres 388..424 (two levels), bg 424..442.

test('a plan that was never built hits nothing', () => {
  assert.equal(hit(new LanesFramePlan(), 100, 100).part, HitPart.None);
});

test('points outside the view or below the last lane hit nothing', () => {
  const plan = planOf(scene(wideTrace()));
  assert.equal(hit(plan, -1, 100).part, HitPart.None);
  assert.equal(hit(plan, 1000, 100).part, HitPart.None);
  assert.equal(hit(plan, 300, 600).part, HitPart.None);
  assert.equal(hit(plan, 300, 500).part, HitPart.None, 'below the last lane');
  assert.equal(hit(plan, NaN, 100).part, HitPart.None);
});

test('the ruler gives the time under the pointer', () => {
  const plan = planOf(scene(wideTrace()));
  const h = hit(plan, PLOT_LEFT + 378, 20);
  assert.equal(h.part, HitPart.Ruler);
  assert.ok(Math.abs(h.t - 500) < 1e-6);
  assert.equal(hit(plan, 50, 20).part, HitPart.Ruler);
});

test('the gutter is the header of the lane at that height', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const web = hit(plan, 50, 60);
  assert.equal(web.part, HitPart.Header);
  assert.equal(web.lane, 0);
  assert.deepEqual([web.x, web.y, web.w, web.h], [0, 40, 220, 36]);
  assert.equal(hit(plan, 50, 100).lane, 1);
  assert.equal(hit(plan, 50, 400).lane, s.model.names.indexOf('postgres'));
  assert.equal(hit(plan, 50, 430).lane, s.model.names.indexOf('bg'));
  const api = hit(plan, 219.9, 380);
  assert.equal(api.part, HitPart.Header, 'even beside the overflow row');
  assert.equal(api.lane, 1);
});

test('a bar is hit inside its extent and a few pixels beside it', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const row = s.index.table.ids.indexOf('w');

  const h = hit(plan, PLOT_LEFT + 300, 49);
  assert.equal(h.part, HitPart.Bar);
  assert.equal(h.lane, 0);
  assert.equal(h.level, 0);
  assert.equal(h.count, 1);
  assert.equal(h.row, row);
  assert.equal(h.item, s.model.itemOfRow[row]);
  assert.equal(h.ghost, false);
  assert.ok(Math.abs(h.t - 300 / SCALE) < 1e-6);
  assert.deepEqual([h.x, h.y, h.w, h.h], [PLOT_LEFT, 41, 756, 16], 'the box is the bar');

  // w-call ends at 990 ms = 748.4 px
  const end = 990 * SCALE;
  assert.equal(hit(plan, PLOT_LEFT + end + RUN_TOLERANCE - 0.5, 67).part, HitPart.Bar);
  assert.notEqual(hit(plan, PLOT_LEFT + end + RUN_TOLERANCE + 2, 67).part, HitPart.Bar);
});

test('the whole row band hits the bar, not just the bar rectangle', () => {
  const plan = planOf(scene(wideTrace()));
  assert.equal(hit(plan, PLOT_LEFT + 100, 40.1).part, HitPart.Bar);
  assert.equal(hit(plan, PLOT_LEFT + 100, 57.9).part, HitPart.Bar);
});

test('a ghost on a peer lane is a bar of the same span, marked as a ghost', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const x = PLOT_LEFT + 35 * SCALE;
  const h = hit(plan, x, 388 + 9);
  assert.equal(h.part, HitPart.Bar);
  assert.equal(h.lane, s.model.names.indexOf('postgres'));
  assert.equal(h.ghost, true);
  assert.equal(h.row, s.index.table.ids.indexOf('a-db'));
});

test('hit agrees with the plan: every run is found at its own centre, with the same extent', () => {
  for (const scn of [scene(wideTrace()), scene(wideTrace(), { modes: { api: LaneMode.Full } }), scene(largeTrace(5000), { height: 2000 })]) {
    const plan = planOf(scn);
    let checked = 0;
    for (let r = 0; r < plan.runCount; r++) {
      const x = PLOT_LEFT + (plan.runX0[r] + plan.runX1[r]) / 2;
      const h = hit(plan, Math.min(x, 999), plan.runY[r] + 9);
      // runs are disjoint within a row, so the centre of a run is nowhere else
      assert.ok(h.part === HitPart.Bar || h.part === HitPart.Run, `run ${r} is hit (${HitPart[h.part]})`);
      assert.equal(h.run, r);
      assert.equal(h.item, plan.runFirst[r]);
      assert.equal(h.count, plan.runItems[r]);
      assert.equal(h.part, plan.runItems[r] === 1 ? HitPart.Bar : HitPart.Run);
      assert.ok(Math.abs(h.x - (PLOT_LEFT + plan.runX0[r])) < 1e-3);
      assert.ok(Math.abs(h.w - (plan.runX1[r] - plan.runX0[r])) < 1e-3);
      checked++;
    }
    assert.ok(checked > 20);
  }
});

test('a merged run is hit as one run, also in the gaps between its items', () => {
  const s = scene(sequence(100, 10, 9));
  const plan = planOf(s);
  assert.equal(plan.runCount, 1);

  const inside = hit(plan, PLOT_LEFT + 100, 49);
  assert.equal(inside.part, HitPart.Run);
  assert.equal(inside.count, 100);
  assert.equal(inside.row, s.index.table.ids.indexOf('s0'));
  const gap = hit(plan, PLOT_LEFT + 9.5 * (756 / 999) + 0.1, 49); // between s0 and s1
  assert.equal(gap.part, HitPart.Run, 'merged items leave no gaps');
  assert.equal(gap.run, 0);
});

test('zooming in splits the run and the hit follows the plan', () => {
  const s = scene(sequence(100, 10, 5));
  const plan = planOf(s, { camera: withWindow(s.camera, 0, 50) }); // 15.1 px per ms
  const scale = 756 / 50;
  const bar = hit(plan, PLOT_LEFT + 2 * scale, 49);
  assert.equal(bar.part, HitPart.Bar);
  assert.equal(bar.row, s.index.table.ids.indexOf('s0'));
  const next = hit(plan, PLOT_LEFT + 12 * scale, 49);
  assert.equal(next.row, s.index.table.ids.indexOf('s1'));
  assert.equal(next.count, 1);
});

test('empty room between two bars of a busy lane is an idle gap, with the gap bounds', () => {
  const s = scene(sequence(100, 10, 5));
  const plan = planOf(s, { camera: withWindow(s.camera, 0, 50) });
  const scale = 756 / 50;
  const h = hit(plan, PLOT_LEFT + 7.5 * scale, 49);
  assert.equal(h.part, HitPart.IdleGap);
  assert.equal(h.gapFrom, 5);
  assert.equal(h.gapTo, 10);
  assert.ok(Math.abs(h.t - 7.5) < 1e-6);
  assert.ok(Math.abs(h.x - (PLOT_LEFT + 5 * scale)) < 1e-3);
  assert.ok(Math.abs(h.w - 5 * scale) < 1e-3);
  assert.equal(h.lane, 0);
});

test('the room before the first and after the last span of a lane is an idle gap bounded by the trace', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const bgTop = 424 + 9;
  const before = hit(plan, PLOT_LEFT + 800 * SCALE, bgTop);
  assert.equal(before.part, HitPart.IdleGap, 'before the first span of bg');
  assert.equal(before.gapFrom, 0);
  assert.equal(before.gapTo, 900);
  assert.ok(Math.abs(before.x - PLOT_LEFT) < 1e-3, 'the box starts at the plot edge');
  assert.ok(Math.abs(before.w - 900 * SCALE) < 1e-3);

  const gap = hit(plan, PLOT_LEFT + 930 * SCALE, bgTop);
  assert.equal(gap.part, HitPart.IdleGap);
  assert.equal(gap.gapFrom, 910);
  assert.equal(gap.gapTo, 950);

  const after = hit(plan, PLOT_LEFT + 980 * SCALE, bgTop);
  assert.equal(after.part, HitPart.IdleGap, 'after the last span');
  assert.equal(after.gapFrom, 960);
  assert.equal(after.gapTo, 1000, 'to the end of the trace');
  assert.ok(Math.abs(after.x + after.w - (PLOT_LEFT + 756)) < 1e-3, 'the box ends at the plot edge');

  // the room of a lane that is working is not idle
  assert.equal(hit(plan, PLOT_LEFT + 500 * SCALE, 76 + 14 * 18 + 9).part, HitPart.None);
  // web is busy from 0 to the end of the trace: no gap at either end
  assert.equal(hit(plan, PLOT_LEFT + 2, 40 + 27).part, HitPart.None);
  assert.equal(hit(plan, PLOT_LEFT + 754, 40 + 27).part, HitPart.None);
});

test('a collapsed lane is a summary row', () => {
  const s = scene(wideTrace(), { modes: { api: LaneMode.Collapsed } });
  const plan = planOf(s);
  const h = hit(plan, PLOT_LEFT + 378, 76 + 10);
  assert.equal(h.part, HitPart.Summary);
  assert.equal(h.lane, 1);
  assert.ok(Math.abs(h.t - 500) < 1e-6);
  assert.deepEqual([h.x, h.y, h.w, h.h], [PLOT_LEFT, 76, 756, 24]);
  assert.equal(hit(plan, 100, 80).part, HitPart.Header);
  assert.equal(hit(plan, PLOT_LEFT + 5, 76 + 30).lane, s.model.names.indexOf('postgres'), 'the next lane follows after 24 px');
});

test('the overflow row of a capped lane is hit as such, with a button on its left', () => {
  const plan = planOf(scene(wideTrace()));
  const button = hit(plan, PLOT_LEFT + 10, 364 + 10);
  assert.equal(button.part, HitPart.Overflow);
  assert.equal(button.button, true);
  assert.equal(button.lane, 1);
  assert.deepEqual([button.y, button.h], [364, 24]);
  const chart = hit(plan, PLOT_LEFT + OVERFLOW_BUTTON_WIDTH + 10, 364 + 10);
  assert.equal(chart.part, HitPart.Overflow);
  assert.equal(chart.button, false);
  assert.ok(chart.t > 0);
});

test('hits follow the scroll position of the plan', () => {
  const s = scene(wideTrace(), { height: 240 });
  const plan = planOf(s, { scrollTop: 150 });
  // view y 40 is content y 150, which is inside the api lane (content 36 … 348)
  const h = hit(plan, 50, 45);
  assert.equal(h.part, HitPart.Header);
  assert.equal(h.lane, 1);
  // level 7 of api is at content y 36 + 7 × 18 = 162 … 180, view y 52 … 70
  const row = hit(plan, PLOT_LEFT + 300 * SCALE, 60);
  assert.equal(row.part, HitPart.Bar);
  assert.equal(row.lane, 1);
  assert.equal(row.level, 7);
  assert.equal(row.row, s.index.table.ids.indexOf('p6'));
  assert.equal(row.y, 40 + 36 + 7 * 18 - 150 + 1);
});

test('hit tests the last plan, not the current model state', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const before = hit(plan, PLOT_LEFT + 300, 49);
  // the camera of a later frame does not change what the old plan answers
  planOf(s, { camera: withWindow(s.camera, 400, 500) }, new LanesFramePlan());
  const after = hit(plan, PLOT_LEFT + 300, 49);
  assert.deepEqual(after, before);
});

test('rowsOfRun lists the spans of a run in track order, the longest as primary', () => {
  const spans = [span('a', undefined, 0, 5), span('b', undefined, 6, 30), span('c', undefined, 31, 40)];
  const s = scene(trace(['svc', spans], ['long', [span('l', undefined, 0, 4000)]]));
  const plan = planOf(s);
  assert.equal(plan.runCount, 2);
  const ids = s.index.table.ids;
  const run = plan.runItems[0] === 3 ? 0 : 1;
  const { rows, primary } = rowsOfRun(plan, run);
  assert.deepEqual(rows.map((r) => ids[r]), ['a', 'b', 'c']);
  assert.equal(ids[primary], 'b');
  assert.deepEqual(rowsOfRun(new LanesFramePlan(), 0), { rows: [], primary: -1 });
});

test('rowsInFlight lists the lane requests running at a time, honouring the filter and a tolerance', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const ids = s.index.table.ids;
  const api = s.model.names.indexOf('api');

  assert.deepEqual(rowsInFlight(plan, api, 500, null).rows.map((r) => ids[r]), ['a'], 'workers are not local roots');
  assert.equal(ids[rowsInFlight(plan, api, 500, null).primary], 'a');
  assert.deepEqual(rowsInFlight(plan, api, 10, null).rows, []);
  assert.equal(rowsInFlight(plan, api, 10, null).primary, -1);
  assert.deepEqual(rowsInFlight(plan, api, 19, null, 1.5).rows.map((r) => ids[r]), ['a'], 'a pixel before it starts');
  assert.deepEqual(rowsInFlight(plan, api, 500, SpanMask.of(s.index, ['w'])).rows, []);
  const bg = s.model.names.indexOf('bg');
  assert.deepEqual(rowsInFlight(plan, bg, 905, null).rows.map((r) => ids[r]), ['b1']);
  const pg = s.model.names.indexOf('postgres');
  assert.deepEqual(rowsInFlight(plan, pg, 50, null).rows.map((r) => ids[r]), ['a-db', 'a-db2']);
});
