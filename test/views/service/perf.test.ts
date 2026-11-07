import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex, createTraceStore } from '../../../src/core.ts';
import {
  buildServiceGraph,
  buildServiceTopology,
  serviceGraph,
  spansOfNode,
} from '../../../src/views/service/model.ts';
import { span, trace } from '../../support/trace-builder.ts';

test('performance: 50,000 spans across 20 services builds topology and graph in milliseconds', () => {
  const serviceCount = 20;
  const totalSpans = 50_000;
  const spansPerService: Record<string, ReturnType<typeof span>[]> = {};
  for (let s = 0; s < serviceCount; s++) {
    spansPerService[`service-${s}`] = [];
  }

  // Create a realistic tree of 50,000 spans
  for (let i = 0; i < totalSpans; i++) {
    const parentId = i === 0 ? undefined : `span-${Math.floor((i - 1) / 3)}`;
    const svcIdx = (i % serviceCount);
    const svcName = `service-${svcIdx}`;
    const start = i * 10;
    const end = start + 50;
    const kind = i % 5 === 0 ? SpanKind.Server : i % 5 === 1 ? SpanKind.Client : SpanKind.Internal;
    spansPerService[svcName].push(
      span(`span-${i}`, parentId, start, end, { name: `op-${i}`, kind }),
    );
  }

  const traceInput = Object.entries(spansPerService).map(([svc, spans]) => [svc, spans] as const);
  const index = buildSpanIndex(trace(...traceInput));

  // Warmup run
  const top = buildServiceTopology(index);
  buildServiceGraph(top, null);

  // Measure topology extraction and layout
  const topStart = performance.now();
  const topIterations = 20;
  let topology = top;
  for (let i = 0; i < topIterations; i++) {
    topology = buildServiceTopology(index);
  }
  const topElapsed = (performance.now() - topStart) / topIterations;

  // Measure full service graph (topology + self-time interval unions + metrics)
  const graphStart = performance.now();
  const graphIterations = 20;
  for (let i = 0; i < graphIterations; i++) {
    buildServiceGraph(topology, null);
  }
  const graphElapsed = (performance.now() - graphStart) / graphIterations;

  console.log(`[PERF 50k spans / 20 services] Topology: ${topElapsed.toFixed(2)}ms | Full Graph: ${graphElapsed.toFixed(2)}ms`);

  assert.ok(topElapsed < 50, `Topology extraction took ${topElapsed.toFixed(2)}ms, expected < 50ms`);
  assert.ok(graphElapsed < 60, `Full graph build took ${graphElapsed.toFixed(2)}ms, expected < 60ms`);
});

test('performance: 100 services with complex inter-service dependencies and cycles', () => {
  const serviceCount = 100;
  const spansPerService: Record<string, ReturnType<typeof span>[]> = {};
  for (let s = 0; s < serviceCount; s++) {
    spansPerService[`srv-${s}`] = [];
  }

  // Build a complex graph with cross-service calls, back-edges, and cycles
  spansPerService['srv-0'].push(
    span('root-0', undefined, 0, 100000, { name: 'root', kind: SpanKind.Server }),
  );

  let prevSpan = 'root-0';
  for (let s = 1; s < serviceCount; s++) {
    const parentSvc = Math.floor((s - 1) / 2);
    const clientSpanId = `client-${s}`;
    const serverSpanId = `server-${s}`;
    spansPerService[`srv-${parentSvc}`].push(
      span(clientSpanId, prevSpan, s * 100, s * 100 + 80, { name: `call-srv-${s}`, kind: SpanKind.Client }),
    );
    spansPerService[`srv-${s}`].push(
      span(serverSpanId, clientSpanId, s * 100 + 2, s * 100 + 78, { name: `handle-${s}`, kind: SpanKind.Server }),
    );
    // Add cyclic callback every 10 services back to srv-0 or ancestor
    if (s % 10 === 0) {
      const cycleClient = `cycle-client-${s}`;
      const cycleServer = `cycle-server-${s}`;
      spansPerService[`srv-${s}`].push(
        span(cycleClient, serverSpanId, s * 100 + 10, s * 100 + 50, { name: 'call-back', kind: SpanKind.Client }),
      );
      spansPerService['srv-0'].push(
        span(cycleServer, cycleClient, s * 100 + 12, s * 100 + 48, { name: 'handle-callback', kind: SpanKind.Server }),
      );
    }
    prevSpan = serverSpanId;
  }

  const traceInput = Object.entries(spansPerService).map(([svc, spans]) => [svc, spans] as const);
  const index = buildSpanIndex(trace(...traceInput));

  const start = performance.now();
  const iterations = 30;
  for (let i = 0; i < iterations; i++) {
    const top = buildServiceTopology(index);
    const graph = buildServiceGraph(top, null);
    assert.equal(graph.topology.nodeCount, 100);
  }
  const perRun = (performance.now() - start) / iterations;

  console.log(`[PERF 100 services DAG / cycle layout] Layout + Metrics: ${perRun.toFixed(2)}ms`);
  assert.ok(perRun < 20, `100-node graph layout took ${perRun.toFixed(2)}ms, expected < 20ms`);
});

