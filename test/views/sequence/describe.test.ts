import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex, type SpanIndex } from '../../../src/core.ts';
import {
  GATE_NAME,
  ParticipantKind,
  buildParticipants,
} from '../../../src/views/sequence/model/participants.ts';
import { MsgKind, type SequenceModel } from '../../../src/views/sequence/model/messages.ts';
import {
  StepFlag,
  StepKind,
  type Activations,
  type SequenceSteps,
} from '../../../src/views/sequence/model/steps.ts';
import {
  describeActivation,
  describeParticipant,
  describeStep,
  spansOfActivation,
  spansOfParticipant,
  spansOfStep,
} from '../../../src/views/sequence/model/describe.ts';
import { kv, span, trace } from '../../support/trace-builder.ts';

function makeModel(
  index: SpanIndex,
  overrides: Partial<
    Pick<SequenceModel, 'msgKind' | 'from' | 'to' | 'via' | 'orphan' | 'skew' | 'parallel'>
  > = {},
): SequenceModel {
  const participants = buildParticipants(index);
  const n = index.table.length;
  return {
    index,
    participants,
    msgKind: overrides.msgKind ?? new Uint8Array(n),
    from: overrides.from ?? new Int32Array(n).fill(-1),
    to: overrides.to ?? new Int32Array(n).fill(-1),
    via: overrides.via ?? new Int32Array(n).fill(-1),
    orphan: overrides.orphan ?? new Uint8Array(n),
    skew: overrides.skew ?? new Uint8Array(n),
    parallel: overrides.parallel ?? new Uint8Array(n),
    singleParticipant: participants.count <= 1,
  };
}

interface StepSpec {
  readonly kind: StepKind;
  readonly flags?: number;
  readonly row: number;
  readonly via?: number;
  readonly from: number;
  readonly to: number;
  readonly time?: number;
  readonly duration?: number;
  readonly depth?: number;
  readonly pair?: number;
  readonly actIndex?: number;
  readonly foldCount?: number;
  readonly foldErrors?: number;
  readonly foldMaxDuration?: number;
  readonly foldRows?: readonly number[];
  readonly gapMs?: number;
}

interface ActSpec {
  readonly part: number;
  readonly row: number;
  readonly startStep?: number;
  readonly endStep?: number;
  readonly nest?: number;
  readonly parent?: number;
  readonly hiddenCount?: number;
  readonly collapsible?: number;
  readonly collapsed?: number;
}

function makeSteps(
  model: SequenceModel,
  stepSpecs: readonly StepSpec[],
  actSpecs: readonly ActSpec[] = [],
): SequenceSteps {
  const count = stepSpecs.length;
  const kind = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const row = new Int32Array(count);
  const via = new Int32Array(count);
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const time = new Float64Array(count);
  const duration = new Float64Array(count);
  const depth = new Int32Array(count);
  const pair = new Int32Array(count);
  const actIndex = new Int32Array(count);
  const foldCount = new Int32Array(count);
  const foldErrors = new Int32Array(count);
  const foldMaxDuration = new Float64Array(count);
  const foldRowOff = new Int32Array(count + 1);
  const foldRowsList: number[] = [];
  const gapMs = new Float64Array(count);
  const stepOfRow = new Int32Array(model.index.table.length).fill(-1);

  for (let s = 0; s < count; s++) {
    const spec = stepSpecs[s];
    kind[s] = spec.kind;
    flags[s] = spec.flags ?? StepFlag.None;
    row[s] = spec.row;
    via[s] = spec.via ?? -1;
    from[s] = spec.from;
    to[s] = spec.to;
    time[s] = spec.time ?? 0;
    duration[s] = spec.duration ?? 0;
    depth[s] = spec.depth ?? 1;
    pair[s] = spec.pair ?? -1;
    actIndex[s] = spec.actIndex ?? -1;
    foldCount[s] = spec.foldCount ?? 0;
    foldErrors[s] = spec.foldErrors ?? 0;
    foldMaxDuration[s] = spec.foldMaxDuration ?? 0;
    gapMs[s] = spec.gapMs ?? 0;

    foldRowOff[s] = foldRowsList.length;
    if (spec.foldRows) {
      for (const fr of spec.foldRows) {
        foldRowsList.push(fr);
      }
    }
    if (spec.row >= 0 && spec.row < stepOfRow.length && stepOfRow[spec.row] < 0) {
      stepOfRow[spec.row] = s;
    }
  }
  foldRowOff[count] = foldRowsList.length;

  const actCount = actSpecs.length;
  const act: Activations = {
    count: actCount,
    part: new Int32Array(actSpecs.map((a) => a.part)),
    row: new Int32Array(actSpecs.map((a) => a.row)),
    startStep: new Int32Array(actSpecs.map((a) => a.startStep ?? 0)),
    endStep: new Int32Array(actSpecs.map((a) => a.endStep ?? 0)),
    nest: new Uint8Array(actSpecs.map((a) => a.nest ?? 0)),
    parent: new Int32Array(actSpecs.map((a) => a.parent ?? -1)),
    hiddenCount: new Int32Array(actSpecs.map((a) => a.hiddenCount ?? 0)),
    collapsible: new Uint8Array(actSpecs.map((a) => a.collapsible ?? 0)),
    collapsed: new Uint8Array(actSpecs.map((a) => a.collapsed ?? 0)),
    innermostAtStep: new Int32Array(count).fill(-1),
  };

  return {
    model,
    count,
    kind,
    flags,
    row,
    via,
    from,
    to,
    time,
    duration,
    depth,
    pair,
    actIndex,
    foldCount,
    foldErrors,
    foldMaxDuration,
    foldRowOff,
    foldRows: new Int32Array(foldRowsList),
    gapMs,
    stepOfRow,
    act,
  };
}

