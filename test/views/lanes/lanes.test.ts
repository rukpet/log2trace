import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanMask, buildSpanIndex, createTraceStore, type SpanIndex } from '../../../src/core/index.ts';
import { LaneKind, buildLaneModel, lanesModel, matchedSteps, orderLanes, trackOf, type LaneModel } from '../../../src/views/lanes/model/lanes.ts';
import { levelAt } from '../../../src/views/lanes/model/summary.ts';
import { kv, random, span, trace } from '../../support/trace-builder.ts';
import type { Span } from '../../../src/core/otel/trace.ts';

const rowOf = (index: SpanIndex, id: string): number => index.table.ids.indexOf(id);
const laneNamed = (m: LaneModel, name: string): number => m.names.indexOf(name);

/** web calls api (cross-service), api queries postgres and redis, api has concurrent workers. */
function sampleTrace() {
  return trace(
    ['web', [
      span('w', undefined, 0, 100, { kind: SpanKind.Server }),
      span('w-call', 'w', 5, 90, { kind: SpanKind.Client }),
    ]],
    ['api', [
      span('a', 'w-call', 10, 80, { kind: SpanKind.Server }),
      span('a-db1', 'a', 20, 30, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')] }),
      span('a-db2', 'a', 25, 40, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')], status: { code: 2 } }),
      span('a-cache', 'a', 50, 55, { kind: SpanKind.Client, attributes: [kv('db.system', 'redis')] }),
      span('a-work', 'a', 60, 70),
    ]],
  );
}

test('services get one lane each, peers one lane per inferred peer', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index);

  assert.equal(m.serviceCount, 2);
  assert.equal(m.laneCount, 4);
  assert.deepEqual([...m.names].sort(), ['api', 'postgres', 'redis', 'web']);
  for (let l = 0; l < m.laneCount; l++) assert.equal(m.kind[l], l < m.serviceCount ? LaneKind.Service : LaneKind.Peer);

  const web = laneNamed(m, 'web');
  const api = laneNamed(m, 'api');
  assert.equal(m.laneOfRow[rowOf(index, 'w')], web);
  assert.equal(m.laneOfRow[rowOf(index, 'a-db1')], api);
});

test('a call to an instrumented service has no ghost; a call to an uninstrumented peer does', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index);

  assert.equal(m.ghostLaneOfRow[rowOf(index, 'w-call')], -1);
  assert.equal(m.ghostLevelOfRow[rowOf(index, 'w-call')], -1);
  assert.equal(m.ghostLaneOfRow[rowOf(index, 'a')], -1);
  assert.equal(m.ghostLaneOfRow[rowOf(index, 'a-db1')], laneNamed(m, 'postgres'));
  assert.equal(m.ghostLaneOfRow[rowOf(index, 'a-db2')], laneNamed(m, 'postgres'));
  assert.equal(m.ghostLaneOfRow[rowOf(index, 'a-cache')], laneNamed(m, 'redis'));
  assert.equal(m.ghostLaneOfRow[rowOf(index, 'a-work')], -1);
});

test('peers: false builds service lanes only', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index, { peers: false });

  assert.equal(m.laneCount, 2);
  assert.ok(m.ghostLaneOfRow.every(l => l === -1));
});

test('a ghost is packed on its peer lane without a parent constraint, overlapping calls take two levels', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index);
  const pg = laneNamed(m, 'postgres');

  assert.equal(m.levelCount[pg], 2);
  const l1 = m.ghostLevelOfRow[rowOf(index, 'a-db1')];
  const l2 = m.ghostLevelOfRow[rowOf(index, 'a-db2')];
  assert.notEqual(l1, l2);
  assert.equal(m.peak[pg], 2);
  assert.equal(m.spanCount[pg], 2);
  assert.equal(m.errorCount[pg], 1);
  assert.equal(m.callerLane[pg], laneNamed(m, 'api'));
  assert.equal(m.callerLane[laneNamed(m, 'api')], -1);
});

test('a cross-service child starts at level 0 of its own lane', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index);

  assert.equal(m.levelOfRow[rowOf(index, 'w')], 0);
  assert.equal(m.levelOfRow[rowOf(index, 'w-call')], 1);
  assert.equal(m.levelOfRow[rowOf(index, 'a')], 0);
  assert.equal(m.levelOfRow[rowOf(index, 'a-db1')], 1);
});

