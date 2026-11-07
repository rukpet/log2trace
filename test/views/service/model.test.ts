import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex, createTraceStore } from '../../../src/core.ts';
import {
  EdgePattern,
  NodeKind,
  buildServiceGraph,
  buildServiceTopology,
  describeEdge,
  describeNode,
  edgesMatched,
  edgesOfSpans,
  neighbourNode,
  nodesMatched,
  nodesOfSpans,
  serviceGraph,
  serviceTopology,
  spansOfEdge,
  spansOfNode,
} from '../../../src/views/service/model.ts';
import { kv, span, trace } from '../../support/trace-builder.ts';

function createMultiServiceTrace() {
  // gateway -> auth (sync), gateway -> orders (sync)
  // orders -> payment (sync)
  // orders -> postgresql (inferred db peer)
  // payment -> kafka:receipts (async producer)
  return buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'GET /checkout', kind: SpanKind.Server }),
          span('gw-c1', 'gw-root', 5, 25, { name: 'call-auth', kind: SpanKind.Client }),
          span('gw-c2', 'gw-root', 30, 95, { name: 'call-orders', kind: SpanKind.Client }),
        ],
      ],
      [
        'auth',
        [
          span('auth-srv', 'gw-c1', 6, 24, { name: 'POST /verify', kind: SpanKind.Server }),
        ],
      ],
      [
        'orders',
        [
          span('ord-srv', 'gw-c2', 32, 94, { name: 'POST /orders', kind: SpanKind.Server }),
          span('ord-c1', 'ord-srv', 35, 60, { name: 'call-pay', kind: SpanKind.Client }),
          span('ord-db', 'ord-srv', 65, 80, {
            name: 'SELECT orders',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgresql'), kv('db.name', 'orderdb')],
          }),
        ],
      ],
      [
        'payment',
        [
          span('pay-srv', 'ord-c1', 36, 58, { name: 'POST /charge', kind: SpanKind.Server, status: { code: 2 } }),
          span('pay-msg', 'pay-srv', 50, 56, {
            name: 'publish-event',
            kind: SpanKind.Producer,
            attributes: [kv('messaging.system', 'kafka'), kv('messaging.destination.name', 'receipts')],
          }),
        ],
      ],
    ),
  );
}

test('extracts services and inferred peer dependencies as nodes in discovery order', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);

  assert.equal(topo.nodeCount, 6);
  assert.deepEqual(topo.names, [
    'gateway',
    'auth',
    'orders',
    'payment',
    'kafka:receipts',
    'postgresql:orderdb',
  ]);

  assert.equal(topo.nodeKind[0], NodeKind.Service);
  assert.equal(topo.nodeKind[1], NodeKind.Service);
  assert.equal(topo.nodeKind[2], NodeKind.Service);
  assert.equal(topo.nodeKind[3], NodeKind.Service);
  assert.equal(topo.nodeKind[4], NodeKind.Inferred);
  assert.equal(topo.nodeKind[5], NodeKind.Inferred);

  // Root entrypoint
  assert.equal(topo.isEntryNode[0], 1);
  assert.equal(topo.isEntryNode[1], 0);
});

test('identifies cross-service directed edges and communication patterns', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);

  assert.equal(topo.edgeCount, 5);

  const edgePairs = [];
  for (let e = 0; e < topo.edgeCount; e++) {
    edgePairs.push({
      src: topo.names[topo.source[e]],
      dst: topo.names[topo.target[e]],
      pattern: topo.pattern[e],
    });
  }

  assert.deepEqual(edgePairs, [
    { src: 'gateway', dst: 'auth', pattern: EdgePattern.Sync },
    { src: 'gateway', dst: 'orders', pattern: EdgePattern.Sync },
    { src: 'orders', dst: 'payment', pattern: EdgePattern.Sync },
    { src: 'payment', dst: 'kafka:receipts', pattern: EdgePattern.Async },
    { src: 'orders', dst: 'postgresql:orderdb', pattern: EdgePattern.Sync },
  ]);
});

test('calculates exact interval-union self time without parallel child distortion', () => {
  // Caller in srv1 (0-100) calls 2 parallel children in srv2 (10-50) and srv3 (30-70).
  // Union of children is 10-70 = 60ms.
  // Self time of srv1 should be 100 - 60 = 40ms, NOT 100 - (40+40) = 20ms.
  const index = buildSpanIndex(
    trace(
      ['srv1', [span('r', undefined, 0, 100, { name: 'root' })]],
      ['srv2', [span('c1', 'r', 10, 50, { name: 'c1' })]],
      ['srv3', [span('c2', 'r', 30, 70, { name: 'c2' })]],
    ),
  );

  const topo = buildServiceTopology(index);
  const graph = buildServiceGraph(topo, null);

  assert.equal(graph.selfMs[0], 40); // srv1
  assert.equal(graph.selfMs[1], 40); // srv2
  assert.equal(graph.selfMs[2], 40); // srv3
  assert.equal(graph.totalSelfMs, 120);
});

