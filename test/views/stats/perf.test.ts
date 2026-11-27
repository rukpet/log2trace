import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SpanKind, buildSpanIndex } from '../../../src/core/index.ts';
import { computeSpanTimings } from '../../../src/core/self-time.ts';
import { buildStatsAggregation } from '../../../src/views/stats/model/aggregate.ts';
import { projectStatsRows } from '../../../src/views/stats/model/projection.ts';
import type { Span, TraceData } from '../../../src/core/otel/trace.ts';

function buildLargeTrace(n: number): TraceData {
  const services = ['api-gateway', 'order-svc', 'payment-svc', 'inventory-svc', 'db-proxy', 'cache-svc'];
  const ops = ['GET /checkout', 'createOrder', 'SELECT items', 'GET cache', 'chargeCard', 'publishEvent'];
  const bySvc = services.map(() => [] as Span[]);
  const baseNs = 1_700_000_000_000_000_000n;

  for (let i = 0; i < n; i++) {
    const svcIdx = i % services.length;
    const opIdx = (i * 7) % ops.length;
    const parentIdx = i === 0 ? -1 : Math.floor((i - 1) / 4);
    const startNs = baseNs + BigInt(i * 100_000);
    const durNs = BigInt(((i % 50) + 1) * 50_000);
    bySvc[svcIdx].push({
      traceId: 'perf-trace',
      spanId: `s-${i}`,
      parentSpanId: parentIdx >= 0 ? `s-${parentIdx}` : undefined,
      name: ops[opIdx],
      kind: (i % 5) + 1 as SpanKind,
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(startNs + durNs),
      attributes: [],
      status: { code: i % 97 === 0 ? 2 : 1 },
    });
  }

  return {
    resourceSpans: services.map((name, idx) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: name } }] },
      scopeSpans: [{ scope: { name: 'perf' }, spans: bySvc[idx] }],
    })),
  };
}

test('aggregates and sorts 50,000 spans well within interactive budget', () => {
  const index = buildSpanIndex(buildLargeTrace(50_000));
  // Warm up JIT once
  const warmTimings = computeSpanTimings(index, null);
  buildStatsAggregation(index, warmTimings, null, 'service-operation', true);

  const t0 = performance.now();
  const timings = computeSpanTimings(index, null);
  const agg = buildStatsAggregation(index, timings, null, 'service-operation', true);
  const proj = projectStatsRows(agg, 'p95', 'desc', new Set());
  const elapsed = performance.now() - t0;

  assert.equal(agg.activeSpans.length, 50_000);
  assert.equal(proj.rowCount, agg.groupCount);
  assert.ok(elapsed < 100, `50k stats aggregation + projection took ${elapsed.toFixed(1)}ms (expected < 100ms)`);
});
