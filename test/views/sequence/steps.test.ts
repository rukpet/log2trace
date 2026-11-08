import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanMask, buildSpanIndex, createTraceStore } from '../../../src/core.ts';
import { buildSequenceModel } from '../../../src/views/sequence/model/messages.ts';
import { GATE_NAME } from '../../../src/views/sequence/model/participants.ts';
import { StepFlag, StepKind, projectSteps } from '../../../src/views/sequence/model/steps.ts';
import { kv, span, trace } from '../../support/trace-builder.ts';

test('empty trace projects zero steps and zero activations', () => {
  const emptyIndex = createTraceStore().state.data.index;
  const model = buildSequenceModel(emptyIndex);
  const steps = projectSteps(model);

  assert.equal(steps.count, 0);
  assert.equal(steps.act.count, 0);
  assert.equal(steps.stepOfRow.length, 0);
  assert.deepEqual([...steps.foldRowOff], [0]);
});

test('synchronous call & return ordering: Gate -> A -> B produces Found, Call, Return, Return with paired indices', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-srv', undefined, 0, 100, { name: 'GET /orders', kind: SpanKind.Server }),
          span('a-cli', 'a-srv', 10, 80, { name: 'RPC GetUser', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [span('b-srv', 'a-cli', 15, 75, { name: 'GetUser', kind: SpanKind.Server })],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model);

  const pGate = model.participants.names.indexOf(GATE_NAME);
  const pA = model.participants.names.indexOf('svc-a');
  const pB = model.participants.names.indexOf('svc-b');
  const rowA = index.spans.get('a-srv')?.idx ?? -1;
  const rowCli = index.spans.get('a-cli')?.idx ?? -1;
  const rowB = index.spans.get('b-srv')?.idx ?? -1;

  assert.equal(steps.count, 4);

  // Step 0: Found(Gate -> A)
  assert.equal(steps.kind[0], StepKind.Found);
  assert.equal(steps.from[0], pGate);
  assert.equal(steps.to[0], pA);
  assert.equal(steps.row[0], rowA);
  assert.equal(steps.time[0], 0);
  assert.equal(steps.depth[0], 1);

  // Step 1: Call(A -> B)
  assert.equal(steps.kind[1], StepKind.Call);
  assert.equal(steps.from[1], pA);
  assert.equal(steps.to[1], pB);
  assert.equal(steps.row[1], rowB);
  assert.equal(steps.via[1], rowCli);
  assert.equal(steps.time[1], 15);
  assert.equal(steps.depth[1], 2);

  // Step 2: Return(B -> A)
  assert.equal(steps.kind[2], StepKind.Return);
  assert.equal(steps.from[2], pB);
  assert.equal(steps.to[2], pA);
  assert.equal(steps.row[2], rowB);
  assert.equal(steps.via[2], rowCli);
  assert.equal(steps.time[2], 75);
  assert.equal(steps.depth[2], 2);

  // Step 3: Return(A -> Gate)
  assert.equal(steps.kind[3], StepKind.Return);
  assert.equal(steps.from[3], pA);
  assert.equal(steps.to[3], pGate);
  assert.equal(steps.row[3], rowA);
  assert.equal(steps.time[3], 100);
  assert.equal(steps.depth[3], 1);

  // Pair links between calls and returns
  assert.equal(steps.pair[0], 3);
  assert.equal(steps.pair[3], 0);
  assert.equal(steps.pair[1], 2);
  assert.equal(steps.pair[2], 1);

  // stepOfRow maps both b-srv and its via (a-cli) to step 1
  assert.equal(steps.stepOfRow[rowA], 0);
  assert.equal(steps.stepOfRow[rowCli], 1);
  assert.equal(steps.stepOfRow[rowB], 1);

  // Activations
  assert.equal(steps.act.count, 2);
  assert.equal(steps.act.part[0], pA);
  assert.equal(steps.act.startStep[0], 0);
  assert.equal(steps.act.endStep[0], 3);
  assert.equal(steps.act.part[1], pB);
  assert.equal(steps.act.startStep[1], 1);
  assert.equal(steps.act.endStep[1], 2);
  assert.deepEqual([...steps.act.innermostAtStep], [0, 1, 1, 0]);
});

