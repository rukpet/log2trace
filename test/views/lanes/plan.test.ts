import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanMask } from '../../../src/core/index.ts';
import { withWindow } from '../../../src/kit/geometry/camera1d.ts';
import { LaneMode } from '../../../src/views/lanes/model/layout.ts';
import {
  ERROR_TICK_PX,
  LABEL_MIN_WIDTH,
  LanesFramePlan,
  MAX_BARS,
  MERGE_GAP_PX,
  RunFlag,
  SummaryKind,
  SummarySource,
  areaPath,
  errorPath,
  laneBusyPercent,
  laneStatsText,
  markRows,
  selectionMasks,
} from '../../../src/views/lanes/model/plan.ts';
import { levelAt, buildSteps } from '../../../src/views/lanes/model/summary.ts';
import { span, trace } from '../../support/trace-builder.ts';
import { fitText, largeTrace, planOf, scene, selectionOf, wideTrace, type LanesScene } from '../../support/lanes-scene.ts';

const SCALE = 756 / 1000; // pixels per ms of the default scene: the plot is 756 px for the 1000 ms trace

function close(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-3, `${message ?? 'value'}: ${actual} is not ${expected}`);
}

/** The run that holds the span with `id` (not its ghost). */
function runOf(s: LanesScene, plan: LanesFramePlan, id: string): number {
  const row = s.index.table.ids.indexOf(id);
  for (let r = 0; r < plan.runCount; r++) {
    for (let i = plan.runFirst[r]; i < plan.runFirst[r] + plan.runItems[r]; i++) {
      if (s.model.itemRow[i] === row && s.model.itemGhost[i] === 0) return r;
    }
  }
  return -1;
}

function ghostRunOf(s: LanesScene, plan: LanesFramePlan, id: string): number {
  const row = s.index.table.ids.indexOf(id);
  for (let r = 0; r < plan.runCount; r++) {
    for (let i = plan.runFirst[r]; i < plan.runFirst[r] + plan.runItems[r]; i++) {
      if (s.model.itemRow[i] === row && s.model.itemGhost[i] === 1) return r;
    }
  }
  return -1;
}

/** `n` back-to-back spans of one service on one level: `length` ms long, every `period` ms. */
function sequence(n: number, period: number, length: number) {
  return trace(['svc', Array.from({ length: n }, (_, i) => span(`s${i}`, undefined, i * period, i * period + length))]);
}

test('the plan describes the lanes in view: headers, rows, runs and ticks', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);

  assert.equal(plan.headerCount, 4);
  assert.deepEqual(plan.headerName.slice(0, 4), ['web', 'api', 'postgres', 'bg']);
  assert.deepEqual(Array.from(plan.headerY.subarray(0, 4)), [40, 76, 388, 424]);
  assert.deepEqual(Array.from(plan.headerHeight.subarray(0, 4)), [36, 312, 36, 18]);
  assert.deepEqual(Array.from(plan.headerMode.subarray(0, 4)), [1, 1, 1, 1]);
  assert.equal(plan.headerStats[1], '23 spans · 96% busy · peak 1 · 1 error');
  assert.equal(plan.contentHeight, 402);
  assert.equal(plan.plotWidth, 756);

  // 2 + 16 + 2 + 1 level rows, from the top
  assert.equal(plan.rowCount, 21);
  assert.equal(plan.rowY[0], 40);
  assert.equal(plan.rowY[1], 58);
  assert.equal(plan.rowY[2], 76, 'the first api row follows the web lane');
  assert.deepEqual(Array.from(plan.rowLane.subarray(0, 3)), [0, 0, 1]);
  assert.deepEqual(Array.from(plan.rowLevel.subarray(0, 4)), [0, 1, 0, 1]);

  assert.ok(plan.tickCount >= 3);
  for (let k = 0; k < plan.tickCount; k++) {
    assert.ok(plan.tickX[k] >= 0 && plan.tickX[k] <= 756);
    assert.ok(plan.tickLabel[k].length > 0);
  }
});

