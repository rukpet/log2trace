import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex, createTraceStore } from '../../../src/core.ts';
import {
  MsgKind,
  buildSequenceModel,
  sequenceModel,
} from '../../../src/views/sequence/model/messages.ts';
import { kv, span, trace } from '../../support/trace-builder.ts';

test('root SERVER span is classified as MsgKind.Found from Gate to service, and orphan span sets orphan[r] === 1', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [span('gw-root', undefined, 0, 100, { name: 'GET /api', kind: SpanKind.Server })],
      ],
      [
        'worker',
        [
          span('orphan-span', 'missing-parent', 10, 80, {
            name: 'orphan-work',
            kind: SpanKind.Internal,
          }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const { participants } = model;
  const gwRow = index.spans.get('gw-root')?.idx ?? -1;
  const orphanRow = index.spans.get('orphan-span')?.idx ?? -1;
  const gwId = participants.names.indexOf('gateway');
  const workerId = participants.names.indexOf('worker');

  assert.equal(model.msgKind[gwRow], MsgKind.Found);
  assert.equal(model.from[gwRow], participants.gateId);
  assert.equal(model.to[gwRow], gwId);
  assert.equal(model.via[gwRow], -1);
  assert.equal(model.orphan[gwRow], 0);

  assert.equal(model.msgKind[orphanRow], MsgKind.Found);
  assert.equal(model.from[orphanRow], participants.gateId);
  assert.equal(model.to[orphanRow], workerId);
  assert.equal(model.via[orphanRow], -1);
  assert.equal(model.orphan[orphanRow], 1);
});

test('CLIENT in Service A calling SERVER in Service B suppresses CLIENT as MsgKind.None and classifies SERVER as MsgKind.Sync with via === clientRow', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-root', undefined, 0, 100, { name: 'GET /orders', kind: SpanKind.Server }),
          span('a-client', 'a-root', 10, 90, { name: 'RPC GetUser', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [span('b-server', 'a-client', 15, 85, { name: 'GetUser', kind: SpanKind.Server })],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const { participants } = model;
  const aId = participants.names.indexOf('svc-a');
  const bId = participants.names.indexOf('svc-b');
  const clientRow = index.spans.get('a-client')?.idx ?? -1;
  const serverRow = index.spans.get('b-server')?.idx ?? -1;

  assert.equal(model.msgKind[clientRow], MsgKind.None);
  assert.equal(model.from[clientRow], -1);
  assert.equal(model.to[clientRow], aId);
  assert.equal(model.via[clientRow], -1);

  assert.equal(model.msgKind[serverRow], MsgKind.Sync);
  assert.equal(model.from[serverRow], aId);
  assert.equal(model.to[serverRow], bId);
  assert.equal(model.via[serverRow], clientRow);
});

test('retries: one CLIENT in Service A with two SERVER children in Service B produces two MsgKind.Sync messages both having via === clientRow', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-root', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
          span('a-client', 'a-root', 10, 90, { name: 'call-with-retry', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [
          span('b-srv-1', 'a-client', 12, 40, { name: 'attempt-1', kind: SpanKind.Server }),
          span('b-srv-2', 'a-client', 45, 85, { name: 'attempt-2', kind: SpanKind.Server }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const aId = model.participants.names.indexOf('svc-a');
  const bId = model.participants.names.indexOf('svc-b');
  const clientRow = index.spans.get('a-client')?.idx ?? -1;
  const srv1Row = index.spans.get('b-srv-1')?.idx ?? -1;
  const srv2Row = index.spans.get('b-srv-2')?.idx ?? -1;

  assert.equal(model.msgKind[clientRow], MsgKind.None);

  assert.equal(model.msgKind[srv1Row], MsgKind.Sync);
  assert.equal(model.via[srv1Row], clientRow);
  assert.equal(model.from[srv1Row], aId);
  assert.equal(model.to[srv1Row], bId);
  assert.equal(model.parallel[srv1Row], 0);

  assert.equal(model.msgKind[srv2Row], MsgKind.Sync);
  assert.equal(model.via[srv2Row], clientRow);
  assert.equal(model.from[srv2Row], aId);
  assert.equal(model.to[srv2Row], bId);
  assert.equal(model.parallel[srv2Row], 0);
});

test('PRODUCER in Service A to CONSUMER in Service B is classified as MsgKind.Async with via === producerRow', () => {
  const index = buildSpanIndex(
    trace(
      [
        'orders',
        [
          span('ord-root', undefined, 0, 50, { name: 'POST /order', kind: SpanKind.Server }),
          span('ord-prod', 'ord-root', 20, 30, { name: 'publish event', kind: SpanKind.Producer }),
        ],
      ],
      [
        'Fulfillment',
        [
          span('ful-cons', 'ord-prod', 25, 120, {
            name: 'consume event',
            kind: SpanKind.Consumer,
          }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const ordId = model.participants.names.indexOf('orders');
  const fulId = model.participants.names.indexOf('Fulfillment');
  const prodRow = index.spans.get('ord-prod')?.idx ?? -1;
  const consRow = index.spans.get('ful-cons')?.idx ?? -1;

  assert.equal(model.msgKind[prodRow], MsgKind.None);
  assert.equal(model.msgKind[consRow], MsgKind.Async);
  assert.equal(model.via[consRow], prodRow);
  assert.equal(model.from[consRow], ordId);
  assert.equal(model.to[consRow], fulId);
  // Consumer ending after producer should not trigger clock skew when consumer starts after producer
  assert.equal(model.skew[consRow], 0);
});

test('same-service CLIENT -> SERVER is classified as MsgKind.SelfRpc with via === clientRow', () => {
  const index = buildSpanIndex(
    trace([
      'monolith',
      [
        span('m-root', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
        span('m-client', 'm-root', 10, 80, { name: 'loopback client', kind: SpanKind.Client }),
        span('m-server', 'm-client', 15, 75, { name: 'loopback server', kind: SpanKind.Server }),
      ],
    ]),
  );

  const model = buildSequenceModel(index);
  const monoId = model.participants.names.indexOf('monolith');
  const clientRow = index.spans.get('m-client')?.idx ?? -1;
  const serverRow = index.spans.get('m-server')?.idx ?? -1;

  assert.equal(model.msgKind[clientRow], MsgKind.None);
  assert.equal(model.msgKind[serverRow], MsgKind.SelfRpc);
  assert.equal(model.via[serverRow], clientRow);
  assert.equal(model.from[serverRow], monoId);
  assert.equal(model.to[serverRow], monoId);
});

test('leaf CLIENT with db.system="redis" is classified as MsgKind.Peer and leaf PRODUCER with messaging.system="kafka" as MsgKind.Async', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('api-root', undefined, 0, 100, { name: 'GET /items', kind: SpanKind.Server }),
        span('redis-call', 'api-root', 10, 30, {
          name: 'GET item:1',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
        span('kafka-pub', 'api-root', 40, 60, {
          name: 'send audit',
          kind: SpanKind.Producer,
          attributes: [kv('messaging.system', 'kafka')],
        }),
      ],
    ]),
  );

  const model = buildSequenceModel(index);
  const apiId = model.participants.names.indexOf('api');
  const redisId = model.participants.names.indexOf('redis');
  const kafkaId = model.participants.names.indexOf('kafka');
  const redisRow = index.spans.get('redis-call')?.idx ?? -1;
  const kafkaRow = index.spans.get('kafka-pub')?.idx ?? -1;

  assert.ok(redisId >= 0);
  assert.ok(kafkaId >= 0);

  assert.equal(model.msgKind[redisRow], MsgKind.Peer);
  assert.equal(model.from[redisRow], apiId);
  assert.equal(model.to[redisRow], redisId);
  assert.equal(model.via[redisRow], -1);

  assert.equal(model.msgKind[kafkaRow], MsgKind.Async);
  assert.equal(model.from[kafkaRow], apiId);
  assert.equal(model.to[kafkaRow], kafkaId);
  assert.equal(model.via[kafkaRow], -1);
});

test('same-service INTERNAL child is classified as MsgKind.Internal', () => {
  const index = buildSpanIndex(
    trace([
      'billing',
      [
        span('b-root', undefined, 0, 100, { name: 'POST /charge', kind: SpanKind.Server }),
        span('b-validate', 'b-root', 10, 40, { name: 'validateCard', kind: SpanKind.Internal }),
      ],
    ]),
  );

  const model = buildSequenceModel(index);
  const billingId = model.participants.names.indexOf('billing');
  const internalRow = index.spans.get('b-validate')?.idx ?? -1;

  assert.equal(model.msgKind[internalRow], MsgKind.Internal);
  assert.equal(model.from[internalRow], billingId);
  assert.equal(model.to[internalRow], billingId);
  assert.equal(model.via[internalRow], -1);
});

test('clock skew detection flags child starting before parent or negative duration, but allows async consumer ending after producer', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 20, 100, { name: 'root', kind: SpanKind.Server }),
          span('gw-client-early', 'gw-root', 25, 80, { name: 'call-early', kind: SpanKind.Client }),
          span('gw-neg', 'gw-root', 60, 50, { name: 'negative-dur', kind: SpanKind.Internal }),
          span('gw-prod', 'gw-root', 30, 40, { name: 'pub', kind: SpanKind.Producer }),
        ],
      ],
      [
        'downstream',
        [
          // Starts at 15ms, before gw-client-early (25ms)
          span('ds-early', 'gw-client-early', 15, 70, { name: 'early-srv', kind: SpanKind.Server }),
          // Starts at 35ms (after gw-prod start 30ms), ends at 150ms (after gw-prod end 40ms) -> valid async
          span('ds-async', 'gw-prod', 35, 150, { name: 'async-cons', kind: SpanKind.Consumer }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const rootRow = index.spans.get('gw-root')?.idx ?? -1;
  const earlyRow = index.spans.get('ds-early')?.idx ?? -1;
  const negRow = index.spans.get('gw-neg')?.idx ?? -1;
  const asyncRow = index.spans.get('ds-async')?.idx ?? -1;

  assert.equal(model.skew[rootRow], 0);
  assert.equal(model.skew[earlyRow], 1);
  assert.equal(model.skew[negRow], 1);
  assert.equal(model.skew[asyncRow], 0);
});

test('parallel sibling calls overlapping in time set parallel[r] === 1 while sequential siblings keep 0', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'root', kind: SpanKind.Server }),
          span('c-par-1', 'gw-root', 10, 50, { name: 'parallel-1', kind: SpanKind.Client }),
          span('c-par-2', 'gw-root', 25, 60, { name: 'parallel-2', kind: SpanKind.Client }),
          span('c-seq-3', 'gw-root', 65, 90, { name: 'sequential-3', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-a',
        [span('s-par-1', 'c-par-1', 12, 48, { name: 'srv-1', kind: SpanKind.Server })],
      ],
      [
        'svc-b',
        [span('s-par-2', 'c-par-2', 27, 58, { name: 'srv-2', kind: SpanKind.Server })],
      ],
      [
        'svc-c',
        [span('s-seq-3', 'c-seq-3', 67, 88, { name: 'srv-3', kind: SpanKind.Server })],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const s1 = index.spans.get('s-par-1')?.idx ?? -1;
  const s2 = index.spans.get('s-par-2')?.idx ?? -1;
  const s3 = index.spans.get('s-seq-3')?.idx ?? -1;

  assert.equal(model.parallel[s1], 1);
  assert.equal(model.parallel[s2], 1);
  assert.equal(model.parallel[s3], 0);
});

test('singleParticipant is true for 1 service (with or without Gate) and false when a second service or inferred peer exists', () => {
  // 1 service + Gate
  const singleWithGate = buildSequenceModel(
    buildSpanIndex(
      trace([
        'only-svc',
        [
          span('r1', undefined, 0, 50, { name: 'GET /ping', kind: SpanKind.Server }),
          span('r2', 'r1', 5, 45, { name: 'internal-step', kind: SpanKind.Internal }),
        ],
      ]),
    ),
  );
  assert.equal(singleWithGate.participants.gateId, 0);
  assert.equal(singleWithGate.singleParticipant, true);

  // 1 service without Gate
  const singleNoGate = buildSequenceModel(
    buildSpanIndex(
      trace([
        'cron-svc',
        [span('c1', undefined, 0, 50, { name: 'job', kind: SpanKind.Internal })],
      ]),
    ),
  );
  assert.equal(singleNoGate.participants.gateId, -1);
  assert.equal(singleNoGate.singleParticipant, true);

  // 1 service + 1 inferred peer
  const withPeer = buildSequenceModel(
    buildSpanIndex(
      trace([
        'only-svc',
        [
          span('r1', undefined, 0, 50, { name: 'GET /ping', kind: SpanKind.Server }),
          span('r2', 'r1', 10, 30, {
            name: 'SELECT 1',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgres')],
          }),
        ],
      ]),
    ),
  );
  assert.equal(withPeer.singleParticipant, false);
});

test('sequenceModel selector caches result per SpanIndex and recomputes on new data', () => {
  const store = createTraceStore();
  const emptyModel1 = store.derive(sequenceModel);
  const emptyModel2 = store.derive(sequenceModel);
  assert.equal(emptyModel1, emptyModel2);

  store.setData(
    buildSpanIndex(
      trace([
        'gateway',
        [span('gw-root', undefined, 0, 100, { name: 'GET /', kind: SpanKind.Server })],
      ]),
    ),
  );

  const loaded1 = store.derive(sequenceModel);
  const loaded2 = store.derive(sequenceModel);
  assert.notEqual(loaded1, emptyModel1);
  assert.equal(loaded1, loaded2);
  assert.equal(loaded1.msgKind[0], MsgKind.Found);
});