test('recursive call A -> B -> A assigns nest = 0 on outer A, nest = 0 on B, and nest = 1 on re-entrant A', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-outer', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
          span('a-to-b', 'a-outer', 10, 90, { name: 'call-b', kind: SpanKind.Client }),
          span('a-inner', 'b-to-a', 25, 70, { name: 'callback', kind: SpanKind.Server }),
        ],
      ],
      [
        'svc-b',
        [
          span('b-srv', 'a-to-b', 15, 85, { name: 'handle-b', kind: SpanKind.Server }),
          span('b-to-a', 'b-srv', 20, 75, { name: 'call-a', kind: SpanKind.Client }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model);

  const pA = model.participants.names.indexOf('svc-a');
  const pB = model.participants.names.indexOf('svc-b');

  assert.equal(steps.act.count, 3);
  // Activation 0: outer A
  assert.equal(steps.act.part[0], pA);
  assert.equal(steps.act.nest[0], 0);
  assert.equal(steps.act.parent[0], -1);

  // Activation 1: B
  assert.equal(steps.act.part[1], pB);
  assert.equal(steps.act.nest[1], 0);
  assert.equal(steps.act.parent[1], 0);

  // Activation 2: re-entrant A
  assert.equal(steps.act.part[2], pA);
  assert.equal(steps.act.nest[2], 1);
  assert.equal(steps.act.parent[2], 1);
});

test('internal = "hide" vs "show" vs "auto" handles internal spans and stepOfRow mapping', () => {
  // Multi-participant trace (svc-a + svc-b) with an internal span inside svc-a
  const multiIndex = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-root', undefined, 0, 100, { name: 'GET /items', kind: SpanKind.Server }),
          span('a-internal', 'a-root', 10, 30, { name: 'parse-query', kind: SpanKind.Internal }),
          span('a-cli', 'a-root', 40, 80, { name: 'fetch-b', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [span('b-srv', 'a-cli', 45, 75, { name: 'get-item', kind: SpanKind.Server })],
      ],
    ),
  );

  const multiModel = buildSequenceModel(multiIndex);
  assert.equal(multiModel.singleParticipant, false);

  const rowRoot = multiIndex.spans.get('a-root')?.idx ?? -1;
  const rowInternal = multiIndex.spans.get('a-internal')?.idx ?? -1;

  // 1. internal = 'hide' hides internal span and maps stepOfRow[rowInternal] to enclosing a-root step (0)
  const hiddenSteps = projectSteps(multiModel, null, null, null, { internal: 'hide' });
  assert.equal(hiddenSteps.count, 4); // Found(Gate->A), Call(A->B), Return(B->A), Return(A->Gate)
  assert.equal(hiddenSteps.stepOfRow[rowRoot], 0);
  assert.equal(hiddenSteps.stepOfRow[rowInternal], 0);

  // 2. internal = 'auto' on multi-participant trace also hides internal spans
  const autoMultiSteps = projectSteps(multiModel, null, null, null, { internal: 'auto' });
  assert.equal(autoMultiSteps.count, 4);
  assert.equal(autoMultiSteps.stepOfRow[rowInternal], 0);

  // 3. internal = 'show' emits StepKind.SelfCall with nest = 1 and no return arrow for SelfCall
  const shownSteps = projectSteps(multiModel, null, null, null, { internal: 'show' });
  assert.equal(shownSteps.count, 5); // Found(Gate->A), SelfCall(A->A), Call(A->B), Return(B->A), Return(A->Gate)
  assert.equal(shownSteps.kind[1], StepKind.SelfCall);
  assert.equal(shownSteps.row[1], rowInternal);
  assert.equal(shownSteps.stepOfRow[rowInternal], 1);
  const selfActIdx = shownSteps.actIndex[1];
  assert.equal(shownSteps.act.nest[selfActIdx], 1);
  assert.equal(shownSteps.act.parent[selfActIdx], 0);
  assert.equal(shownSteps.act.startStep[selfActIdx], 1);
  assert.equal(shownSteps.act.endStep[selfActIdx], 1);

  // 4. Single-participant trace: internal = 'auto' shows internal spans automatically
  const singleIndex = buildSpanIndex(
    trace([
      'solo-svc',
      [
        span('s-root', undefined, 0, 50, { name: 'handle', kind: SpanKind.Server }),
        span('s-int', 's-root', 10, 40, { name: 'compute', kind: SpanKind.Internal }),
      ],
    ]),
  );
  const singleModel = buildSequenceModel(singleIndex);
  assert.equal(singleModel.singleParticipant, true);

  const autoSingleSteps = projectSteps(singleModel, null, null, null, { internal: 'auto' });
  // Found(Gate->solo), SelfCall(solo->solo), Return(solo->Gate)
  assert.equal(autoSingleSteps.count, 3);
  assert.equal(autoSingleSteps.kind[1], StepKind.SelfCall);
});