test('a single-item run keeps the identity of its span, with its geometry and kind', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const r = runOf(s, plan, 'w');

  assert.ok(r >= 0);
  assert.equal(plan.runItems[r], 1);
  assert.equal(s.model.itemRow[plan.runFirst[r]], s.index.table.ids.indexOf('w'));
  close(plan.runX0[r], 0);
  close(plan.runX1[r], 756);
  assert.equal(plan.runY[r], 40);
  assert.equal(plan.runKind[r], SpanKind.Server);
  assert.equal(plan.runFlags[r] & RunFlag.Merged, 0);

  const call = runOf(s, plan, 'w-call');
  close(plan.runX0[call], 10 * SCALE);
  close(plan.runX1[call], 990 * SCALE);
  assert.equal(plan.runKind[call], SpanKind.Client);
  assert.equal(plan.runY[call], 58);
  assert.equal(plan.runTrack[call], s.model.laneTrackOff[0] + 1);
});

test('items closer than the merge gap become one merged run; zooming in splits them again', () => {
  // 100 spans of 9 ms every 10 ms: 1 ms apart, which is under 2 px at 0.76 px/ms
  const s = scene(sequence(100, 10, 9));
  const coarse = planOf(s);
  assert.equal(coarse.runCount, 1);
  assert.equal(coarse.runItems[0], 100);
  assert.ok(coarse.runFlags[0] & RunFlag.Merged);
  close(coarse.runX0[0], 0);
  close(coarse.runX1[0], (99 * 10 + 9) * (756 / 999), 'the run spans from the first start to the last end');
  assert.equal(coarse.labelCount, 0, 'a merged run has no label');

  const zoomed = planOf(s, { camera: withWindow(s.camera, 0, 100) });
  assert.equal(zoomed.runCount, 11, 'items 0..9 end in the window, item 10 starts at its end');
  for (let r = 0; r < zoomed.runCount; r++) assert.equal(zoomed.runItems[r], 1);
  assert.equal(zoomed.runFlags[0] & RunFlag.Merged, 0);
});

test('items farther apart than the gap stay separate', () => {
  const s = scene(sequence(100, 10, 5)); // 5 ms gaps = 3.8 px
  const plan = planOf(s);
  assert.equal(plan.runCount, 100);
});

test('the dominant kind of a merged run is the one with the most pixels, not the most items', () => {
  // 0.756 px/ms: the server span is 9 px wide, the three internal spans 2.3 px each, the consumer 2.3 px
  const spans = [span('big', undefined, 0, 12, { kind: SpanKind.Server })];
  for (let i = 0; i < 3; i++) spans.push(span(`i${i}`, undefined, 13 + i * 4, 16 + i * 4, { kind: SpanKind.Internal }));
  spans.push(span('last', undefined, 25, 28, { kind: SpanKind.Consumer }));
  const plan = planOf(scene(trace(['svc', spans], ['far', [span('far', undefined, 0, 1000)]])));

  const run = Array.from({ length: plan.runCount }, (_, r) => r).find((r) => plan.runItems[r] > 1);
  assert.ok(run !== undefined);
  assert.equal(plan.runItems[run], 5);
  assert.equal(plan.runKind[run], SpanKind.Server, 'server 9 px beats internal 7 px and consumer 2 px');
});

test('wide bars are never merged while the frame fits, narrow ones next to them are', () => {
  // 100 spans of 10 ms back to back: 7.6 px each, narrow, merged
  const narrow = planOf(scene(sequence(100, 10, 10)));
  assert.equal(narrow.runCount, 1);
  // 10 spans of 100 ms back to back: 76 px each, bars of their own, with labels
  const wide = planOf(scene(sequence(10, 100, 100)));
  assert.equal(wide.runCount, 10);
  for (let r = 0; r < wide.runCount; r++) assert.equal(wide.runItems[r], 1);
  assert.equal(wide.mergeGap, MERGE_GAP_PX);
  assert.ok(wide.labelCount > 0);
});

test('the budget holds on a 50,000 span trace zoomed fully out, even with every lane open', () => {
  const modes: Record<string, LaneMode> = {};
  for (const name of ['api-gateway', 'order-svc', 'payment-svc', 'inventory-svc', 'worker-pool', 'cache-svc', 'postgresql', 'redis']) modes[name] = LaneMode.Full;
  const s = scene(largeTrace(50_000), { height: 20_000, modes });
  const plan = planOf(s);

  assert.ok(plan.rowCount > 300, `many rows are in view (${plan.rowCount})`);
  assert.ok(plan.runCount > 0);
  assert.ok(plan.runCount <= MAX_BARS, `run count ${plan.runCount} is within the budget`);
  assert.ok(plan.mergeGap > MERGE_GAP_PX, 'the gap doubled to fit');
  assert.equal(Math.log2(plan.mergeGap / MERGE_GAP_PX) % 1, 0, 'only by doubling');

  // everything the walk saw is accounted for in the runs
  let items = 0;
  for (let r = 0; r < plan.runCount; r++) items += plan.runItems[r];
  assert.ok(items > plan.runCount);
});

