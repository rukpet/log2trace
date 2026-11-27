import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SpanKind, buildSpanIndex } from '../../../src/core/index.ts';
import { buildLaneModel } from '../../../src/views/lanes/model/lanes.ts';
import { random } from '../../support/trace-builder.ts';
import type { Span, TraceData } from '../../../src/core/otel/trace.ts';

/** `n` spans over six services with heavy concurrency, nesting and database calls, deterministic. */
function buildLargeTrace(n: number): TraceData {
  const services = ['api-gateway', 'order-svc', 'payment-svc', 'inventory-svc', 'worker-pool', 'cache-svc'];
  const bySvc = services.map(() => [] as Span[]);
  const baseNs = 1_700_000_000_000_000_000n;
  const rnd = random(7);

  for (let i = 0; i < n; i++) {
    const svcIdx = i % services.length;
    const parentIdx = i === 0 ? -1 : Math.floor(rnd() * i);
    const startNs = baseNs + BigInt(Math.floor(rnd() * 60_000_000_000));
    const durNs = BigInt(Math.floor(rnd() * 200_000_000));
    const call = i % 9 === 0;
    bySvc[svcIdx].push({
      traceId: 'perf-trace',
      spanId: `s-${i}`,
      parentSpanId: parentIdx >= 0 ? `s-${parentIdx}` : undefined,
      name: `op-${i % 20}`,
      kind: call ? SpanKind.Client : SpanKind.Internal,
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(startNs + durNs),
      attributes: call ? [{ key: 'db.system', value: { stringValue: i % 2 === 0 ? 'postgresql' : 'redis' } }] : [],
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

test('builds the lane model of 50,000 spans well within interactive budget', () => {
  const index = buildSpanIndex(buildLargeTrace(50_000));
  buildLaneModel(index); // warm up the JIT once

  const t0 = performance.now();
  const model = buildLaneModel(index);
  const elapsed = performance.now() - t0;

  assert.equal(model.serviceCount, 6);
  assert.equal(model.laneCount, 8);
  assert.ok(model.itemRow.length > 50_000, 'ghosts add items');
  assert.ok(elapsed < 150, `50k lane model took ${elapsed.toFixed(1)}ms (expected < 150ms, target 80ms)`);
});

test('packs 50,000 spans that are all in flight at once without quadratic cost', () => {
  const spans: Span[] = [];
  const baseNs = 1_700_000_000_000_000_000n;
  for (let i = 0; i < 50_000; i++) {
    spans.push({
      traceId: 'perf-trace',
      spanId: `s-${i}`,
      name: 'op',
      kind: SpanKind.Internal,
      startTimeUnixNano: String(baseNs + BigInt(i * 1000)),
      endTimeUnixNano: String(baseNs + 1_000_000_000n),
      attributes: [],
    });
  }
  const index = buildSpanIndex({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
      scopeSpans: [{ scope: { name: 'perf' }, spans }],
    }],
  });

  const t0 = performance.now();
  const model = buildLaneModel(index);
  const elapsed = performance.now() - t0;

  assert.equal(model.levelCount[0], 50_000);
  assert.equal(model.peak[0], 50_000);
  assert.ok(elapsed < 300, `fully concurrent 50k lane took ${elapsed.toFixed(1)}ms (expected < 300ms)`);
});