test('spansOfStep handles normal steps, via spans, Fold steps, Elided steps, and out-of-bounds', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'GET /orders', kind: SpanKind.Server }),
          span('gw-client-1', 'gw-root', 10, 40, { name: 'RPC item 1', kind: SpanKind.Client }),
          span('gw-client-2', 'gw-root', 45, 90, { name: 'RPC item 2', kind: SpanKind.Client }),
        ],
      ],
      [
        'catalog',
        [
          span('cat-srv-1', 'gw-client-1', 12, 38, {
            name: 'FetchItem',
            kind: SpanKind.Server,
          }),
          span('cat-srv-2', 'gw-client-2', 47, 88, {
            name: 'FetchItem',
            kind: SpanKind.Server,
            status: { code: 2, message: 'DB timeout' },
          }),
        ],
      ],
    ),
  );

  // Ordered rows:
  // 0: gw-root
  // 1: gw-client-1
  // 2: cat-srv-1 (duration 26ms, status ok)
  // 3: gw-client-2
  // 4: cat-srv-2 (duration 41ms, status error)
  const via = new Int32Array([-1, -1, 1, -1, 3]);
  const model = makeModel(index, { via });

  const steps = makeSteps(model, [
    // step 0: Found (row 0, no via)
    { kind: StepKind.Found, row: 0, from: 0, to: 1 },
    // step 1: Call (row 2, via 1)
    { kind: StepKind.Call, row: 2, via: 1, from: 1, to: 2 },
    // step 2: Fold with error in second folded row (rows [2, 4])
    {
      kind: StepKind.Fold,
      row: 2,
      via: 1,
      from: 1,
      to: 2,
      foldCount: 2,
      foldErrors: 1,
      foldRows: [2, 4],
    },
    // step 3: Elided (row 4)
    { kind: StepKind.Elided, row: 4, from: 0, to: 0, foldCount: 5 },
  ]);

  assert.deepEqual(spansOfStep(steps, -1), { ids: [], primary: null, key: '' });
  assert.deepEqual(spansOfStep(steps, 99), { ids: [], primary: null, key: '' });

  // Step 0: Found without via
  assert.deepEqual(spansOfStep(steps, 0), {
    ids: ['gw-root'],
    primary: 'gw-root',
    key: 'msg:0',
  });

  // Step 1: Call with via
  assert.deepEqual(spansOfStep(steps, 1), {
    ids: ['cat-srv-1', 'gw-client-1'],
    primary: 'cat-srv-1',
    key: 'msg:2',
  });

  // Step 2: Fold includes both folded callee rows and their via client rows; primary is the failing row
  assert.deepEqual(spansOfStep(steps, 2), {
    ids: ['cat-srv-1', 'gw-client-1', 'cat-srv-2', 'gw-client-2'],
    primary: 'cat-srv-2',
    key: 'fold:2',
  });

  // Step 3: Elided returns empty ids and null primary
  assert.deepEqual(spansOfStep(steps, 3), {
    ids: [],
    primary: null,
    key: 'elided:4',
  });
});