test('a frame that fits keeps the starting merge gap', () => {
  const s = scene(wideTrace());
  assert.equal(planOf(s).mergeGap, MERGE_GAP_PX);
  assert.equal(planOf(s, { mergeGap: 6 }).mergeGap, 6);
});

test('a capped lane with more levels than maxRows has an overflow row for the rest', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  const api = s.model.names.indexOf('api');

  assert.equal(plan.summaryCount, 1);
  assert.equal(plan.summaryKind[0], SummaryKind.Overflow);
  assert.equal(plan.summaryLane[0], api);
  assert.equal(plan.summaryHidden[0], 5);
  assert.equal(plan.summaryY[0], 40 + 36 + 16 * 18);
  assert.equal(plan.summaryH[0], 24);
  assert.ok(plan.summaryPath[0].startsWith('M0 '), 'the hidden levels have workers in flight');

  // level rows stop at maxRows: rows of the api lane are levels 0..15 only
  const levels: number[] = [];
  for (let j = 0; j < plan.rowCount; j++) if (plan.rowLane[j] === api) levels.push(plan.rowLevel[j]);
  assert.deepEqual(levels, Array.from({ length: 16 }, (_, v) => v));

  const full = planOf(scene(wideTrace(), { modes: { api: LaneMode.Full } }));
  assert.equal(full.summaryCount, 0, 'a full lane has no overflow row');
  assert.equal(full.rowCount, 26);
});

test('a collapsed lane is one summary row with an area path and error ticks, and no bars', () => {
  const s = scene(wideTrace(), { modes: { bg: LaneMode.Collapsed } });
  const plan = planOf(s);
  const bg = s.model.names.indexOf('bg');

  const slot = Array.from({ length: plan.summaryCount }, (_, k) => k).find((k) => plan.summaryLane[k] === bg) ?? -1;
  assert.ok(slot >= 0);
  assert.equal(plan.summaryKind[slot], SummaryKind.Collapsed);
  assert.equal(plan.summaryH[slot], 24);
  assert.equal(plan.summaryY[slot], 40 + 36 + 312 + 36);
  assert.match(plan.summaryPath[slot], /^M0 23V\d+.*Z$/);
  assert.equal(plan.summaryErrors[slot], `M${Math.round(950 * SCALE)} 0V${ERROR_TICK_PX}`);
  assert.equal(plan.headerMode[3], LaneMode.Collapsed);
  assert.equal(plan.headerHeight[3], 24);
  for (let j = 0; j < plan.rowCount; j++) assert.notEqual(plan.rowLane[j], bg, 'no level rows for a collapsed lane');
});

test('peer lanes are not planned when peers are off, and ghosts are flagged when on', () => {
  const on = scene(wideTrace());
  const planOn = planOf(on);
  assert.ok(planOn.headerName.slice(0, planOn.headerCount).includes('postgres'));
  const ghost = ghostRunOf(on, planOn, 'a-db');
  assert.ok(ghost >= 0);
  assert.ok(planOn.runFlags[ghost] & RunFlag.Ghost);
  assert.equal(planOn.runFlags[runOf(on, planOn, 'a-db')] & RunFlag.Ghost, 0);

  const off = scene(wideTrace(), { peers: false });
  const planOff = planOf(off);
  assert.deepEqual(planOff.headerName.slice(0, planOff.headerCount), ['web', 'api', 'bg']);
  assert.equal(ghostRunOf(off, planOff, 'a-db'), -1);
  for (let r = 0; r < planOff.runCount; r++) assert.equal(planOff.runFlags[r] & RunFlag.Ghost, 0);
  assert.equal(planOff.contentHeight, 36 + 312 + 18);
});

test('error spans are flagged', () => {
  const s = scene(wideTrace());
  const plan = planOf(s);
  assert.ok(plan.runFlags[runOf(s, plan, 'a-db2')] & RunFlag.Error);
  assert.equal(plan.runFlags[runOf(s, plan, 'a-db')] & RunFlag.Error, 0);
  assert.ok(plan.runFlags[runOf(s, plan, 'b2')] & RunFlag.Error);
});

