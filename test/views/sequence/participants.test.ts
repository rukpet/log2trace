import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex, createTraceStore } from '../../../src/core.ts';
import {
  EXTERNAL_PEER_NAME,
  GATE_NAME,
  ParticipantKind,
  buildParticipants,
  orderColumns,
} from '../../../src/views/sequence/model/participants.ts';
import { kv, span, trace } from '../../support/trace-builder.ts';

test('empty trace returns count: 0 and gateId: -1', () => {
  const emptyIndex = createTraceStore().state.data.index;
  const p = buildParticipants(emptyIndex);

  assert.equal(p.count, 0);
  assert.equal(p.gateId, -1);
  assert.deepEqual(p.names, []);
  assert.equal(p.kind.length, 0);
  assert.equal(p.firstRow.length, 0);
  assert.equal(p.column.length, 0);
  assert.equal(p.atColumn.length, 0);
  assert.equal(p.ofRow.length, 0);
  assert.equal(p.peerOfRow.length, 0);
});

test('root SERVER span creates the Client gate at column 0', () => {
  const index = buildSpanIndex(
    trace([
      'gateway',
      [span('gw-root', undefined, 0, 100, { name: 'GET /api', kind: SpanKind.Server })],
    ]),
  );

  const p = buildParticipants(index);
  assert.equal(p.count, 2);
  assert.equal(p.gateId, 0);
  assert.deepEqual(p.names, [GATE_NAME, 'gateway']);
  assert.equal(p.kind[0], ParticipantKind.Gate);
  assert.equal(p.kind[1], ParticipantKind.Service);
  assert.equal(p.column[p.gateId], 0);
  assert.equal(p.atColumn[0], p.gateId);
  assert.equal(p.column[1], 1);
  assert.equal(p.ofRow[0], 1);
});

test('root INTERNAL span with no missing parent omits the gate (gateId === -1)', () => {
  const index = buildSpanIndex(
    trace([
      'scheduler',
      [
        span('cron-root', undefined, 0, 50, { name: 'tick', kind: SpanKind.Internal }),
        span('cron-child', 'cron-root', 5, 45, { name: 'work', kind: SpanKind.Internal }),
      ],
    ]),
  );

  const p = buildParticipants(index);
  assert.equal(p.gateId, -1);
  assert.equal(p.count, 1);
  assert.deepEqual(p.names, ['scheduler']);
  assert.equal(p.kind[0], ParticipantKind.Service);
  assert.equal(p.column[0], 0);
  assert.equal(p.atColumn[0], 0);
  assert.deepEqual([...p.ofRow], [0, 0]);
});

test('root span with missing parentSpanId (orphan) creates the Client gate at column 0', () => {
  const index = buildSpanIndex(
    trace([
      'worker',
      [
        span('orphan-span', 'missing-parent-id', 10, 80, {
          name: 'orphan-work',
          kind: SpanKind.Internal,
        }),
      ],
    ]),
  );

  const p = buildParticipants(index);
  assert.equal(p.gateId, 0);
  assert.equal(p.count, 2);
  assert.deepEqual(p.names, [GATE_NAME, 'worker']);
  assert.equal(p.kind[0], ParticipantKind.Gate);
  assert.equal(p.kind[1], ParticipantKind.Service);
  assert.equal(p.column[p.gateId], 0);
  assert.equal(p.atColumn[0], p.gateId);
});

test('services are ordered by first appearance in causal flow', () => {
  // Resource spans are provided in alphabetical order (auth, billing, gateway),
  // but causal execution starts in gateway -> auth -> billing.
  const index = buildSpanIndex(
    trace(
      [
        'auth',
        [span('auth-srv', 'gw-c1', 10, 30, { name: 'verify', kind: SpanKind.Server })],
      ],
      [
        'billing',
        [span('bill-srv', 'auth-c1', 15, 25, { name: 'charge', kind: SpanKind.Server })],
      ],
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
          span('gw-c1', 'gw-root', 5, 40, { name: 'call-auth', kind: SpanKind.Client }),
        ],
      ],
      [
        'auth',
        [span('auth-c1', 'auth-srv', 12, 28, { name: 'call-billing', kind: SpanKind.Client })],
      ],
    ),
  );

  const p = buildParticipants(index);
  const orderedNames = Array.from({ length: p.count }, (_, col) => p.names[p.atColumn[col]]);
  assert.deepEqual(orderedNames, [GATE_NAME, 'gateway', 'auth', 'billing']);

  // Verify column and atColumn are exact inverses
  for (let id = 0; id < p.count; id++) {
    assert.equal(p.atColumn[p.column[id]], id);
  }
});

