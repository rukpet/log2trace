import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_METRICS,
  LANE_MODE_NAMES,
  LaneMode,
  LaneRowKind,
  computeLayout,
  createLaneRow,
  laneAt,
  laneHeight,
  laneOfTrack,
  lanesIn,
  levelTop,
  overflowTop,
  parseLaneMode,
  resolveMetrics,
  rowInLane,
  scrollToRange,
  stackLanes,
  trackOfItem,
  viewY,
  contentY,
  maxScroll,
  clampScroll,
} from '../../../src/views/lanes/model/layout.ts';
import { scene, wideTrace } from '../../support/lanes-scene.ts';

test('resolveMetrics fills in the defaults and drops unusable values', () => {
  assert.deepEqual(resolveMetrics(), DEFAULT_METRICS);
  assert.equal(DEFAULT_METRICS.rowHeight, 18);
  assert.equal(DEFAULT_METRICS.barHeight, 16);
  assert.equal(DEFAULT_METRICS.summaryHeight, 24);
  assert.equal(DEFAULT_METRICS.headerHeight, 40);
  assert.equal(DEFAULT_METRICS.gutterWidth, 220);

  const m = resolveMetrics({ rowHeight: -3, barHeight: NaN, maxRows: 0.5, gutterWidth: Infinity, headerHeight: 12 });
  assert.equal(m.rowHeight, 18);
  assert.equal(m.barHeight, 16);
  assert.equal(m.maxRows, 16);
  assert.equal(m.gutterWidth, 220);
  assert.equal(m.headerHeight, 12);
  assert.equal(resolveMetrics({ rowHeight: 10 }).barHeight, 10, 'a bar never exceeds its row');
  assert.equal(resolveMetrics({ maxRows: 4.9 }).maxRows, 4);
});

test('computeLayout splits the view into gutter, plot and padding', () => {
  const layout = computeLayout(DEFAULT_METRICS, 1000, 600);
  assert.equal(layout.gutterWidth, 220);
  assert.equal(layout.plotLeft, 220);
  assert.equal(layout.plotWidth, 1000 - 220 - 24);
  assert.equal(layout.bodyHeight, 560);
  assert.equal(layout.barInset, 1);

  const narrow = computeLayout(DEFAULT_METRICS, 300, 100);
  assert.equal(narrow.gutterWidth, 150, 'the gutter takes at most half of the view');
  assert.equal(narrow.plotWidth, 300 - 150 - 24);

  const none = computeLayout(DEFAULT_METRICS, NaN, -1);
  assert.equal(none.width, 0);
  assert.equal(none.plotWidth, 0);
  assert.equal(none.bodyHeight, 0);
});

test('mode names round trip', () => {
  assert.deepEqual(LANE_MODE_NAMES, ['collapsed', 'capped', 'full']);
  assert.equal(parseLaneMode('full'), LaneMode.Full);
  assert.equal(parseLaneMode('capped'), LaneMode.Capped);
  assert.equal(parseLaneMode('bogus'), undefined);
  assert.equal(parseLaneMode(2), undefined);
});

test('lanes stack in display order with heights from their modes', () => {
  const s = scene(wideTrace());
  const names = Array.from(s.stack.lane, (l) => s.model.names[l]);
  assert.deepEqual(names, ['web', 'api', 'postgres', 'bg']);

  // web 2 levels, api capped at 16 of 21 levels plus an overflow row, postgres 2 levels, bg 1 level
  assert.deepEqual(Array.from(s.stack.levels), [2, 16, 2, 1]);
  assert.deepEqual(Array.from(s.stack.hidden), [0, 5, 0, 0]);
  assert.deepEqual(Array.from(s.stack.top), [0, 36, 36 + 16 * 18 + 24, 36 + 312 + 36, 36 + 312 + 36 + 18]);
  assert.equal(s.stack.contentHeight, 402);
  assert.equal(laneHeight(s.stack, 1), 312);
  assert.equal(overflowTop(s.stack, s.layout, 1), 36 + 16 * 18);
  assert.equal(levelTop(s.stack, s.layout, 1, 3), 36 + 3 * 18);
});

test('full shows every level without an overflow row, collapsed one summary row', () => {
  const full = scene(wideTrace(), { modes: { api: LaneMode.Full } });
  assert.deepEqual(Array.from(full.stack.levels), [2, 21, 2, 1]);
  assert.deepEqual(Array.from(full.stack.hidden), [0, 0, 0, 0]);
  assert.equal(full.stack.contentHeight, 36 + 21 * 18 + 36 + 18);

  const collapsed = scene(wideTrace(), { modes: { api: LaneMode.Collapsed } });
  assert.deepEqual(Array.from(collapsed.stack.levels), [2, 0, 2, 1]);
  assert.equal(laneHeight(collapsed.stack, 1), 24);
  assert.equal(collapsed.stack.mode[1], LaneMode.Collapsed);
});

test('a capped lane with no more levels than maxRows has no overflow row', () => {
  const s = scene(wideTrace(), { metrics: { maxRows: 21 } });
  assert.deepEqual(Array.from(s.stack.hidden), [0, 0, 0, 0]);
  assert.equal(laneHeight(s.stack, 1), 21 * 18);
  const tight = scene(wideTrace(), { metrics: { maxRows: 1 } });
  assert.deepEqual(Array.from(tight.stack.levels), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(tight.stack.hidden), [1, 20, 1, 0]);
});

test('peer lanes are left out when peers are off, and the rest keeps its order', () => {
  const s = scene(wideTrace(), { peers: false });
  assert.deepEqual(Array.from(s.stack.lane, (l) => s.model.names[l]), ['web', 'api', 'bg']);
  const peer = s.model.names.indexOf('postgres');
  assert.equal(s.stack.positionOfLane[peer], -1);
  assert.equal(s.stack.positionOfLane[s.model.names.indexOf('bg')], 2);
  assert.equal(s.stack.contentHeight, 36 + 312 + 18);
});

