import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex } from '../../src/core/index.ts';
import { EXTERNAL_PEER_NAME, classifyLeafPeers, inferredPeerOf } from '../../src/core/peers.ts';
import { kv, span, trace } from '../support/trace-builder.ts';

test('peer.service takes precedence over db.system, messaging.system, rpc.service, and server.address', () => {
  const index = buildSpanIndex(
    trace([
      'gateway',
      [
        span('s1', undefined, 0, 10, {
          kind: SpanKind.Client,
          attributes: [
            kv('server.address', '10.0.0.1'),
            kv('rpc.service', 'CheckoutService'),
            kv('messaging.system', 'kafka'),
            kv('db.system', 'postgres'),
            kv('peer.service', 'explicit-peer'),
          ],
        }),
      ],
    ]),
  );

  assert.deepEqual(inferredPeerOf(index, 0), { name: 'explicit-peer' });
});

test('db.system alone vs db.system with db.name', () => {
  const index = buildSpanIndex(
    trace([
      'orders',
      [
        span('s1', undefined, 0, 10, {
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'redis')],
        }),
        span('s2', undefined, 10, 20, {
          kind: SpanKind.Client,
          attributes: [kv('db.system', 'postgres'), kv('db.name', 'orders')],
        }),
      ],
    ]),
  );

  assert.deepEqual(inferredPeerOf(index, 0), { name: 'redis' });
  assert.deepEqual(inferredPeerOf(index, 1), { name: 'postgres:orders' });
});

test('messaging.system alone vs with messaging.destination.name or messaging.destination', () => {
  const index = buildSpanIndex(
    trace([
      'payment',
      [
        span('s1', undefined, 0, 10, {
          kind: SpanKind.Producer,
          attributes: [kv('messaging.system', 'rabbitmq')],
        }),
        span('s2', undefined, 10, 20, {
          kind: SpanKind.Producer,
          attributes: [kv('messaging.system', 'kafka'), kv('messaging.destination.name', 'events')],
        }),
        span('s3', undefined, 20, 30, {
          kind: SpanKind.Producer,
          attributes: [kv('messaging.system', 'kafka'), kv('messaging.destination', 'events')],
        }),
      ],
    ]),
  );

  assert.deepEqual(inferredPeerOf(index, 0), { name: 'rabbitmq' });
  assert.deepEqual(inferredPeerOf(index, 1), { name: 'kafka:events' });
  assert.deepEqual(inferredPeerOf(index, 2), { name: 'kafka:events' });
});

test('rpc.service extracts RPC target service name', () => {
  const index = buildSpanIndex(
    trace([
      'gateway',
      [
        span('s1', undefined, 0, 10, {
          kind: SpanKind.Client,
          attributes: [kv('rpc.service', 'CheckoutService'), kv('server.address', '10.0.0.2')],
        }),
      ],
    ]),
  );

  assert.deepEqual(inferredPeerOf(index, 0), { name: 'CheckoutService' });
});

test('server.address, net.peer.name, and http.host extract host peer', () => {
  const index = buildSpanIndex(
    trace([
      'gateway',
      [
        span('s1', undefined, 0, 10, {
          kind: SpanKind.Client,
          attributes: [kv('server.address', 'api.stripe.com')],
        }),
        span('s2', undefined, 10, 20, {
          kind: SpanKind.Client,
          attributes: [kv('net.peer.name', 'cache.internal')],
        }),
        span('s3', undefined, 20, 30, {
          kind: SpanKind.Client,
          attributes: [kv('http.host', 'auth.example.com:8443')],
        }),
      ],
    ]),
  );

  assert.deepEqual(inferredPeerOf(index, 0), { name: 'api.stripe.com' });
  assert.deepEqual(inferredPeerOf(index, 1), { name: 'cache.internal' });
  assert.deepEqual(inferredPeerOf(index, 2), { name: 'auth.example.com:8443' });
});

test('returns null when no matching attributes exist or row is out of range', () => {
  const index = buildSpanIndex(
    trace([
      'gateway',
      [
        span('s1', undefined, 0, 10, {
          kind: SpanKind.Internal,
          attributes: [kv('http.method', 'GET')],
        }),
      ],
    ]),
  );

  assert.equal(inferredPeerOf(index, 0), null);
  assert.equal(inferredPeerOf(index, -1), null);
  assert.equal(inferredPeerOf(index, 99), null);
});