test('tracks hold one level each, sorted by start without overlap, and every item is reachable', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index);
  const t = index.table;

  assert.equal(m.laneTrackOff[m.laneCount], m.levelCount.reduce((a, b) => a + b, 0));
  let ghosts = 0;
  for (let l = 0; l < m.laneCount; l++) {
    assert.equal(m.laneTrackOff[l + 1] - m.laneTrackOff[l], m.levelCount[l]);
    for (let v = 0; v < m.levelCount[l]; v++) {
      const track = trackOf(m, l, v);
      assert.ok(m.trackItemOff[track + 1] > m.trackItemOff[track], 'no empty tracks');
      for (let i = m.trackItemOff[track]; i < m.trackItemOff[track + 1]; i++) {
        const r = m.itemRow[i];
        assert.equal(m.itemStart[i], t.start[r]);
        assert.ok(m.itemEnd[i] >= m.itemStart[i]);
        assert.equal(m.itemGhost[i], l >= m.serviceCount ? 1 : 0);
        if (m.itemGhost[i]) {
          ghosts++;
          assert.equal(m.ghostItemOfRow[r], i);
          assert.equal(m.ghostLaneOfRow[r], l);
          assert.equal(m.ghostLevelOfRow[r], v);
        } else {
          assert.equal(m.itemOfRow[r], i);
          assert.equal(m.laneOfRow[r], l);
          assert.equal(m.levelOfRow[r], v);
        }
        if (i > m.trackItemOff[track]) {
          assert.ok(m.itemStart[i] >= m.itemEnd[i - 1], 'items of a track do not overlap');
        }
      }
    }
  }
  assert.equal(ghosts, 3);
  assert.equal(m.itemRow.length, t.length + 3);
});

test('level count covers the peak concurrency and children sit below same-lane parents', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const rnd = random(seed);
    const groups: Array<[string, Span[]]> = [['a', []], ['b', []], ['c', []]];
    let id = 0;
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) {
      const parent = ids.length > 0 && rnd() < 0.7 ? ids[Math.floor(rnd() * ids.length)] : undefined;
      const s = Math.floor(rnd() * 500);
      const sid = `s${id++}`;
      ids.push(sid);
      const attributes = rnd() < 0.1 ? [kv('db.system', rnd() < 0.5 ? 'pg' : 'redis')] : [];
      groups[Math.floor(rnd() * 3)][1].push(span(sid, parent, s, s + Math.floor(rnd() * 50), { kind: attributes.length > 0 ? SpanKind.Client : SpanKind.Internal, attributes }));
    }
    const index = buildSpanIndex(trace(...groups));
    const m = buildLaneModel(index);
    const t = index.table;
    for (let r = 0; r < t.length; r++) {
      assert.ok(m.levelOfRow[r] < m.levelCount[m.laneOfRow[r]]);
      if (t.parent[r] >= 0 && m.laneOfRow[t.parent[r]] === m.laneOfRow[r]) {
        assert.ok(m.levelOfRow[r] > m.levelOfRow[t.parent[r]]);
      }
    }
    for (let l = 0; l < m.laneCount; l++) {
      assert.ok(m.levelCount[l] >= m.peak[l], `lane ${l}: ${m.levelCount[l]} levels for peak ${m.peak[l]}`);
    }
    for (let track = 0; track < m.trackItemOff.length - 1; track++) {
      for (let i = m.trackItemOff[track] + 1; i < m.trackItemOff[track + 1]; i++) {
        assert.ok(m.itemStart[i] >= m.itemEnd[i - 1]);
      }
    }
  }
});

test('stats: span and error counts, first start, busy time, peak concurrency', () => {
  const index = buildSpanIndex(sampleTrace());
  const m = buildLaneModel(index);
  const api = laneNamed(m, 'api');
  const web = laneNamed(m, 'web');

  assert.equal(m.spanCount[api], 5);
  assert.equal(m.spanCount[web], 2);
  assert.equal(m.errorCount[api], 1);
  assert.equal(m.errorCount[web], 0);
  assert.equal(m.firstStart[api], 10);
  assert.equal(m.firstStart[web], 0);
  // api: a (10-80) is the only local root, so one request in flight even when children overlap
  assert.equal(m.peak[api], 1);
  assert.equal(m.busyMs[api], 70);
  assert.equal(m.busyMs[web], 100);
  // web: w is a local root, w-call is its child in the same lane
  assert.equal(m.peak[web], 1);
  const pg = laneNamed(m, 'postgres');
  assert.equal(m.busyMs[pg], 20, 'union of 20-30 and 25-40');
});

test('a service lane counts local roots, not nested spans', () => {
  const index = buildSpanIndex(trace(['svc', [
    span('r1', undefined, 0, 100),
    span('c1', 'r1', 10, 90),
    span('c2', 'c1', 20, 80),
    span('r2', undefined, 50, 120),
  ]]));
  const m = buildLaneModel(index);

  assert.equal(m.peak[0], 2);
  assert.equal(levelAt(m.steps[0], 60), 2);
  assert.equal(levelAt(m.steps[0], 110), 1);
  assert.ok(m.levelCount[0] >= 3, 'drawn levels still show nesting');
  assert.deepEqual([...m.countedRow.subarray(m.countedOff[0], m.countedOff[1])].sort(), [0, 3]);
});