test('lane order follows the order argument', () => {
  const byName = scene(wideTrace(), { order: 'name' });
  assert.deepEqual(Array.from(byName.stack.lane, (l) => byName.model.names[l]), ['api', 'bg', 'postgres', 'web']);
  const byBusy = scene(wideTrace(), { order: 'busy' });
  assert.equal(byBusy.model.names[byBusy.stack.lane[0]], 'web');
});

test('laneAt finds the lane by binary search and rejects points outside the content', () => {
  const s = scene(wideTrace());
  assert.equal(laneAt(s.stack, -1), -1);
  assert.equal(laneAt(s.stack, 0), 0);
  assert.equal(laneAt(s.stack, 35.9), 0);
  assert.equal(laneAt(s.stack, 36), 1);
  assert.equal(laneAt(s.stack, 347.9), 1);
  assert.equal(laneAt(s.stack, 348), 2);
  assert.equal(laneAt(s.stack, 401.9), 3);
  assert.equal(laneAt(s.stack, 402), -1);
  assert.equal(laneAt(s.stack, NaN), -1);
});

test('rowInLane resolves level, overflow and summary rows', () => {
  const s = scene(wideTrace(), { modes: { bg: LaneMode.Collapsed } });
  const row = createLaneRow();
  const api = 1;
  assert.deepEqual({ ...rowInLane(s.stack, s.layout, api, 0, row) }, { kind: LaneRowKind.Level, level: 0 });
  assert.equal(rowInLane(s.stack, s.layout, api, 17.9, row).level, 0);
  assert.equal(rowInLane(s.stack, s.layout, api, 18, row).level, 1);
  assert.equal(rowInLane(s.stack, s.layout, api, 15 * 18 + 17, row).level, 15);
  assert.equal(rowInLane(s.stack, s.layout, api, 16 * 18, row).kind, LaneRowKind.Overflow);
  assert.equal(rowInLane(s.stack, s.layout, api, 16 * 18 + 23, row).kind, LaneRowKind.Overflow);
  assert.equal(rowInLane(s.stack, s.layout, 3, 5, row).kind, LaneRowKind.Summary);
  assert.equal(rowInLane(s.stack, s.layout, 3, 5, row).level, -1);
});

test('view and content coordinates differ by the ruler and the scroll position', () => {
  const s = scene(wideTrace());
  assert.equal(viewY(s.layout, 100, 30), 40 + 100 - 30);
  assert.equal(contentY(s.layout, 110, 30), 100);
});

test('the scroll range follows the content height and the body height', () => {
  const s = scene(wideTrace(), { height: 240 });
  assert.equal(maxScroll(s.layout, s.stack), 402 - 200);
  assert.equal(clampScroll(s.layout, s.stack, 9999), 202);
  assert.equal(clampScroll(s.layout, s.stack, -5), 0);
  assert.equal(clampScroll(s.layout, s.stack, NaN), 0);
  const tall = scene(wideTrace(), { height: 2000 });
  assert.equal(maxScroll(tall.layout, tall.stack), 0);
});

test('scrollToRange keeps a visible stretch, aligns one above or below, or centres', () => {
  const s = scene(wideTrace(), { height: 240 }); // 200 px of body
  assert.equal(scrollToRange(s.layout, s.stack, 50, 100, 18, 'nearest'), 50, 'already visible');
  assert.equal(scrollToRange(s.layout, s.stack, 150, 100, 18, 'nearest'), 100, 'above: top edge');
  assert.equal(scrollToRange(s.layout, s.stack, 0, 300, 18, 'nearest'), 118, 'below: bottom edge');
  assert.equal(scrollToRange(s.layout, s.stack, 0, 200, 18, 'center'), 200 + 9 - 100);
  assert.equal(scrollToRange(s.layout, s.stack, 0, 300, 18, 'center'), 202, 'limited to the end');
  assert.equal(scrollToRange(s.layout, s.stack, 0, 0, 18, 'center'), 0, 'limited to the scrollable range');
});

test('lanesIn gives the positions that intersect a stretch', () => {
  const s = scene(wideTrace());
  assert.deepEqual(lanesIn(s.stack, 0, 10), { first: 0, last: 0 });
  assert.deepEqual(lanesIn(s.stack, 30, 40), { first: 0, last: 1 });
  assert.deepEqual(lanesIn(s.stack, -100, 10_000), { first: 0, last: 3 });
  assert.ok(lanesIn(s.stack, 500, 600).last < lanesIn(s.stack, 500, 600).first);
  assert.ok(lanesIn(s.stack, -50, -10).last < lanesIn(s.stack, -50, -10).first);
});

test('trackOfItem and laneOfTrack invert the model offsets', () => {
  const { model } = scene(wideTrace());
  for (let item = 0; item < model.itemRow.length; item++) {
    const track = trackOfItem(model, item);
    assert.ok(model.trackItemOff[track] <= item && item < model.trackItemOff[track + 1]);
    const lane = laneOfTrack(model, track);
    assert.ok(model.laneTrackOff[lane] <= track && track < model.laneTrackOff[lane + 1]);
  }
});

test('stackLanes on an empty trace has no lanes', () => {
  const s = scene({ resourceSpans: [] });
  assert.equal(s.stack.count, 0);
  assert.equal(s.stack.contentHeight, 0);
  assert.equal(laneAt(s.stack, 0), -1);
  assert.equal(stackLanes(s.model, s.layout, s.order, true, new Uint8Array(0)).count, 0);
});