test('spansOfStep Fold picks longest-duration row when no folded row has an error', () => {
  const index = buildSpanIndex(
    trace([
      'svc',
      [
        span('r0', undefined, 0, 100, { name: 'root' }),
        span('c1', 'r0', 5, 15, { name: 'work' }), // 10ms
        span('c2', 'r0', 20, 65, { name: 'work' }), // 45ms (longest)
        span('c3', 'r0', 70, 85, { name: 'work' }), // 15ms
      ],
    ]),
  );

  const model = makeModel(index);
  const steps = makeSteps(model, [
    {
      kind: StepKind.Fold,
      row: 1,
      from: 0,
      to: 0,
      foldCount: 3,
      foldRows: [1, 2, 3],
    },
  ]);

  assert.deepEqual(spansOfStep(steps, 0), {
    ids: ['c1', 'c2', 'c3'],
    primary: 'c2',
    key: 'fold:1',
  });
});

test('spansOfActivation returns activation row and optional via span', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { kind: SpanKind.Server }),
          span('gw-cli', 'gw-root', 10, 50, { kind: SpanKind.Client }),
        ],
      ],
      ['auth', [span('auth-srv', 'gw-cli', 12, 48, { kind: SpanKind.Server })]],
    ),
  );

  // rows: 0 = gw-root, 1 = gw-cli, 2 = auth-srv
  const via = new Int32Array([-1, -1, 1]);
  const model = makeModel(index, { via });
  const steps = makeSteps(
    model,
    [],
    [
      { part: 1, row: 0 },
      { part: 2, row: 2 },
    ],
  );

  assert.deepEqual(spansOfActivation(steps, -1), { ids: [], primary: null, key: '' });
  assert.deepEqual(spansOfActivation(steps, 5), { ids: [], primary: null, key: '' });

  assert.deepEqual(spansOfActivation(steps, 0), {
    ids: ['gw-root'],
    primary: 'gw-root',
    key: 'act:0',
  });

  assert.deepEqual(spansOfActivation(steps, 1), {
    ids: ['auth-srv', 'gw-cli'],
    primary: 'auth-srv',
    key: 'act:2',
  });
});

test('spansOfParticipant resolves Gate roots, Service entry/failing/longest priority, and Inferred peers', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-1', undefined, 0, 40, { kind: SpanKind.Server }),
          span('gw-2', undefined, 50, 150, { kind: SpanKind.Server }),
        ],
      ],
      [
        'orders',
        [
          // Entry 1 (ok, 80ms)
          span('ord-entry-1', 'gw-1', 5, 85, { kind: SpanKind.Server }),
          // Internal child of ord-entry-1 that fails (status=2)
          span('ord-int-err', 'ord-entry-1', 10, 20, {
            kind: SpanKind.Internal,
            status: { code: 2 },
          }),
          // Leaf client call to inferred redis peer
          span('ord-redis-cli', 'ord-entry-1', 25, 35, {
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'redis')],
          }),
        ],
      ],
    ),
  );

  const model = makeModel(index);
  const { participants } = model;

  assert.equal(participants.names[0], GATE_NAME);
  const gwIdx = participants.names.indexOf('gateway');
  const ordIdx = participants.names.indexOf('orders');
  const redisIdx = participants.names.indexOf('redis');

  // Gate participant: includes root server spans gw-1 and gw-2, picks longest (gw-2)
  const gateSpans = spansOfParticipant(model, 0);
  assert.deepEqual(gateSpans, {
    ids: ['gw-1', 'gw-2'],
    primary: 'gw-2',
    key: 'p:0',
  });

  // Gateway participant: no failing spans, picks longest (gw-2)
  const gwSpans = spansOfParticipant(model, gwIdx);
  assert.deepEqual(gwSpans, {
    ids: ['gw-1', 'gw-2'],
    primary: 'gw-2',
    key: `p:${gwIdx}`,
  });

  // Orders participant: ord-entry-1 is ok, ord-int-err is failing internal span -> picks ord-int-err
  const ordSpans = spansOfParticipant(model, ordIdx);
  assert.deepEqual(ordSpans, {
    ids: ['ord-entry-1', 'ord-int-err', 'ord-redis-cli'],
    primary: 'ord-int-err',
    key: `p:${ordIdx}`,
  });

  // Inferred peer participant (redis): includes leaf client span ord-redis-cli
  const redisSpans = spansOfParticipant(model, redisIdx);
  assert.deepEqual(redisSpans, {
    ids: ['ord-redis-cli'],
    primary: 'ord-redis-cli',
    key: `p:${redisIdx}`,
  });

  // Verify failing entry takes priority over earlier failing internal span
  const indexWithFailingEntry = buildSpanIndex(
    trace(
      ['gateway', [span('g', undefined, 0, 100, { kind: SpanKind.Server })]],
      [
        'orders',
        [
          span('entry-ok', 'g', 5, 40, { kind: SpanKind.Server }),
          span('internal-fail', 'entry-ok', 10, 20, {
            kind: SpanKind.Internal,
            status: { code: 2 },
          }),
          span('entry-fail', 'g', 50, 70, {
            kind: SpanKind.Server,
            status: { code: 2 },
          }),
        ],
      ],
    ),
  );
  const model2 = makeModel(indexWithFailingEntry);
  const ordIdx2 = model2.participants.names.indexOf('orders');
  const ordSpans2 = spansOfParticipant(model2, ordIdx2);
  assert.equal(ordSpans2.primary, 'entry-fail');
});

