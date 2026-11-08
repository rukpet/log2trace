import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SPAN_SET,
  SpanKind,
  buildSpanIndex,
  createTraceStore,
  type SpanIndex,
} from '../../../src/core.ts';
import { computeSequenceLayout } from '../../../src/views/sequence/model/layout.ts';
import {
  buildSequenceModel,
  sequenceModel,
} from '../../../src/views/sequence/model/messages.ts';
import {
  SequencePlan,
  buildSequencePlan,
} from '../../../src/views/sequence/model/plan.ts';
import { StepKind, projectSteps } from '../../../src/views/sequence/model/steps.ts';
import { kv, span, trace } from '../../support/trace-builder.ts';

/**
 * Generates a realistic multi-service synthetic trace of exactly `totalSpans` spans
 * containing:
 * - Root `SERVER` spans entering from the synthetic Gate
 * - Cross-service synchronous `CLIENT` -> `SERVER` calls
 * - Cross-service asynchronous `PRODUCER` -> `CONSUMER` messages
 * - Leaf DB `CLIENT` calls with `db.system` (inferred peer participants)
 * - Repeated N+1 query loops (consecutive identical sibling leaf DB `CLIENT` spans)
 */
function buildSyntheticSequenceTrace(totalSpans: number, serviceCount: number): SpanIndex {
  const spansPerService: Record<string, ReturnType<typeof span>[]> = {};
  for (let s = 0; s < serviceCount; s++) {
    spansPerService[`service-${s}`] = [];
  }

  let created = 0;
  let batch = 0;

  while (created < totalSpans) {
    const rootId = `span-${created}`;
    const rootSvcIdx = batch % serviceCount;
    const rootSvc = `service-${rootSvcIdx}`;
    const baseTime = batch * 1000;
    spansPerService[rootSvc].push(
      span(rootId, undefined, baseTime, baseTime + 900, {
        name: `GET /api/v1/resource-${batch % 8}`,
        kind: SpanKind.Server,
      }),
    );
    created++;
    if (created >= totalSpans) break;

    // Cross-service synchronous CLIENT -> SERVER call pair
    const calleeSvcIdx = (rootSvcIdx + 1) % serviceCount;
    const calleeSvc = `service-${calleeSvcIdx}`;
    const clientSpanId = `span-${created}`;
    spansPerService[rootSvc].push(
      span(clientSpanId, rootId, baseTime + 10, baseTime + 600, {
        name: `RPC CallService-${calleeSvcIdx}`,
        kind: SpanKind.Client,
      }),
    );
    created++;
    if (created >= totalSpans) break;

    const serverSpanId = `span-${created}`;
    spansPerService[calleeSvc].push(
      span(serverSpanId, clientSpanId, baseTime + 15, baseTime + 590, {
        name: `HandleService-${calleeSvcIdx}`,
        kind: SpanKind.Server,
      }),
    );
    created++;
    if (created >= totalSpans) break;

    // Repeated N+1 leaf DB CLIENT queries under serverSpanId (triggers repeat loop folding)
    const loopLen = Math.min(5, totalSpans - created);
    for (let q = 0; q < loopLen; q++) {
      const dbSpanId = `span-${created}`;
      const qStart = baseTime + 30 + q * 25;
      spansPerService[calleeSvc].push(
        span(dbSpanId, serverSpanId, qStart, qStart + 20, {
          name: 'SELECT * FROM orders WHERE user_id = $1',
          kind: SpanKind.Client,
          status: q === loopLen - 1 && batch % 7 === 0 ? { code: 2, message: 'timeout' } : { code: 1 },
          attributes: [kv('db.system', 'postgresql'), kv('db.name', 'orders_db')],
        }),
      );
      created++;
    }
    if (created >= totalSpans) break;

    // Cross-service asynchronous PRODUCER -> CONSUMER pair
    const asyncSvcIdx = (rootSvcIdx + 2) % serviceCount;
    const asyncSvc = `service-${asyncSvcIdx}`;
    const prodSpanId = `span-${created}`;
    spansPerService[calleeSvc].push(
      span(prodSpanId, serverSpanId, baseTime + 300, baseTime + 315, {
        name: 'publish order.created',
        kind: SpanKind.Producer,
      }),
    );
    created++;
    if (created >= totalSpans) break;

    const consSpanId = `span-${created}`;
    spansPerService[asyncSvc].push(
      span(consSpanId, prodSpanId, baseTime + 320, baseTime + 550, {
        name: 'consume order.created',
        kind: SpanKind.Consumer,
      }),
    );
    created++;
    if (created >= totalSpans) break;

    // Internal helper span inside the consumer
    const internalSpanId = `span-${created}`;
    spansPerService[asyncSvc].push(
      span(internalSpanId, consSpanId, baseTime + 340, baseTime + 420, {
        name: 'validatePayload',
        kind: SpanKind.Internal,
      }),
    );
    created++;
    batch++;
  }

  const traceInput = Object.entries(spansPerService).map(([svc, spans]) => [svc, spans] as const);
  return buildSpanIndex(trace(...traceInput));
}