test('a filter dims the spans that do not match and repacks nothing', () => {
  const plain = scene(wideTrace());
  const before = planOf(plain);
  const filtered = scene(wideTrace(), { matched: ['a-db', 'p3'] });
  const after = planOf(filtered);

  assert.equal(after.runCount, before.runCount);
  assert.equal(after.rowCount, before.rowCount);
  assert.deepEqual(Array.from(after.runX0.subarray(0, after.runCount)), Array.from(before.runX0.subarray(0, before.runCount)));
  assert.deepEqual(Array.from(after.runY.subarray(0, after.runCount)), Array.from(before.runY.subarray(0, before.runCount)));
  assert.deepEqual(Array.from(after.runFirst.subarray(0, after.runCount)), Array.from(before.runFirst.subarray(0, before.runCount)));

  for (let r = 0; r < before.runCount; r++) assert.equal(before.runFlags[r] & RunFlag.Dimmed, 0, 'nothing is dimmed without a filter');
  assert.equal(after.runFlags[runOf(filtered, after, 'a-db')] & RunFlag.Dimmed, 0);
  assert.equal(after.runFlags[runOf(filtered, after, 'p3')] & RunFlag.Dimmed, 0);
  assert.ok(after.runFlags[runOf(filtered, after, 'p4')] & RunFlag.Dimmed);
  assert.ok(after.runFlags[runOf(filtered, after, 'w')] & RunFlag.Dimmed);
});

test('a merged run is dimmed only when none of its spans match', () => {
  const s = scene(sequence(100, 10, 9), { matched: ['s40'] });
  const plan = planOf(s);
  assert.equal(plan.runCount, 1);
  assert.equal(plan.runFlags[0] & RunFlag.Dimmed, 0);
  const none = scene(sequence(100, 10, 9), { matched: [] });
  assert.ok(planOf(none).runFlags[0] & RunFlag.Dimmed, 'a filter that matches nothing dims everything');
});

test('collapsed summaries count only matched spans', () => {
  const modes = { api: LaneMode.Collapsed, web: LaneMode.Collapsed };
  const all = scene(wideTrace(), { modes });
  const some = scene(wideTrace(), { modes, matched: ['w'] });
  const api = all.model.names.indexOf('api');
  const slotOf = (plan: LanesFramePlan, lane: number): number => Array.from({ length: plan.summaryCount }, (_, k) => k).find((k) => plan.summaryLane[k] === lane) ?? -1;

  const planAll = planOf(all);
  const planSome = planOf(some);
  assert.notEqual(planAll.summaryPath[slotOf(planAll, api)], '');
  assert.equal(planSome.summaryPath[slotOf(planSome, api)], '', 'no matched local root in api');
  assert.notEqual(planSome.summaryPath[slotOf(planSome, 0)], '');
});

test('related flags: the ancestors and the subtree of the selection, and everything else faded', () => {
  const s = scene(wideTrace(), { modes: { api: LaneMode.Full } });
  const selection = selectionOf(s, ['a']);
  const plan = planOf(s, { selection });
  const flag = (id: string): number => plan.runFlags[runOf(s, plan, id)];

  for (const id of ['w', 'w-call', 'a', 'p0', 'p19', 'a-db']) assert.ok(flag(id) & RunFlag.Related, `${id} is related`);
  for (const id of ['w', 'a', 'p0']) assert.equal(flag(id) & RunFlag.Faded, 0);
  assert.ok(flag('a') & RunFlag.Selected);
  assert.equal(flag('p0') & RunFlag.Selected, 0);
  assert.ok(flag('b1') & RunFlag.Faded, 'an unrelated span fades');
  assert.equal(flag('b1') & RunFlag.Related, 0);

  const leaf = planOf(s, { selection: selectionOf(s, ['p3']) });
  const leafFlag = (id: string): number => leaf.runFlags[runOf(s, leaf, id)];
  for (const id of ['w', 'w-call', 'a', 'p3']) assert.ok(leafFlag(id) & RunFlag.Related, `${id} is an ancestor of p3 or p3`);
  for (const id of ['p4', 'a-db', 'b1']) assert.ok(leafFlag(id) & RunFlag.Faded, `${id} is not on the path`);

  const none = planOf(s);
  for (let r = 0; r < none.runCount; r++) assert.equal(none.runFlags[r] & (RunFlag.Related | RunFlag.Faded | RunFlag.Selected), 0);
});