test('returns mode: "errors" only emits Return for failing calls, "none" emits no Return steps', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
          span('gw-ok', 'gw-root', 10, 40, { name: 'call-ok', kind: SpanKind.Client }),
          span('gw-err', 'gw-root', 50, 90, { name: 'call-err', kind: SpanKind.Client }),
        ],
      ],
      [
        'backend',
        [
          span('be-ok', 'gw-ok', 15, 35, { name: 'ok-op', kind: SpanKind.Server, status: { code: 1 } }),
          span('be-err', 'gw-err', 55, 85, { name: 'err-op', kind: SpanKind.Server, status: { code: 2 } }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);

  // returns = 'errors': only `be-err` has status = 2, so only 1 Return step is emitted
  const errSteps = projectSteps(model, null, null, null, { returns: 'errors' });
  const returnSteps = [];
  for (let s = 0; s < errSteps.count; s++) {
    if (errSteps.kind[s] === StepKind.Return) returnSteps.push(s);
  }
  assert.equal(returnSteps.length, 1);
  const retIdx = returnSteps[0];
  assert.equal(errSteps.row[retIdx], index.spans.get('be-err')?.idx ?? -1);
  assert.ok((errSteps.flags[retIdx] & StepFlag.Error) !== 0);

  // returns = 'none': zero Return steps, and root activation endStep spans the entire subtree
  const noneSteps = projectSteps(model, null, null, null, { returns: 'none' });
  assert.equal(noneSteps.count, 3); // Found(gw-root), Call(be-ok), Call(be-err)
  for (let s = 0; s < noneSteps.count; s++) {
    assert.notEqual(noneSteps.kind[s], StepKind.Return);
  }
  assert.equal(noneSteps.act.startStep[0], 0);
  assert.equal(noneSteps.act.endStep[0], 2);
});