test('performance: 10,000-span multi-service trace builds sequence model, projects steps, and builds frame plan within budget', () => {
  const index = buildSyntheticSequenceTrace(10_000, 12);
  assert.equal(index.table.length, 10_000);

  // Warmup
  const warmModel = buildSequenceModel(index);
  const warmSteps = projectSteps(warmModel);
  const warmLayout = computeSequenceLayout({
    viewWidth: 1280,
    viewHeight: 720,
    columnCount: warmModel.participants.count,
    rowCount: warmSteps.count,
  });
  const plan = new SequencePlan();
  buildSequencePlan(plan, {
    steps: warmSteps,
    layout: warmLayout,
    scrollTop: 0,
    scrollLeft: 0,
    selection: EMPTY_SPAN_SET,
    hover: null,
  });

  // Measure buildSequenceModel
  const modelIterations = 10;
  const modelStart = performance.now();
  let model = warmModel;
  for (let i = 0; i < modelIterations; i++) {
    model = buildSequenceModel(index);
  }
  const modelElapsed = (performance.now() - modelStart) / modelIterations;

  // Measure projectSteps
  const stepsIterations = 10;
  const stepsStart = performance.now();
  let steps = warmSteps;
  for (let i = 0; i < stepsIterations; i++) {
    steps = projectSteps(model, null, null, null, {
      internal: 'hide',
      returns: 'all',
      foldMin: 3,
    });
  }
  const stepsElapsed = (performance.now() - stepsStart) / stepsIterations;

  const layout = computeSequenceLayout({
    viewWidth: 1280,
    viewHeight: 720,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });

  // Measure buildSequencePlan across viewport scroll positions
  const planIterations = 50;
  const planStart = performance.now();
  for (let i = 0; i < planIterations; i++) {
    const scrollTop = (i * 240) % Math.max(1, layout.bodyHeight - layout.viewHeight);
    buildSequencePlan(plan, {
      steps,
      layout,
      scrollTop,
      scrollLeft: 0,
      selection: EMPTY_SPAN_SET,
      hover: null,
    });
  }
  const planElapsed = (performance.now() - planStart) / planIterations;

  console.log(
    `[PERF 10k spans / 12 services sequence] Model: ${modelElapsed.toFixed(2)}ms | Steps: ${stepsElapsed.toFixed(2)}ms | Plan: ${planElapsed.toFixed(3)}ms`,
  );

  // Structural assertions
  assert.ok(model.participants.count >= 14, 'Should include Gate, 12 services, and inferred DB peer');
  assert.ok(steps.count > 0, 'Should project non-empty steps');
  assert.ok(steps.act.count > 0, 'Should project non-empty activations');
  let hasFold = false;
  for (let s = 0; s < steps.count; s++) {
    if (steps.kind[s] === StepKind.Fold) {
      hasFold = true;
      break;
    }
  }
  assert.ok(hasFold, 'Should fold repeated N+1 DB queries into StepKind.Fold');
  assert.ok(plan.stepCount > 0 && plan.stepCount <= 50, `Expected visible plan.stepCount in 1..50, got ${plan.stepCount}`);

  // Generous CI timing budgets
  assert.ok(modelElapsed < 250, `10k buildSequenceModel took ${modelElapsed.toFixed(2)}ms, expected < 250ms`);
  assert.ok(stepsElapsed < 250, `10k projectSteps took ${stepsElapsed.toFixed(2)}ms, expected < 250ms`);
  assert.ok(planElapsed < 50, `10k buildSequencePlan took ${planElapsed.toFixed(3)}ms, expected < 50ms`);
});