test('leaf CLIENT span with db.system="postgres" and db.name="users" creates Inferred participant "postgres:users"', () => {
  const index = buildSpanIndex(
    trace([
      'users-svc',
      [
        span('u-root', undefined, 0, 50, { name: 'GET /users', kind: SpanKind.Server }),
        span('u-db', 'u-root', 10, 30, {
          name: 'SELECT * FROM users',
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'postgres'), kv('db.name', 'users')],
        }),
      ],
    ]),
  );

  const p = buildParticipants(index);
  const dbId = p.names.indexOf('postgres:users');
  assert.ok(dbId >= 0, 'Expected inferred participant "postgres:users"');
  assert.equal(p.kind[dbId], ParticipantKind.Inferred);

  const dbRow = index.spans.get('u-db')?.idx ?? -1;
  assert.equal(p.peerOfRow[dbRow], dbId);
  assert.equal(p.firstRow[dbId], dbRow);
});

test('leaf CLIENT span with peer.service matching an existing service routes peerOfRow to that service participant', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'GET /checkout', kind: SpanKind.Server }),
          span('gw-leaf-auth', 'gw-root', 10, 40, {
            name: 'call-auth-uninstrumented-child',
            kind: SpanKind.Client,
            attributes: [kv('peer.service', 'auth')],
          }),
        ],
      ],
      [
        'auth',
        [span('auth-bg', undefined, 50, 90, { name: 'bg-refresh', kind: SpanKind.Internal })],
      ],
    ),
  );

  const p = buildParticipants(index);
  // Gate + gateway + auth = 3 participants (no duplicate Inferred "auth")
  assert.equal(p.count, 3);
  const authId = p.names.indexOf('auth');
  assert.ok(authId >= 0);
  assert.equal(p.kind[authId], ParticipantKind.Service);

  const leafRow = index.spans.get('gw-leaf-auth')?.idx ?? -1;
  assert.equal(p.peerOfRow[leafRow], authId);
});

test('leaf CLIENT span with no children and no peer attributes creates "(external)" inferred participant', () => {
  const index = buildSpanIndex(
    trace([
      'checkout',
      [
        span('chk-root', undefined, 0, 100, { name: 'POST /pay', kind: SpanKind.Server }),
        span('chk-ext', 'chk-root', 20, 60, { name: 'HTTP POST', kind: SpanKind.Client }),
      ],
    ]),
  );

  const p = buildParticipants(index);
  const extId = p.names.indexOf(EXTERNAL_PEER_NAME);
  assert.ok(extId >= 0, 'Expected "(external)" inferred participant');
  assert.equal(p.kind[extId], ParticipantKind.Inferred);

  const extRow = index.spans.get('chk-ext')?.idx ?? -1;
  assert.equal(p.peerOfRow[extRow], extId);
});

test('CLIENT span that has a cross-service SERVER child does NOT create an inferred participant', () => {
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'GET /orders', kind: SpanKind.Server }),
          span('gw-client', 'gw-root', 10, 90, {
            name: 'call-orders',
            kind: SpanKind.Client,
            attributes: [kv('peer.service', 'orders-peer-alias'), kv('http.host', 'orders.local')],
          }),
        ],
      ],
      [
        'orders',
        [span('ord-srv', 'gw-client', 15, 85, { name: 'GET /orders', kind: SpanKind.Server })],
      ],
    ),
  );

  const p = buildParticipants(index);
  const clientRow = index.spans.get('gw-client')?.idx ?? -1;
  assert.equal(p.peerOfRow[clientRow], -1);
  assert.equal(p.names.includes('orders-peer-alias'), false);
  assert.equal(p.names.includes(EXTERNAL_PEER_NAME), false);
});

test('orderColumns reduces arrow span distance when a heavily-communicating pair is initially separated, keeping Gate at col 0', () => {
  // Participants:
  // 0: Gate (firstRow 0)
  // 1: api (firstRow 0)
  // 2: audit (firstRow 1, called once by api)
  // 3: cache (firstRow 2, called 10 times by api)
  // Initial firstRow order is [Gate(0), api(1), audit(2), cache(3)] where api(1) and cache(3) are separated by audit(2).
  const count = 4;
  const firstRow = new Int32Array([0, 0, 1, 2]);
  const kind = new Uint8Array([
    ParticipantKind.Gate,
    ParticipantKind.Service,
    ParticipantKind.Service,
    ParticipantKind.Inferred,
  ]);
  const weights = new Map<number, number>([
    [0 * count + 1, 1], // Gate -> api
    [1 * count + 2, 1], // api -> audit (weight 1)
    [1 * count + 3, 10], // api -> cache (weight 10)
  ]);

  const { column, atColumn } = orderColumns(count, firstRow, kind, weights, 0);

  // Gate must remain pinned at column 0
  assert.equal(column[0], 0);
  assert.equal(atColumn[0], 0);

  // api (1) and cache (3) must be placed in adjacent columns (distance 1 instead of initial distance 2)
  assert.equal(Math.abs(column[1] - column[3]), 1);
  assert.deepEqual([...atColumn], [0, 1, 3, 2]);
});
