import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex } from '../../src/core.ts';
import { inferredPeerOf } from '../../src/core/peers.ts';
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
