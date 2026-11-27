import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanMask, buildSpanIndex } from '../../../src/core/index.ts';
import { computeSpanTimings } from '../../../src/core/self-time.ts';
import {
  buildStatsAggregation,
  describeStatsGroup,
  describeStatsSpan,
  primarySpanOfGroup,
  spansOfGroup,
} from '../../../src/views/stats/model/aggregate.ts';
import { span, trace } from '../../support/trace-builder.ts';

function buildSampleIndex() {
  // api-gateway: GET /checkout [0, 200] (Server)
  //   db-svc: SELECT item [10, 20] (Client, 10ms)
  //   db-svc: SELECT item [25, 45] (Client, 20ms)
  //   db-svc: SELECT item [50, 120] (Client, 70ms, Error)
  //   db-svc: SELECT item [125, 135] (Client, 10ms)
  //   worker-svc: evalExpr [140, 190] (Internal, 50ms)
  //     worker-svc: evalExpr [150, 180] (Internal, 30ms — recursive nested call!)
  //       worker-svc: evalExpr [160, 170] (Internal, 10ms — deeper recursion!)
  return buildSpanIndex(
    trace(
      ['api-gateway', [span('root', undefined, 0, 200, { name: 'GET /checkout', kind: SpanKind.Server })]],
      [
        'db-svc',
        [
          span('q1', 'root', 10, 20, { name: 'SELECT item', kind: SpanKind.Client }),
          span('q2', 'root', 25, 45, { name: 'SELECT item', kind: SpanKind.Client }),
          span('q3', 'root', 50, 120, { name: 'SELECT item', kind: SpanKind.Client, status: { code: 2 } }),
          span('q4', 'root', 125, 135, { name: 'SELECT item', kind: SpanKind.Client }),
        ],
      ],
      [
        'worker-svc',
        [
          span('rec1', 'root', 140, 190, { name: 'evalExpr', kind: SpanKind.Internal }),
          span('rec2', 'rec1', 150, 180, { name: 'evalExpr', kind: SpanKind.Internal }),
          span('rec3', 'rec2', 160, 170, { name: 'evalExpr', kind: SpanKind.Internal }),
        ],
      ],
    ),
  );
}

test('aggregates service-operation groups with recursion-safe Total and exact percentiles', () => {
  const index = buildSampleIndex();
  const timings = computeSpanTimings(index, null);
  const agg = buildStatsAggregation(index, timings, null, 'service-operation', true);

  assert.equal(agg.groupCount, 3);
  assert.equal(agg.activeSpans.length, 8);

  const dbIdx = agg.label.indexOf('SELECT item');
  assert.ok(dbIdx >= 0);
  assert.equal(agg.secondary[dbIdx], 'db-svc');
  assert.equal(agg.count[dbIdx], 4);
  assert.equal(agg.errorCount[dbIdx], 1);
  assert.equal(agg.selfMs[dbIdx], 110);
  assert.equal(agg.totalMs[dbIdx], 110);
  assert.equal(agg.minMs[dbIdx], 10);
  assert.equal(agg.avgMs[dbIdx], 27.5);
  assert.equal(agg.p50Ms[dbIdx], 10);
  assert.equal(agg.p95Ms[dbIdx], 70);
  assert.equal(agg.maxMs[dbIdx], 70);

  // Recursive evalExpr: 3 calls (50ms, 30ms, 10ms), but inclusive total must NOT double-count (50ms, not 90ms)
  const recIdx = agg.label.indexOf('evalExpr');
  assert.ok(recIdx >= 0);
  assert.equal(agg.count[recIdx], 3);
  assert.equal(agg.totalMs[recIdx], 50);
  assert.equal(agg.selfMs[recIdx], 20 + 20 + 10);
  assert.equal(agg.minMs[recIdx], 10);
  assert.equal(agg.avgMs[recIdx], 30);
  assert.equal(agg.p50Ms[recIdx], 30);
  assert.equal(agg.maxMs[recIdx], 50);
});

test('supports service, operation, kind, and flat none grouping modes', () => {
  const index = buildSampleIndex();
  const timings = computeSpanTimings(index, null);

  const bySvc = buildStatsAggregation(index, timings, null, 'service', true);
  assert.equal(bySvc.groupCount, 3);
  assert.deepEqual([...bySvc.label].sort(), ['api-gateway', 'db-svc', 'worker-svc']);

  const byKind = buildStatsAggregation(index, timings, null, 'kind', true);
  assert.equal(byKind.groupCount, 3);
  assert.deepEqual([...byKind.label].sort(), ['Client', 'Internal', 'Server']);

  const flat = buildStatsAggregation(index, timings, null, 'none', true);
  assert.equal(flat.groupCount, 0);
  assert.equal(flat.activeSpans.length, 8);
});

test('filtering preserves pre-filter causal self-time in both matchesOnly and dim modes', () => {
  const index = buildSampleIndex();
  const timings = computeSpanTimings(index, null);
  const rootOnly = SpanMask.of(index, ['root']);

  // root's self-time is 200 - (10 + 20 + 70 + 10 + 50) = 40ms even when children are filtered out!
  const filtered = buildStatsAggregation(index, timings, rootOnly, 'service-operation', true);
  assert.equal(filtered.groupCount, 1);
  assert.equal(filtered.selfMs[0], 40);
  assert.equal(filtered.totalSelfMs, 40);

  const dimmed = buildStatsAggregation(index, timings, rootOnly, 'service-operation', false);
  assert.equal(dimmed.groupCount, 3);
  const rootGroup = dimmed.label.indexOf('GET /checkout');
  const dbGroup = dimmed.label.indexOf('SELECT item');
  assert.equal(dimmed.matchedCount[rootGroup], 1);
  assert.equal(dimmed.matchedCount[dbGroup], 0);
});

test('primarySpanOfGroup picks sort-aware representative span and describe builders return InfoModels', () => {
  const index = buildSampleIndex();
  const timings = computeSpanTimings(index, null);
  const agg = buildStatsAggregation(index, timings, null, 'service-operation', true);
  const dbIdx = agg.label.indexOf('SELECT item');

  assert.equal(primarySpanOfGroup(agg, dbIdx, 'errors', 'desc'), 'q3');
  assert.equal(primarySpanOfGroup(agg, dbIdx, 'self', 'desc'), 'q3');
  assert.equal(primarySpanOfGroup(agg, dbIdx, 'min', 'asc'), 'q1');

  const groupSpans = spansOfGroup(agg, dbIdx, 'self', 'desc');
  assert.equal(groupSpans.ids.length, 4);
  assert.equal(groupSpans.primary, 'q3');

  const groupInfo = describeStatsGroup(agg, dbIdx);
  assert.equal(groupInfo.title, 'SELECT item');
  assert.equal(groupInfo.subtitle, 'db-svc');
  assert.equal(groupInfo.status, 'error');
  assert.equal(groupInfo.sections.length, 2);

  const spanInfo = describeStatsSpan(agg, index.spans.get('q3')?.idx ?? 0);
  assert.equal(spanInfo.title, 'SELECT item');
  assert.equal(spanInfo.status, 'error');
});