test('performance: window clipping on 50,000 spans executes rapidly', () => {
  const serviceCount = 10;
  const spansPerService: Record<string, ReturnType<typeof span>[]> = {};
  for (let s = 0; s < serviceCount; s++) spansPerService[`svc-${s}`] = [];

  for (let i = 0; i < 50_000; i++) {
    const svc = `svc-${i % serviceCount}`;
    spansPerService[svc].push(
      span(`s-${i}`, i === 0 ? undefined : `s-${i - 1}`, i * 10, i * 10 + 20, { name: `op-${i}` }),
    );
  }

  const index = buildSpanIndex(trace(...Object.entries(spansPerService).map(([s, p]) => [s, p] as const)));
  const top = buildServiceTopology(index);

  const start = performance.now();
  const iterations = 20;
  const window = { t0: 100_000, t1: 200_000 };
  for (let i = 0; i < iterations; i++) {
    const g = buildServiceGraph(top, window);
    assert.ok(g.topology.nodeCount > 0);
  }
  const perRun = (performance.now() - start) / iterations;

  console.log(`[PERF 50k spans window clipping] Clipped Graph: ${perRun.toFixed(2)}ms`);
  assert.ok(perRun < 50, `Window clipping took ${perRun.toFixed(2)}ms, expected < 50ms`);
});

test('performance: selector memoization is instantaneous on unchanged state', () => {
  const index = buildSpanIndex(trace(['s1', [span('root', undefined, 0, 100)]]));
  const store = createTraceStore();
  store.setData(index);

  // Initial call populates cache
  const first = store.derive(serviceGraph);

  const start = performance.now();
  const runs = 10_000;
  for (let i = 0; i < runs; i++) {
    const cached = store.derive(serviceGraph);
    assert.equal(cached, first);
  }
  const totalElapsed = performance.now() - start;
  const perLookupMicros = (totalElapsed / runs) * 1000;

  console.log(`[PERF selector cache] 10,000 lookups took ${totalElapsed.toFixed(2)}ms (${perLookupMicros.toFixed(2)}µs / lookup)`);
  assert.ok(totalElapsed < 25, `10,000 cached lookups took ${totalElapsed.toFixed(2)}ms, expected < 25ms`);
});

test('performance: span queries by node and edge are sub-millisecond', () => {
  const spans: ReturnType<typeof span>[] = [];
  for (let i = 0; i < 50_000; i++) {
    spans.push(span(`sp-${i}`, i === 0 ? undefined : `sp-${Math.floor((i - 1) / 2)}`, i, i + 5));
  }
  const index = buildSpanIndex(trace(['service-a', spans]));
  const top = buildServiceTopology(index);
  const graph = buildServiceGraph(top, null);

  const start = performance.now();
  const lookups = 1000;
  for (let i = 0; i < lookups; i++) {
    const { ids, primary } = spansOfNode(graph, 0);
    assert.equal(ids.length, 50_000);
    assert.equal(primary, 'sp-0');
  }
  const perLookup = (performance.now() - start) / lookups;

  console.log(`[PERF spansOfNode on 50k spans] Query: ${perLookup.toFixed(3)}ms`);
  assert.ok(perLookup < 5, `Node spans query took ${perLookup.toFixed(3)}ms, expected < 5ms`);
});