test('detects and breaks causal feedback cycles (A -> B -> A)', () => {
  // A calls B at t=10, B calls back A at t=30
  const index = buildSpanIndex(
    trace(
      [
        'srvA',
        [
          span('a-root', undefined, 0, 100),
          span('a-c1', 'a-root', 10, 80),
          span('a-srv-callback', 'b-c1', 35, 70),
        ],
      ],
      [
        'srvB',
        [
          span('b-srv', 'a-c1', 12, 78),
          span('b-c1', 'b-srv', 30, 75),
        ],
      ],
    ),
  );

  const topo = buildServiceTopology(index);
  assert.equal(topo.nodeCount, 2);
  assert.equal(topo.edgeCount, 2);

  // srvA is rank 0, srvB is rank 1
  assert.equal(topo.rank[0], 0);
  assert.equal(topo.rank[1], 1);

  // The callback edge srvB -> srvA should be marked reversed
  const bToA = topo.source[0] === 1 ? 0 : 1;
  assert.equal(topo.reversed[bToA], 1);
});

test('time window clips metrics accurately', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);

  // Full trace
  const fullGraph = buildServiceGraph(topo, null);
  assert.equal(fullGraph.requestCount[0], 1); // gateway

  // Window [0, 20]: cuts off orders (starts at 30) and payment (starts at 36)
  const clippedGraph = buildServiceGraph(topo, { t0: 0, t1: 20 });
  assert.equal(clippedGraph.spanCount[0], 2); // gw-root and gw-c1
  assert.equal(clippedGraph.spanCount[1], 1); // auth-srv
  assert.equal(clippedGraph.spanCount[2], 0); // orders has 0 spans in window
  assert.equal(clippedGraph.spanCount[3], 0); // payment has 0 spans in window
});

test('store selectors serviceTopology and serviceGraph cache derivations', () => {
  const store = createTraceStore();
  const index = createMultiServiceTrace();
  store.setData(index);

  const topo1 = store.derive(serviceTopology);
  const graph1 = store.derive(serviceGraph);

  // Mutating hover or selection does not bust topology or graph cache
  store.setHover(['gw-root']);
  assert.equal(store.derive(serviceTopology), topo1);
  assert.equal(store.derive(serviceGraph), graph1);

  // Setting time window updates graph, but keeps topology
  store.setWindow({ t0: 0, t1: 50 });
  const graph2 = store.derive(serviceGraph);
  assert.equal(store.derive(serviceTopology), topo1);
  assert.notEqual(graph2, graph1);
  assert.equal(graph2.window?.t1, 50);
});

test('interaction helpers: spansOfNode and spansOfEdge pick failing primary first', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);
  const graph = buildServiceGraph(topo, null);

  // payment service node (index 3) has failing span pay-srv
  const nodeSpans = spansOfNode(graph, 3);
  assert.equal(nodeSpans.primary, 'pay-srv');
  assert.ok(nodeSpans.ids.includes('pay-srv'));

  // orders -> payment edge (index 2)
  const edgeSpans = spansOfEdge(graph, 2);
  assert.equal(edgeSpans.primary, 'pay-srv');
  assert.ok(edgeSpans.ids.includes('ord-c1'));
  assert.ok(edgeSpans.ids.includes('pay-srv'));
});

test('interaction helpers: nodesOfSpans, edgesOfSpans, matched', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);
  const graph = buildServiceGraph(topo, null);

  const matchedNodes = nodesOfSpans(graph, new Set(['pay-srv', 'unknown']));
  assert.deepEqual([...matchedNodes], [3]);

  const matchedEdges = edgesOfSpans(graph, new Set(['ord-srv']));
  // ord-srv is callee on edge 1 (gateway -> orders)
  assert.deepEqual([...matchedEdges], [1]);

  const store = createTraceStore();
  store.setData(index);
  store.setMatched(new Set(['pay-srv']));
  const nMatched = nodesMatched(graph, store.state.matched);
  assert.ok(nMatched !== null);
  assert.equal(nMatched[3], 1);
  assert.equal(nMatched[0], 0);

  const eMatched = edgesMatched(graph, store.state.matched);
  assert.ok(eMatched !== null);
  // Edge 2 is orders -> payment
  assert.equal(eMatched[2], 1);
  assert.equal(eMatched[0], 0);
});

test('describeNode and describeEdge produce InfoModel', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);
  const graph = buildServiceGraph(topo, null);

  const nodeInfo = describeNode(graph, 3);
  assert.equal(nodeInfo.title, 'payment');
  assert.equal(nodeInfo.status, 'error');

  const edgeInfo = describeEdge(graph, 0);
  assert.equal(edgeInfo.title, 'gateway → auth');
  assert.equal(edgeInfo.status, 'ok');
});