test('classifyLeafPeers names the peers of leaf client and producer spans in row order', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('root', undefined, 0, 100, { kind: SpanKind.Server }),
        span('db1', 'root', 10, 20, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')] }),
        span('db2', 'root', 30, 40, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')] }),
        span('bus', 'root', 50, 60, { kind: SpanKind.Producer, attributes: [kv('messaging.system', 'kafka')] }),
        span('local', 'root', 70, 80, { kind: SpanKind.Internal, attributes: [kv('db.system', 'redis')] }),
      ],
    ]),
  );
  const peers = classifyLeafPeers(index);

  assert.equal(peers.count, 2);
  assert.deepEqual(peers.names, ['postgres', 'kafka']);
  assert.deepEqual([...peers.knownService], [-1, -1]);
  assert.deepEqual([...peers.firstRow], [1, 3]);
  assert.deepEqual([...peers.peerOfRow], [-1, 0, 0, 1, -1]);
});

test('classifyLeafPeers maps a peer named like a service of the trace to that service', () => {
  const index = buildSpanIndex(
    trace(
      ['api', [span('c', undefined, 0, 10, { kind: SpanKind.Client, attributes: [kv('peer.service', 'billing')] })]],
      ['billing', [span('b', undefined, 20, 30, { kind: SpanKind.Server })]],
    ),
  );
  const peers = classifyLeafPeers(index);
  const billing = index.table.services.indexOf('billing');

  assert.deepEqual(peers.names, ['billing']);
  assert.equal(peers.knownService[0], billing);
  assert.equal(peers.peerOfRow[index.table.ids.indexOf('c')], 0);
});

test('classifyLeafPeers skips a call with a cross-service descendant, even a deep one', () => {
  const index = buildSpanIndex(
    trace(
      ['api', [
        span('call', undefined, 0, 100, { kind: SpanKind.Client, attributes: [kv('peer.service', 'billing')] }),
        span('mid', 'call', 5, 90),
        span('mid2', 'mid', 6, 80),
      ]],
      ['billing', [span('handler', 'mid2', 10, 70, { kind: SpanKind.Server })]],
    ),
  );
  const peers = classifyLeafPeers(index);

  assert.equal(peers.count, 0);
  assert.ok(peers.peerOfRow.every(p => p === -1));
});

test('classifyLeafPeers keeps a call whose descendants stay in its own service', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('call', undefined, 0, 100, { kind: SpanKind.Client, attributes: [kv('db.system', 'redis')] }),
        span('retry', 'call', 5, 50),
      ],
    ]),
  );
  const peers = classifyLeafPeers(index);

  assert.deepEqual(peers.names, ['redis']);
  assert.deepEqual([...peers.peerOfRow], [0, -1]);
});

test('classifyLeafPeers uses the external fallback only for childless calls without peer attributes', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('root', undefined, 0, 100, { kind: SpanKind.Server }),
        span('bare', 'root', 10, 20, { kind: SpanKind.Client }),
        span('parent', 'root', 30, 60, { kind: SpanKind.Client }),
        span('inner', 'parent', 35, 55),
      ],
    ]),
  );
  const peers = classifyLeafPeers(index);

  assert.deepEqual(peers.names, [EXTERNAL_PEER_NAME]);
  assert.deepEqual([...peers.peerOfRow], [-1, 0, -1, -1]);
});

test('classifyLeafPeers ignores a call to its own service', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [span('self', undefined, 0, 10, { kind: SpanKind.Client, attributes: [kv('peer.service', 'api')] })],
    ]),
  );

  assert.equal(classifyLeafPeers(index).count, 0);
});

test('classifyLeafPeers accepts a custom peer resolver', () => {
  const index = buildSpanIndex(
    trace([
      'api',
      [
        span('a', undefined, 0, 10, { kind: SpanKind.Client }),
        span('b', undefined, 20, 30, { kind: SpanKind.Client }),
      ],
    ]),
  );
  const peers = classifyLeafPeers(index, (_index, row) => (row === 1 ? { name: 'custom' } : null));

  assert.deepEqual(peers.names, [EXTERNAL_PEER_NAME, 'custom']);
  assert.deepEqual([...peers.peerOfRow], [0, 1]);
});

test('classifyLeafPeers handles an empty trace', () => {
  const peers = classifyLeafPeers(buildSpanIndex({ resourceSpans: [] }));

  assert.equal(peers.count, 0);
  assert.equal(peers.peerOfRow.length, 0);
});