test('hovered spans are flagged through the hover mask', () => {
  const s = scene(wideTrace());
  const hovered = markRows(s.index, [s.index.table.ids.indexOf('a-db2')]);
  const plan = planOf(s, { hovered });
  assert.ok(plan.runFlags[runOf(s, plan, 'a-db2')] & RunFlag.Hovered);
  assert.equal(plan.runFlags[runOf(s, plan, 'a-db')] & RunFlag.Hovered, 0);
});

test('selectionMasks marks the selection, its ancestors and its subtree', () => {
  const s = scene(wideTrace());
  const masks = selectionOf(s, ['a', 'a']);
  const t = s.index.table;
  const row = (id: string): number => t.ids.indexOf(id);
  assert.equal(masks.count, 1, 'duplicates count once');
  assert.equal(masks.selected[row('a')], 1);
  assert.equal(masks.selected[row('w')], 0);
  for (const id of ['w', 'w-call', 'a', 'p7', 'a-db']) assert.equal(masks.related[row(id)], 1, id);
  for (const id of ['b1', 'b2']) assert.equal(masks.related[row(id)], 0, id);
  assert.equal(masks.start, 20);
  assert.equal(masks.end, 980);

  const empty = selectionMasks(s.index, []);
  assert.equal(empty.count, 0);
  assert.ok(empty.related.every((v) => v === 0));
});

test('labels: single bars wide enough get text cut to fit; narrow bars and merged runs get none', () => {
  const spans = [
    span('long-operation-name', undefined, 0, 500),
    span('tiny', undefined, 600, 610),
  ];
  const s = scene(trace(['svc', spans]));
  const plan = planOf(s);
  const scale = 756 / 610;

  assert.equal(plan.labelCount, 1, 'the 10 ms bar is far too narrow');
  const r = plan.labelRun[0];
  assert.equal(plan.runFirst[r], s.model.itemOfRow[s.index.table.ids.indexOf('long-operation-name')]);
  assert.equal(plan.labelText[0], 'long-operation-name', '19 characters = 114 px fit');
  assert.equal(plan.labelX[0], 4);
  close(plan.labelWidth[0], 500 * scale - 8);

  const short = scene(trace(['svc', [span('long-operation-name', undefined, 0, 60), span('tiny', undefined, 600, 610)]]));
  const cut = planOf(short);
  assert.equal(cut.labelCount, 1);
  assert.equal(cut.labelText[0], fitText('long-operation-name', 60 * scale - 8));
  assert.ok(cut.labelText[0].endsWith('…'));
  assert.ok(cut.runX1[0] - cut.runX0[0] >= LABEL_MIN_WIDTH);

  const clipped = planOf(s, { camera: withWindow(s.camera, 400, 700) });
  assert.equal(clipped.labelX[0], 4, 'a bar clipped on the left is labelled from the plot edge');
  assert.equal(planOf(scene(sequence(100, 10, 9))).labelCount, 0, 'a merged run has no label');
});

test('only the lanes and rows in the viewport are planned, plus the overscan', () => {
  const s = scene(wideTrace(), { height: 240 }); // 200 px of body
  const top = planOf(s);
  assert.deepEqual(Array.from(top.headerLane.subarray(0, top.headerCount)), [0, 1], 'web and api start within 200 px');
  assert.ok(top.rowCount <= 2 + 10, 'web rows and the first api rows only');
  for (let j = 0; j < top.rowCount; j++) assert.ok(top.rowY[j] < 40 + 200);

  const scrolled = planOf(s, { scrollTop: 150 });
  assert.equal(scrolled.scrollTop, 150);
  assert.equal(scrolled.headerLane[0], 1, 'web is scrolled out');
  assert.ok(scrolled.headerY[0] < 40, 'the api header starts above the body');
  assert.equal(scrolled.rowCount > 0 && scrolled.rowY[0] > 40 - 18, true);
  for (let j = 0; j < scrolled.rowCount; j++) {
    assert.ok(scrolled.rowY[j] + 18 > 40 && scrolled.rowY[j] < 40 + 200, `row ${j} intersects the body`);
  }

  const padded = planOf(s, { scrollTop: 150, overscan: 3 });
  assert.ok(padded.rowCount > scrolled.rowCount);

  const clamped = planOf(s, { scrollTop: 99_999 });
  assert.equal(clamped.scrollTop, 402 - 200);
});

test('bars wider than the plot are clipped just outside it and flagged', () => {
  const s = scene(wideTrace());
  const plan = planOf(s, { camera: withWindow(s.camera, 100, 200) });
  const r = runOf(s, plan, 'w');
  assert.equal(plan.runX0[r], -1);
  assert.equal(plan.runX1[r], 757);
  assert.ok(plan.runFlags[r] & RunFlag.ClippedLeft);
  assert.ok(plan.runFlags[r] & RunFlag.ClippedRight);
  assert.equal(runOf(s, plan, 'b1'), -1, 'spans outside the window are not planned');
});