test('performance: 50,000-span multi-service trace builds sequence model, projects steps, and builds frame plan within budget', () => {
  const index = buildSyntheticSequenceTrace(50_000, 20);
  assert.equal(index.table.length, 50_000);

  // Warmup
  const warmModel = buildSequenceModel(index);
  const warmSteps = projectSteps(warmModel);
  const warmLayout = computeSequenceLayout({
    viewWidth: 1280,
    viewHeight: 720,
    columnCount: warmModel.participants.count,
    rowCount: warmSteps.count,
  });
  const plan = new SequencePlan();
  buildSequencePlan(plan, {
    steps: warmSteps,
    layout: warmLayout,
    scrollTop: 0,
    scrollLeft: 0,
    selection: EMPTY_SPAN_SET,
    hover: null,
  });

  // Measure buildSequenceModel
  const modelIterations = 5;
  const modelStart = performance.now();
  let model = warmModel;
  for (let i = 0; i < modelIterations; i++) {
    model = buildSequenceModel(index);
  }
  const modelElapsed = (performance.now() - modelStart) / modelIterations;

  // Measure projectSteps
  const stepsIterations = 5;
  const stepsStart = performance.now();
  let steps = warmSteps;
  for (let i = 0; i < stepsIterations; i++) {
    steps = projectSteps(model, null, null, null, {
      internal: 'hide',
      returns: 'all',
      foldMin: 3,
    });
  }
  const stepsElapsed = (performance.now() - stepsStart) / stepsIterations;

  const layout = computeSequenceLayout({
    viewWidth: 1280,
    viewHeight: 720,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });

  // Measure buildSequencePlan across viewport scroll positions
  const planIterations = 25;
  const planStart = performance.now();
  for (let i = 0; i < planIterations; i++) {
    const scrollTop = (i * 1000) % Math.max(1, layout.bodyHeight - layout.viewHeight);
    buildSequencePlan(plan, {
      steps,
      layout,
      scrollTop,
      scrollLeft: 0,
      selection: EMPTY_SPAN_SET,
      hover: null,
    });
  }
  const planElapsed = (performance.now() - planStart) / planIterations;

  console.log(
    `[PERF 50k spans / 20 services sequence] Model: ${modelElapsed.toFixed(2)}ms | Steps: ${stepsElapsed.toFixed(2)}ms | Plan: ${planElapsed.toFixed(3)}ms`,
  );

  // Structural assertions
  assert.ok(model.participants.count >= 22, 'Should include Gate, 20 services, and inferred DB peer');
  assert.ok(steps.count > 0, 'Should project non-empty steps');
  assert.ok(steps.act.count > 0, 'Should project non-empty activations');
  assert.ok(plan.stepCount > 0 && plan.stepCount <= 50, `Expected visible plan.stepCount in 1..50, got ${plan.stepCount}`);
  assert.ok(plan.actCount > 0, 'Should include visible activations');

  // Generous CI timing budgets (< 500ms for 50k spans)
  assert.ok(modelElapsed < 500, `50k buildSequenceModel took ${modelElapsed.toFixed(2)}ms, expected < 500ms`);
  assert.ok(stepsElapsed < 500, `50k projectSteps took ${stepsElapsed.toFixed(2)}ms, expected < 500ms`);
  assert.ok(planElapsed < 50, `50k buildSequencePlan took ${planElapsed.toFixed(3)}ms, expected < 50ms`);
});

test('scale: 10,000-deep recursive/nested chain across services projects and builds a frame plan without stack overflow', () => {
  const depth = 10_000;
  const serviceCount = 4;
  const spansPerService: Record<string, ReturnType<typeof span>[]> = {};
  for (let s = 0; s < serviceCount; s++) {
    spansPerService[`deep-svc-${s}`] = [];
  }

  for (let i = 0; i < depth; i++) {
    const parentId = i === 0 ? undefined : `deep-${i - 1}`;
    const svcName = `deep-svc-${i % serviceCount}`;
    const start = i * 2;
    const end = depth * 4 - i * 2;
    spansPerService[svcName].push(
      span(`deep-${i}`, parentId, start, end, {
        name: `hop-${i}`,
        kind: SpanKind.Server,
      }),
    );
  }

  const traceInput = Object.entries(spansPerService).map(([svc, spans]) => [svc, spans] as const);
  const index = buildSpanIndex(trace(...traceInput));
  assert.equal(index.table.length, depth);

  const start = performance.now();
  const model = buildSequenceModel(index);
  const steps = projectSteps(model, null, null, null, {
    internal: 'show',
    returns: 'all',
    foldMin: 3,
  });
  const layout = computeSequenceLayout({
    viewWidth: 1280,
    viewHeight: 720,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });
  const plan = new SequencePlan();
  buildSequencePlan(plan, {
    steps,
    layout,
    scrollTop: Math.floor(layout.bodyHeight / 2),
    scrollLeft: 0,
    selection: EMPTY_SPAN_SET,
    hover: null,
  });
  const elapsed = performance.now() - start;

  console.log(`[PERF 10k-deep chain sequence] Total (Model + Steps + Plan): ${elapsed.toFixed(2)}ms`);

  // Every cross-service Server hop produces 1 Call (or Found) + 1 Return = 20,000 steps and 10,000 activations
  assert.equal(steps.count, depth * 2);
  assert.equal(steps.act.count, depth);
  assert.equal(steps.depth[depth - 1], depth);
  assert.ok(plan.stepCount > 0 && plan.stepCount <= 50, `Expected visible plan.stepCount in 1..50, got ${plan.stepCount}`);
  assert.ok(elapsed < 500, `10k-deep chain took ${elapsed.toFixed(2)}ms, expected < 500ms`);
});

test('performance: sequenceModel selector memoization is instantaneous on unchanged state', () => {
  const index = buildSpanIndex(trace(['s1', [span('root', undefined, 0, 100)]]));
  const store = createTraceStore();
  store.setData(index);

  const first = store.derive(sequenceModel);

  const start = performance.now();
  const runs = 10_000;
  for (let i = 0; i < runs; i++) {
    const cached = store.derive(sequenceModel);
    assert.equal(cached, first);
  }
  const totalElapsed = performance.now() - start;
  const perLookupMicros = (totalElapsed / runs) * 1000;

  console.log(
    `[PERF sequenceModel selector cache] 10,000 lookups took ${totalElapsed.toFixed(2)}ms (${perLookupMicros.toFixed(2)}µs / lookup)`,
  );
  assert.ok(totalElapsed < 25, `10,000 cached lookups took ${totalElapsed.toFixed(2)}ms, expected < 25ms`);
});