test('neighbourNode supports 4-way keyboard navigation', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);
  const graph = buildServiceGraph(topo, null);

  // gateway (0) -> right should navigate to callee (auth or orders)
  const right = neighbourNode(graph, 0, 'right');
  assert.ok(right === 1 || right === 2);

  // auth (1) -> left should navigate back to gateway (0)
  const left = neighbourNode(graph, 1, 'left');
  assert.equal(left, 0);
});

test('empty trace handles zero nodes and edges gracefully', () => {
  const emptyIndex = createTraceStore().state.data.index;
  const topo = buildServiceTopology(emptyIndex);
  assert.equal(topo.nodeCount, 0);
  assert.equal(topo.edgeCount, 0);
  assert.equal(topo.width, 0);
  assert.equal(topo.height, 0);

  const graph = buildServiceGraph(topo, null);
  assert.equal(graph.totalSelfMs, 0);
});

test('computes metrics and enables selection for inferred peer nodes', () => {
  const index = createMultiServiceTrace();
  const topo = buildServiceTopology(index);
  const graph = buildServiceGraph(topo, null);

  // In topo.names:
  // 4: 'kafka:receipts' (called by pay-msg: 50..56 = 6ms)
  // 5: 'postgresql:orderdb' (called by ord-db: 65..80 = 15ms)
  assert.equal(topo.names[4], 'kafka:receipts');
  assert.equal(topo.names[5], 'postgresql:orderdb');

  // Metrics for postgresql:orderdb
  assert.equal(graph.spanCount[5], 1);
  assert.equal(graph.requestCount[5], 1);
  assert.equal(graph.errorCount[5], 0);
  assert.equal(graph.selfMs[5], 15);
  assert.equal(graph.totalMs[5], 15);
  assert.equal(graph.maxMs[5], 15);
  assert.equal(graph.p95Ms[5], 15);

  // Metrics for kafka:receipts
  assert.equal(graph.spanCount[4], 1);
  assert.equal(graph.requestCount[4], 1);
  assert.equal(graph.errorCount[4], 0);
  assert.equal(graph.selfMs[4], 6);
  assert.equal(graph.totalMs[4], 6);

  // spansOfNode on inferred peer nodes
  const dbSpans = spansOfNode(graph, 5);
  assert.deepEqual(dbSpans.ids, ['ord-db']);
  assert.equal(dbSpans.primary, 'ord-db');

  const kafkaSpans = spansOfNode(graph, 4);
  assert.deepEqual(kafkaSpans.ids, ['pay-msg']);
  assert.equal(kafkaSpans.primary, 'pay-msg');

  // nodesOfSpans includes both the calling service and the inferred peer node
  const matchedNodes = nodesOfSpans(graph, new Set(['ord-db']));
  assert.ok(matchedNodes.has(2)); // orders service
  assert.ok(matchedNodes.has(5)); // postgresql:orderdb inferred node

  // nodesMatched marks inferred peer node when filter matches calling span
  const store = createTraceStore();
  store.setData(index);
  store.setMatched(new Set(['ord-db']));
  const nMatched = nodesMatched(graph, store.state.matched);
  assert.ok(nMatched !== null);
  assert.equal(nMatched[2], 1); // orders
  assert.equal(nMatched[5], 1); // postgresql:orderdb
  assert.equal(nMatched[4], 0); // kafka:receipts not matched
});

test('links leaf peer span to existing instrumented service without creating duplicate inferred node', () => {
  // gateway calls auth (instrumented service) directly via leaf client span with peer.service = 'auth'
  const index = buildSpanIndex(
    trace(
      [
        'gateway',
        [
          span('gw-root', undefined, 0, 100, { name: 'GET /checkout', kind: SpanKind.Server }),
          span('gw-client-auth', 'gw-root', 10, 40, {
            name: 'call-auth',
            kind: SpanKind.Client,
            attributes: [kv('peer.service', 'auth')],
          }),
        ],
      ],
      [
        'auth',
        [
          span('auth-root', undefined, 50, 90, { name: 'background-job', kind: SpanKind.Server }),
        ],
      ],
    ),
  );

  const topo = buildServiceTopology(index);
  // Should have exactly 2 nodes (gateway, auth), NOT 3 (no duplicate inferred auth node)
  assert.equal(topo.nodeCount, 2);
  assert.deepEqual(topo.names, ['gateway', 'auth']);
  assert.equal(topo.nodeKind[0], NodeKind.Service);
  assert.equal(topo.nodeKind[1], NodeKind.Service);

  // Edge connects gateway (0) -> auth (1)
  assert.equal(topo.edgeCount, 1);
  assert.equal(topo.source[0], 0);
  assert.equal(topo.target[0], 1);
});