test('describeStep formats Call with via, Return, Async, Fold, Elided, and Error/Skew/Orphan flags', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', 'missing-parent-99', 0, 100, {
            name: 'POST /checkout',
            kind: SpanKind.Server,
            status: { code: 1 },
          }),
          span('gw-cli', 'gw-root', 10, 60, {
            name: 'PayClient.Charge',
            kind: SpanKind.Client,
          }),
        ],
      ],
      [
        'payment',
        [
          span('pay-srv', 'gw-cli', 14, 54, {
            name: 'ChargeCard',
            kind: SpanKind.Server,
            status: { code: 2, message: 'Card declined' },
          }),
          span('pay-pub', 'pay-srv', 20, 25, {
            name: 'PublishReceipt',
            kind: SpanKind.Producer,
            status: { code: 1 },
          }),
        ],
      ],
    ),
  );

  // Rows:
  // 0: gw-root (parentId = 'missing-parent-99')
  // 1: gw-cli (10..60, dur 50ms)
  // 2: pay-srv (14..54, dur 40ms, status=2 'Card declined')
  // 3: pay-pub (20..25, dur 5ms, status=1)
  const via = new Int32Array([-1, -1, 1, -1]);
  const model = makeModel(index, { via });

  const steps = makeSteps(model, [
    // 0: Found with Orphan flag
    {
      kind: StepKind.Found,
      flags: StepFlag.Orphan,
      row: 0,
      from: 0,
      to: 1,
      time: 0,
      duration: 100,
    },
    // 1: Call with via, Error + Skew flags, and status message
    {
      kind: StepKind.Call,
      flags: StepFlag.Error | StepFlag.Skew,
      row: 2,
      via: 1,
      from: 1,
      to: 2,
      time: 14,
      duration: 40,
    },
    // 2: Return step
    {
      kind: StepKind.Return,
      flags: StepFlag.Error,
      row: 2,
      via: 1,
      from: 2,
      to: 1,
      time: 54,
      duration: 40,
    },
    // 3: Async step
    {
      kind: StepKind.Async,
      flags: StepFlag.None,
      row: 3,
      from: 2,
      to: 1,
      time: 20,
      duration: 5,
    },
    // 4: Fold step with errors
    {
      kind: StepKind.Fold,
      flags: StepFlag.Error,
      row: 2,
      from: 1,
      to: 2,
      foldCount: 4,
      foldErrors: 2,
      duration: 120,
      foldMaxDuration: 45,
      foldRows: [2],
    },
    // 5: Elided step
    {
      kind: StepKind.Elided,
      row: 0,
      from: 0,
      to: 0,
      foldCount: 12,
      duration: 250,
    },
  ]);

  assert.equal(describeStep(steps, -1), null);
  assert.equal(describeStep(steps, 10), null);

  // 0: Found with Orphan
  const foundInfo = describeStep(steps, 0);
  assert.notEqual(foundInfo, null);
  assert.equal(foundInfo?.title, 'POST /checkout');
  assert.equal(foundInfo?.subtitle, 'Client → gateway');
  assert.equal(foundInfo?.status, 'ok');
  assert.deepEqual(foundInfo?.sections[0]?.rows, [
    ['Caller → Callee', 'Client → gateway'],
    ['Pattern', 'Entry Request'],
    ['Start Offset', '+0µs'],
    ['Duration', '100.00ms'],
    ['Orphan Span', 'Missing parent missing-parent-99'],
  ]);

  // 1: Call with via, Error, Skew, Status Message
  const callInfo = describeStep(steps, 1);
  assert.notEqual(callInfo, null);
  assert.equal(callInfo?.title, 'ChargeCard');
  assert.equal(callInfo?.subtitle, 'gateway → payment');
  assert.equal(callInfo?.status, 'error');
  assert.deepEqual(callInfo?.sections[0]?.rows, [
    ['Caller → Callee', 'gateway → payment'],
    ['Pattern', 'Synchronous RPC'],
    ['Start Offset', '+14.00ms'],
    ['Duration', '40.00ms'],
    ['Client Span', 'PayClient.Charge (50.00ms)'],
    ['Transit Delay', '4.00ms'],
    ['Clock Skew', 'Detected (child outside parent bounds)'],
    ['Status Message', 'Card declined'],
  ]);

  // 2: Return step
  const retInfo = describeStep(steps, 2);
  assert.notEqual(retInfo, null);
  assert.equal(retInfo?.title, 'ChargeCard');
  assert.equal(retInfo?.subtitle, 'payment ⇢ gateway (return)');
  assert.equal(retInfo?.status, 'error');
  assert.equal(retInfo?.sections[0]?.rows?.[1]?.[1], 'Return');

  // 3: Async step
  const asyncInfo = describeStep(steps, 3);
  assert.notEqual(asyncInfo, null);
  assert.equal(asyncInfo?.title, 'PublishReceipt');
  assert.equal(asyncInfo?.subtitle, 'payment → gateway');
  assert.equal(asyncInfo?.status, 'ok');
  assert.equal(asyncInfo?.sections[0]?.rows?.[1]?.[1], 'Asynchronous Message');

  // 4: Fold step
  const foldInfo = describeStep(steps, 4);
  assert.deepEqual(foldInfo, {
    title: 'ChargeCard (×4)',
    subtitle: 'gateway → payment',
    status: 'error',
    sections: [
      {
        title: 'Repeated Call Loop',
        rows: [
          ['Calls', '4'],
          ['Total Duration', '120.00ms'],
          ['Avg Duration', '30.00ms'],
          ['Max Duration', '45.00ms'],
          ['Errors', '2'],
        ],
      },
    ],
  });

  // 5: Elided step
  const elidedInfo = describeStep(steps, 5);
  assert.deepEqual(elidedInfo, {
    title: '12 elided interactions',
    subtitle: 'Outside active time window',
    status: 'unset',
    sections: [
      {
        title: 'Time Window',
        rows: [
          ['Elided Spans', '12'],
          ['Span Range', '250.00ms'],
        ],
      },
    ],
  });
});