test('busy time of a service lane includes nested spans that outlive their roots', () => {
  const index = buildSpanIndex(trace(['svc', [
    span('root', undefined, 0, 10),
    span('async', 'root', 5, 30),
  ]]));
  const m = buildLaneModel(index);

  assert.equal(m.busyMs[0], 30);
  assert.equal(m.busy[0].to[0], 30);
});

test('matchedSteps counts only matched spans and returns the precomputed steps without a mask', () => {
  const index = buildSpanIndex(trace(['svc', [
    span('a', undefined, 0, 100),
    span('b', undefined, 10, 90, { status: { code: 2 } }),
    span('c', undefined, 200, 210, { status: { code: 2 } }),
  ]]));
  const m = buildLaneModel(index);
  assert.equal(matchedSteps(m, 0, null), m.steps[0]);

  const errors = SpanMask.of(index, ['b', 'c']);
  const s = matchedSteps(m, 0, errors);
  assert.equal(s.peak, 1);
  assert.equal(levelAt(s, 5), 0);
  assert.equal(levelAt(s, 50), 1);
  assert.equal(levelAt(s, 205), 1);

  const none = matchedSteps(m, 0, SpanMask.empty(index));
  assert.equal(none.peak, 0);
});

test('error rows are listed by start per lane', () => {
  const index = buildSpanIndex(trace(['svc', [
    span('late', undefined, 50, 60, { status: { code: 2 } }),
    span('ok', undefined, 10, 20),
    span('early', undefined, 5, 8, { status: { code: 2 } }),
  ]]));
  const m = buildLaneModel(index);
  const rows = [...m.errorRow.subarray(m.errorOff[0], m.errorOff[1])];

  assert.deepEqual(rows.map(r => index.table.ids[r]), ['early', 'late']);
  assert.deepEqual([...m.errorStart], [0, 45]);
});

test('default order: by first start, a peer directly after the service that calls it', () => {
  const index = buildSpanIndex(trace(
    ['late-svc', [span('l', undefined, 100, 110)]],
    ['early-svc', [
      span('e', undefined, 0, 50),
      span('e-db', 'e', 10, 20, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')] }),
    ]],
    ['mid-svc', [
      span('m', undefined, 30, 40),
      span('m-q', 'm', 31, 35, { kind: SpanKind.Producer, attributes: [kv('messaging.system', 'kafka')] }),
    ]],
  ));
  const m = buildLaneModel(index);

  assert.deepEqual([...m.order].map(l => m.names[l]), ['early-svc', 'postgres', 'mid-svc', 'kafka', 'late-svc']);
  assert.deepEqual([...orderLanes(m, 'start')], [...m.order]);
});

test('orderLanes by name and by busy time reorder without touching the packing', () => {
  const index = buildSpanIndex(trace(
    ['b', [span('b1', undefined, 0, 10)]],
    ['a', [span('a1', undefined, 5, 100)]],
    ['c', [span('c1', undefined, 6, 50), span('c-db', 'c1', 7, 9, { kind: SpanKind.Client, attributes: [kv('db.system', 'redis')] })]],
  ));
  const m = buildLaneModel(index);
  const levels = m.levelOfRow.slice();

  assert.deepEqual([...orderLanes(m, 'name')].map(l => m.names[l]), ['a', 'b', 'c', 'redis']);
  assert.deepEqual([...orderLanes(m, 'busy')].map(l => m.names[l]), ['a', 'c', 'b', 'redis']);
  assert.deepEqual([...m.levelOfRow], [...levels]);
  assert.equal(orderLanes(m, 'name').length, m.laneCount);
});

test('an empty trace has no lanes', () => {
  const m = buildLaneModel(buildSpanIndex({ resourceSpans: [] }));

  assert.equal(m.laneCount, 0);
  assert.equal(m.order.length, 0);
  assert.equal(m.itemRow.length, 0);
});

test('zero-duration spans get their own level when they coincide', () => {
  const index = buildSpanIndex(trace(['svc', [
    span('a', undefined, 10, 10),
    span('b', undefined, 10, 10),
  ]]));
  const m = buildLaneModel(index);

  assert.equal(m.levelCount[0], 2);
  assert.equal(m.peak[0], 2);
  assert.equal(m.itemEnd[0], m.itemStart[0]);
});

test('the selector builds the model once per trace and keeps it across unrelated changes', () => {
  const store = createTraceStore();
  store.setData(buildSpanIndex(sampleTrace()));
  const first = store.derive(lanesModel);

  assert.equal(first.laneCount, 4);
  assert.equal(store.derive(lanesModel), first);
  store.setWindow({ t0: 0, t1: 50 });
  store.setHover([...store.state.data.index.spans.keys()].slice(0, 1));
  assert.equal(store.derive(lanesModel), first);

  store.setData(buildSpanIndex(trace(['other', [span('x', undefined, 0, 1)]])));
  assert.equal(store.derive(lanesModel).laneCount, 1);
});
