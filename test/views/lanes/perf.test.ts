import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SpanKind, buildSpanIndex } from '../../../src/core/index.ts';
import { createCamera } from '../../../src/kit/geometry/camera1d.ts';
import { buildLaneModel } from '../../../src/views/lanes/model/lanes.ts';
import { DEFAULT_METRICS, LaneMode, computeLayout, stackLanes } from '../../../src/views/lanes/model/layout.ts';
import { LanesFramePlan, MAX_BARS, SummarySource, buildLanesPlan } from '../../../src/views/lanes/model/plan.ts';
import { HitPart, createHitResult, hitTest } from '../../../src/views/lanes/model/hit.ts';
import { fitText, largeTrace } from '../../support/lanes-scene.ts';
import type { Span } from '../../../src/core/otel/trace.ts';

test('builds the lane model of 50,000 spans well within interactive budget', () => {
  const index = buildSpanIndex(largeTrace(50_000));
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

test('plans the full-extent frame of 50,000 spans fast and within the bar budget', () => {
  const index = buildSpanIndex(largeTrace(50_000));
  const model = buildLaneModel(index);
  const layout = computeLayout(DEFAULT_METRICS, 1400, 900);
  const camera = createCamera(index.table.extentMs, layout.plotWidth);
  const stack = stackLanes(model, layout, model.order, true, new Uint8Array(model.laneCount).fill(LaneMode.Capped));
  const summaries = new SummarySource(model);
  const plan = new LanesFramePlan();
  const frame = (): void =>
    buildLanesPlan(plan, { model, layout, stack, camera, scrollTop: 0, overscan: 4, matched: null, selection: null, hovered: null, summaries, fitText });

  frame(); // warm up the JIT and the summary caches
  const runs = 20;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) frame();
  const elapsed = (performance.now() - t0) / runs;

  assert.ok(plan.runCount > 100 && plan.runCount <= MAX_BARS, `${plan.runCount} runs`);
  assert.ok(elapsed < 40, `a full-extent plan took ${elapsed.toFixed(2)}ms (expected < 40ms, target 8ms)`);

  const hit = createHitResult();
  const h0 = performance.now();
  for (let i = 0; i < 1000; i++) hitTest(plan, 300 + (i % 800), 60 + (i % 600), hit);
  const perHit = (performance.now() - h0) / 1000;
  assert.ok(perHit < 0.5, `a hit test took ${perHit.toFixed(3)}ms`);
  assert.ok(hit.part >= HitPart.None);
});

test('plans a deep zoom of 50,000 spans with every lane open just as fast', () => {
  const index = buildSpanIndex(largeTrace(50_000));
  const model = buildLaneModel(index);
  const layout = computeLayout(DEFAULT_METRICS, 1400, 900);
  const full = createCamera(index.table.extentMs, layout.plotWidth);
  const camera = { ...full, t0: 20_000, t1: 20_500 };
  const stack = stackLanes(model, layout, model.order, true, new Uint8Array(model.laneCount).fill(LaneMode.Full));
  const plan = new LanesFramePlan();
  const summaries = new SummarySource(model);
  const frame = (): void =>
    buildLanesPlan(plan, { model, layout, stack, camera, scrollTop: 400, overscan: 4, matched: null, selection: null, hovered: null, summaries, fitText });

  frame();
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) frame();
  const elapsed = (performance.now() - t0) / 20;
  assert.ok(plan.runCount > 0 && plan.runCount <= MAX_BARS);
  assert.ok(elapsed < 40, `a deep-zoom plan took ${elapsed.toFixed(2)}ms (expected < 40ms)`);
});