test('describeActivation includes span brief overview, participant name, nesting level, and hidden count', () => {
  const index = buildSpanIndex(
    trace([
      'gateway',
      [
        span('gw-1', undefined, 0, 80, {
          name: 'HandleRequest',
          kind: SpanKind.Server,
          status: { code: 1 },
        }),
        span('gw-nested', 'gw-1', 10, 50, {
          name: 'ValidateAuth',
          kind: SpanKind.Internal,
          status: { code: 2, message: 'Token expired' },
        }),
      ],
    ]),
  );

  const model = makeModel(index);
  const gwPart = model.participants.names.indexOf('gateway');
  const steps = makeSteps(
    model,
    [],
    [
      { part: gwPart, row: 0, nest: 0, hiddenCount: 0 },
      { part: gwPart, row: 1, nest: 2, hiddenCount: 5 },
    ],
  );

  assert.equal(describeActivation(steps, -1), null);
  assert.equal(describeActivation(steps, 2), null);

  const act0 = describeActivation(steps, 0);
  assert.deepEqual(act0, {
    title: 'HandleRequest',
    subtitle: 'gateway',
    status: 'ok',
    sections: [
      {
        title: 'Overview',
        rows: [
          ['Duration', '80.00ms'],
          ['Kind', 'Server'],
          ['Span ID', 'gw-1'],
        ],
      },
    ],
  });

  const act1 = describeActivation(steps, 1);
  assert.deepEqual(act1, {
    title: 'ValidateAuth',
    subtitle: 'gateway',
    status: 'error',
    sections: [
      {
        title: 'Overview',
        rows: [
          ['Duration', '40.00ms'],
          ['Kind', 'Internal'],
          ['Span ID', 'gw-nested'],
          ['Message', 'Token expired'],
          ['Nesting Level', '2'],
          ['Hidden Spans', '5'],
        ],
      },
    ],
  });
});