test('collapsed span skips descendant steps, sets act.collapsed and hiddenCount, and maps descendant stepOfRow', () => {
  const index = buildSpanIndex(
    trace(
      [
        'api',
        [
          span('api-root', undefined, 0, 100, { name: 'root', kind: SpanKind.Server }),
          span('api-c1', 'api-root', 10, 80, { name: 'call-svc', kind: SpanKind.Client }),
        ],
      ],
      [
        'orders',
        [
          span('ord-srv', 'api-c1', 15, 75, { name: 'process-order', kind: SpanKind.Server }),
          span('ord-db', 'ord-srv', 20, 60, {
            name: 'SELECT orders',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgres')],
          }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const ordRow = index.spans.get('ord-srv')?.idx ?? -1;
  const dbRow = index.spans.get('ord-db')?.idx ?? -1;

  const collapsed = SpanMask.of(index, ['ord-srv']);
  const steps = projectSteps(model, collapsed);

  // ord-db is hidden because ord-srv is collapsed
  // Steps: 0=Found(api-root), 1=Call(ord-srv), 2=Return(ord-srv), 3=Return(api-root)
  assert.equal(steps.count, 4);
  const ordAct = steps.actIndex[1];
  assert.equal(steps.act.collapsible[ordAct], 1);
  assert.equal(steps.act.collapsed[ordAct], 1);
  assert.equal(steps.act.hiddenCount[ordAct], 1);
  assert.equal(steps.stepOfRow[ordRow], 1);
  assert.equal(steps.stepOfRow[dbRow], 1);
});

test('repeat folding (foldMin = 3) folds 4 consecutive identical SELECT calls and expands via expandedFolds', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('api-root', undefined, 0, 100, { name: 'GET /list', kind: SpanKind.Server }),
        span('q1', 'api-root', 10, 15, {
          name: 'SELECT item',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'postgres')],
        }),
        span('q2', 'api-root', 20, 32, {
          name: 'SELECT item',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'postgres')],
          status: { code: 2 },
        }),
        span('q3', 'api-root', 35, 42, {
          name: 'SELECT item',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'postgres')],
        }),
        span('q4', 'api-root', 45, 53, {
          name: 'SELECT item',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'postgres')],
        }),
      ],
    ]),
  );

  const model = buildSequenceModel(index);
  const r1 = index.spans.get('q1')?.idx ?? -1;
  const r2 = index.spans.get('q2')?.idx ?? -1;
  const r3 = index.spans.get('q3')?.idx ?? -1;
  const r4 = index.spans.get('q4')?.idx ?? -1;

  const folded = projectSteps(model, null, null, null, { foldMin: 3 });
  // Steps: 0=Found(api-root), 1=Fold(q1..q4), 2=Return(api-root)
  assert.equal(folded.count, 3);
  assert.equal(folded.kind[1], StepKind.Fold);
  assert.equal(folded.foldCount[1], 4);
  assert.equal(folded.foldErrors[1], 1);
  assert.ok((folded.flags[1] & StepFlag.Error) !== 0);
  // Summed duration = 5 + 12 + 7 + 8 = 32, max single duration = 12
  assert.equal(folded.duration[1], 32);
  assert.equal(folded.foldMaxDuration[1], 12);

  const foldSlice = folded.foldRows.subarray(folded.foldRowOff[1], folded.foldRowOff[2]);
  assert.deepEqual([...foldSlice], [r1, r2, r3, r4]);
  assert.equal(folded.stepOfRow[r1], 1);
  assert.equal(folded.stepOfRow[r2], 1);
  assert.equal(folded.stepOfRow[r3], 1);
  assert.equal(folded.stepOfRow[r4], 1);

  // Expanding the fold restores all 4 calls (and their returns)
  const expanded = projectSteps(model, null, null, null, {
    foldMin: 3,
    expandedFolds: new Set([`fold:${r1}`]),
  });
  // Found + 4*(Call + Return) + Return = 10 steps
  assert.equal(expanded.count, 10);
  for (let s = 0; s < expanded.count; s++) {
    assert.notEqual(expanded.kind[s], StepKind.Fold);
  }
});

test('filter matched: default mode sets StepFlag.Context on non-matching steps; matchesOnly prunes unmatched subtrees', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
          span('gw-c1', 'gw-root', 10, 40, { name: 'call-auth', kind: SpanKind.Client }),
          span('gw-c2', 'gw-root', 50, 90, { name: 'call-billing', kind: SpanKind.Client }),
        ],
      ],
      [
        'auth',
        [span('auth-srv', 'gw-c1', 15, 35, { name: 'verify', kind: SpanKind.Server })],
      ],
      [
        'billing',
        [span('bill-srv', 'gw-c2', 55, 85, { name: 'charge', kind: SpanKind.Server })],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const matched = SpanMask.of(index, ['bill-srv']);

  // Default mode (matchesOnly = false): all steps kept, non-matching marked with StepFlag.Context
  const allSteps = projectSteps(model, null, matched, null, { matchesOnly: false });
  assert.equal(allSteps.count, 6);
  // Step 0: gw-root (Context)
  assert.ok((allSteps.flags[0] & StepFlag.Context) !== 0);
  // Step 1: auth-srv (Context)
  assert.ok((allSteps.flags[1] & StepFlag.Context) !== 0);
  // Step 3: bill-srv (Matched -> NO Context flag)
  assert.equal(allSteps.flags[3] & StepFlag.Context, 0);

  // matchesOnly = true: auth subtree is pruned, gw-root kept as ancestor context, bill-srv kept as match
  const prunedSteps = projectSteps(model, null, matched, null, { matchesOnly: true });
  assert.equal(prunedSteps.count, 4); // Found(gw-root), Call(bill-srv), Return(bill-srv), Return(gw-root)
  assert.ok((prunedSteps.flags[0] & StepFlag.Context) !== 0);
  assert.equal(prunedSteps.flags[1] & StepFlag.Context, 0);
});