test('a plot with no width still plans the lanes and the ruler, but no runs', () => {
  const plan = planOf(scene(wideTrace(), { width: 0 }));
  assert.equal(plan.runCount, 0);
  assert.equal(plan.labelCount, 0);
  assert.equal(plan.headerCount, 4);
  assert.equal(plan.rowCount, 21);
  assert.equal(plan.rowRunOff[plan.rowCount], 0);
});

test('the plan arrays are reused between frames', () => {
  const s = scene(wideTrace());
  const plan = new LanesFramePlan();
  planOf(s, {}, plan);
  const x0 = plan.runX0;
  const rowY = plan.rowY;
  planOf(s, { camera: withWindow(s.camera, 100, 600) }, plan);
  assert.equal(plan.runX0, x0);
  assert.equal(plan.rowY, rowY);
  assert.equal(plan.model, s.model);
  assert.equal(plan.stack, s.stack);
});

test('SummarySource builds matched steps once per mask and the overflow steps of the hidden levels', () => {
  const s = scene(wideTrace(), { matched: ['a'] });
  const source = new SummarySource(s.model);
  const api = s.model.names.indexOf('api');

  assert.equal(source.steps(api, null), s.model.steps[api]);
  const one = source.steps(api, s.matched);
  assert.equal(source.steps(api, s.matched), one, 'cached');
  assert.equal(one.peak, 1);
  const other = SpanMask.of(s.index, ['a']);
  assert.notEqual(source.steps(api, other), one, 'a new mask is a new filter result');

  const hidden = source.overflow(api, 16, null);
  assert.equal(hidden.peak, 5, 'five levels are hidden and all five are in flight together');
  assert.equal(levelAt(hidden, 300), 5);
  assert.equal(levelAt(hidden, 50), 0);
  assert.equal(source.overflow(api, 16, null), hidden);
  assert.equal(source.overflow(api, 20, null).peak, 1, 'maxRows changes what is hidden');
  assert.equal(source.overflow(s.model.names.indexOf('web'), 16, null).peak, 0, 'nothing hidden');
});

test('areaPath draws a step outline of the maximum per column, closed along the bottom', () => {
  const steps = buildSteps(Float64Array.from([0, 50]), Float64Array.from([100, 75]));
  const camera = { t0: 0, t1: 100, total: 100, widthPx: 10 };
  const path = areaPath(steps, camera, 24, 2, new Int32Array(10));
  // columns 0-4: one in flight; 5-7: two; 8-9: one. The row is 24 px: base 23, 21 px of room for the peak of 2.
  assert.equal(path, 'M0 23V12H5V2H8V12H10V23Z');

  assert.equal(areaPath(steps, { ...camera, t0: 200, t1: 300 }, 24, 2, new Int32Array(10)), '', 'nothing in flight');
  assert.equal(areaPath(steps, camera, 24, 0, new Int32Array(10)), '');
});

test('errorPath puts one tick per pixel column and honours the mask and the level floor', () => {
  const s = scene(wideTrace());
  const api = s.model.names.indexOf('api');
  const camera = s.camera;
  assert.equal(errorPath(s.model, api, camera, null, 0), `M${Math.round(40 * SCALE)} 0V${ERROR_TICK_PX}`);
  const mask = SpanMask.of(s.index, ['w']).bits;
  assert.equal(errorPath(s.model, api, camera, mask, 0), '', 'the failed span is not matched');
  assert.equal(errorPath(s.model, api, camera, null, 16), '', 'it is not on a hidden level');
  assert.equal(errorPath(s.model, api, withWindow(camera, 500, 900), null, 0), '', 'it is outside the window');
});

test('lane stats read from the model', () => {
  const s = scene(wideTrace());
  const api = s.model.names.indexOf('api');
  const bg = s.model.names.indexOf('bg');
  assert.equal(laneStatsText(s.model, bg), '2 spans · 2% busy · peak 1 · 1 error');
  assert.equal(laneBusyPercent(s.model, api), 96);
  assert.ok(laneBusyPercent(s.model, bg) >= 1);
  assert.equal(laneBusyPercent(scene({ resourceSpans: [] }).model, 0), 0);
});