test('describeParticipant builds Lifeline summary for Gate, Service, and Inferred participants', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { kind: SpanKind.Server, status: { code: 1 } }),
          span('gw-db', 'gw-root', 10, 30, {
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgres')],
            status: { code: 2 },
          }),
        ],
      ],
      [
        'billing',
        [span('bill-srv', 'gw-root', 40, 80, { kind: SpanKind.Server, status: { code: 1 } })],
      ],
    ),
  );

  // Ordered rows:
  // 0: gw-root (Gate -> gateway)
  // 1: gw-db (gateway -> postgres, status=2)
  // 2: bill-srv (gateway -> billing, status=1)
  const base = makeModel(index);
  const gateId = base.participants.gateId;
  const gwId = base.participants.names.indexOf('gateway');
  const billId = base.participants.names.indexOf('billing');
  const pgId = base.participants.names.indexOf('postgres');

  assert.equal(base.participants.kind[gateId], ParticipantKind.Gate);
  assert.equal(base.participants.kind[gwId], ParticipantKind.Service);
  assert.equal(base.participants.kind[billId], ParticipantKind.Service);
  assert.equal(base.participants.kind[pgId], ParticipantKind.Inferred);

  const model = makeModel(index, {
    msgKind: new Uint8Array([MsgKind.Found, MsgKind.Peer, MsgKind.Sync]),
    from: new Int32Array([gateId, gwId, gwId]),
    to: new Int32Array([gwId, pgId, billId]),
  });

  assert.equal(describeParticipant(model, -1), null);
  assert.equal(describeParticipant(model, 99), null);

  // Gate participant
  const gateInfo = describeParticipant(model, gateId);
  assert.deepEqual(gateInfo, {
    title: GATE_NAME,
    subtitle: 'Entry Point',
    status: 'ok',
    sections: [
      {
        title: 'Lifeline',
        rows: [
          ['Incoming Calls', '0'],
          ['Outgoing Calls', '1'],
          ['Spans', '0'],
          ['Errors', '0'],
        ],
      },
    ],
  });

  // Gateway service (has 1 incoming from Gate, 2 outgoing to postgres & billing, 2 spans, 1 error on gw-db)
  const gwInfo = describeParticipant(model, gwId);
  assert.deepEqual(gwInfo, {
    title: 'gateway',
    subtitle: 'Service',
    status: 'error',
    sections: [
      {
        title: 'Lifeline',
        rows: [
          ['Incoming Calls', '1'],
          ['Outgoing Calls', '2'],
          ['Spans', '2'],
          ['Errors', '1'],
        ],
      },
    ],
  });

  // Billing service (1 incoming, 0 outgoing, 1 span, 0 errors)
  const billInfo = describeParticipant(model, billId);
  assert.deepEqual(billInfo, {
    title: 'billing',
    subtitle: 'Service',
    status: 'ok',
    sections: [
      {
        title: 'Lifeline',
        rows: [
          ['Incoming Calls', '1'],
          ['Outgoing Calls', '0'],
          ['Spans', '1'],
          ['Errors', '0'],
        ],
      },
    ],
  });

  // Inferred dependency postgres (1 incoming, 0 outgoing, 1 peer span with status=2)
  const pgInfo = describeParticipant(model, pgId);
  assert.deepEqual(pgInfo, {
    title: 'postgres',
    subtitle: 'Inferred Dependency',
    status: 'error',
    sections: [
      {
        title: 'Lifeline',
        rows: [
          ['Incoming Calls', '1'],
          ['Outgoing Calls', '0'],
          ['Spans', '1'],
          ['Errors', '1'],
        ],
      },
    ],
  });
});