test('time window: out-of-window consecutive sibling runs coalesce into StepKind.Elided with foldCount', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('root', undefined, 0, 100, { name: 'root', kind: SpanKind.Server }),
        span('early-1', 'root', 5, 10, {
          name: 'q1',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
        span('early-2', 'root', 12, 18, {
          name: 'q2',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
        span('in-win', 'root', 50, 70, {
          name: 'q3',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
      ],
    ]),
  );

  const model = buildSequenceModel(index);
  const rEarly1 = index.spans.get('early-1')?.idx ?? -1;
  const rEarly2 = index.spans.get('early-2')?.idx ?? -1;

  // Window [40, 80] excludes early-1 and early-2, includes root (0..100) and in-win (50..70)
  const steps = projectSteps(model, null, null, { t0: 40, t1: 80 });

  // Steps: 0=Found(root), 1=Elided(early-1..early-2), 2=Call(in-win), 3=Return(in-win), 4=Return(root)
  assert.equal(steps.count, 5);
  assert.equal(steps.kind[1], StepKind.Elided);
  assert.equal(steps.foldCount[1], 2);
  assert.equal(steps.row[1], rEarly1);
  assert.equal(steps.duration[1], 18 - 5);
  assert.equal(steps.stepOfRow[rEarly1], 1);
  assert.equal(steps.stepOfRow[rEarly2], 1);
});

test('gap detection and backwards timestamp flags (StepFlag.Gap, StepFlag.Backwards)', () => {
  // Construct a trace where one sibling starts after a large idle gap, and another starts earlier than the previous return
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('root', undefined, 0, 1000, { name: 'root', kind: SpanKind.Server }),
        span('c1', 'root', 1, 20, {
          name: 'op1',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
        // Starts at t=5 while c1 ends at t=20 -> Return(c1) is at t=20, then Call(c2) is at t=5 (backwards!)
        span('c2', 'root', 5, 10, {
          name: 'op2',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
        // Starts at t=900 after a huge idle gap (890ms gap)
        span('c3', 'root', 900, 905, {
          name: 'op3',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
      ],
    ]),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model, null, null, null, { foldMin: 0 });

  // Step 0: Found(root) @ t=0
  // Step 1: Call(c1) @ t=1
  // Step 2: Return(c1) @ t=20
  // Step 3: Call(c2) @ t=5 -> Backwards relative to t=20!
  // Step 4: Return(c2) @ t=10
  // Step 5: Call(c3) @ t=900 -> Gap relative to t=10!
  assert.ok((steps.flags[3] & StepFlag.Backwards) !== 0);
  assert.ok((steps.flags[5] & StepFlag.Gap) !== 0);
  assert.equal(steps.gapMs[5], 890);
});

test('deep chain of 50,000 nested spans completes projectSteps without stack overflow', () => {
  const count = 50_000;
  const spansA = [];
  const spansB = [];
  for (let i = 0; i < count; i++) {
    const id = `s-${i}`;
    const parentId = i === 0 ? undefined : `s-${i - 1}`;
    const sp = span(id, parentId, i, count * 2 - i, {
      name: 'step',
      kind: SpanKind.Server,
    });
    if ((i & 1) === 0) {
      spansA.push(sp);
    } else {
      spansB.push(sp);
    }
  }

  const index = buildSpanIndex(trace(['svc-a', spansA], ['svc-b', spansB]));
  const model = buildSequenceModel(index);
  const steps = projectSteps(model);

  // Every span emits a Call (or Found) and a Return -> 100,000 steps and 50,000 activations
  assert.equal(steps.count, count * 2);
  assert.equal(steps.act.count, count);
  assert.equal(steps.depth[count - 1], count);
});
