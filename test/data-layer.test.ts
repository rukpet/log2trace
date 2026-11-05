/**
 * Small, hand-made cases for the data layer: field access, SpanKind, log
 * grouping in `transformLogs`, and parent/child resolution in `buildSpanIndex`.
 * Expectations record the behaviour of the pre-rework implementation (1.0.0-RC2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getField, transformLogs } from '../src/core/transform.ts';
import { buildSpanIndex } from '../src/core/span-index.ts';
import {
  SpanKind,
  spanKindName,
  type ResourceSpans,
  type Span,
  type TraceData,
} from '../src/core/otel/trace.ts';
import type { KeyValue } from '../src/core/otel/common.ts';

function allSpans(traceData: TraceData): Span[] {
  return traceData.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
}

function durationNs(span: Span): bigint {
  return BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano);
}

function kv(key: string, stringValue: string): KeyValue {
  return { key, value: { stringValue } };
}

function makeSpan(spanId: string, parentSpanId: string | undefined, startMs: number, endMs: number): Span {
  return {
    traceId: 't1',
    spanId,
    parentSpanId,
    name: spanId,
    kind: SpanKind.Internal,
    startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    attributes: [],
  };
}

function makeResource(service: string, spans: Span[]): ResourceSpans {
  return {
    resource: { attributes: [kv('service.name', service)] },
    scopeSpans: [{ scope: { name: 'test' }, spans }],
  };
}

test('getField walks dot paths and stringifies object leaves', () => {
  const log = { text: { Action: 'Login', Code: 0, nested: { ok: true } }, list: [1, 2] };

  assert.equal(getField(log, 'text.Action'), 'Login');
  assert.equal(getField(log, 'text.Code'), 0);
  assert.equal(getField(log, 'text.nested.ok'), true);
  assert.equal(getField(log, 'text.missing.deeper'), undefined);
  assert.equal(getField(log, 'text.nested'), '[object Object]');
  assert.equal(getField(log, 'list'), '1,2');
});

test('SpanKind is an enum with a reverse lookup', () => {
  assert.deepEqual(
    [SpanKind.Unspecified, SpanKind.Internal, SpanKind.Server, SpanKind.Client, SpanKind.Producer, SpanKind.Consumer],
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(spanKindName(SpanKind.Server), 'Server');
  assert.equal(spanKindName(SpanKind.Consumer), 'Consumer');
  assert.equal(spanKindName(99), undefined);
});

const LOGS = [
  { id: 'a1', trace: 'T1', svc: 'api', action: 'Login', at: '2026-01-01T00:00:00.000Z', code: 0 },
  { id: 'a2', trace: 'T1', svc: 'api', action: 'Login', at: '2026-01-01T00:00:00.250Z', code: 5 },
  { id: 'b1', trace: 'T1', svc: 'db', action: 'Query', at: '2026-01-01T00:00:00.100Z', code: 0 },
  { id: 'c1', trace: 'T2', svc: 'api', action: 'Login', at: '2026-01-01T00:01:00.000Z', code: 0 },
];

const GROUPED_CONFIG = {
  traceIdField: 'trace',
  spanGroupFields: ['svc', 'action'],
  spanNameField: 'action',
  serviceNameField: 'svc',
  timestampField: 'at',
  statusCodeField: 'code',
};

test('transformLogs groups logs into spans per trace and service', () => {
  const traceData = transformLogs(LOGS, GROUPED_CONFIG);
  const spans = allSpans(traceData);

  assert.equal(traceData.resourceSpans.length, 2, 'one ResourceSpans per service (api, db)');
  assert.equal(spans.length, 3);
  assert.equal(spans.reduce((n, s) => n + (s.events?.length ?? 0), 0), LOGS.length);

  const [login1, login2, query] = spans;
  assert.equal(login1.events?.length, 2, 'same trace + service + action share one span');
  assert.equal(login1.status?.code, 2, 'a truthy status code marks the span as an error');
  assert.equal(durationNs(login1), 250_000_000n);
  assert.equal(login2.status?.code, 1);
  assert.equal(durationNs(login2), 1_000_000n, 'a single-log span lasts at least 1 ms');
  assert.equal(query.name, 'Query');

  assert.equal(login1.traceId, '0059754a0059798b00597dcc0059820d', 'trace ids are deterministic djb2 hashes');
  assert.equal(query.traceId, login1.traceId, 'same trace value gives the same trace id');
  assert.notEqual(login2.traceId, login1.traceId);
  for (const span of spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
  }
});

test('transformLogs is deterministic', () => {
  assert.deepEqual(transformLogs(LOGS, GROUPED_CONFIG), transformLogs(LOGS, GROUPED_CONFIG));
});

test('transformLogs without spanGroupFields makes one span per log and links parents by id', () => {
  const traceData = transformLogs(
    [
      { id: 'p', parent: '', trace: 'T1', svc: 'api', action: 'Root', at: '2026-01-01T00:00:00.000Z' },
      { id: 'c', parent: 'p', trace: 'T1', svc: 'db', action: 'Child', at: '2026-01-01T00:00:00.050Z' },
    ],
    {
      traceIdField: 'trace',
      spanNameField: 'action',
      serviceNameField: 'svc',
      timestampField: 'at',
      spanIdField: 'id',
      parentSpanIdField: 'parent',
    },
  );
  const [root, child] = allSpans(traceData);

  assert.equal(root.name, 'Root');
  assert.equal(root.parentSpanId, undefined);
  assert.equal(child.parentSpanId, root.spanId);
});

test('buildSpanIndex resolves parents, sorts siblings by start and treats orphans as roots', () => {
  const index = buildSpanIndex({
    resourceSpans: [
      makeResource('a', [
        makeSpan('root', undefined, 1000, 2000),
        makeSpan('late', 'root', 1500, 1600),
        makeSpan('early', 'root', 1100, 1200),
      ]),
      makeResource('b', [makeSpan('orphan', 'missing', 500, 600)]),
    ],
  });

  assert.equal(index.size, 4);
  assert.deepEqual(index.roots, ['orphan', 'root'], 'roots are sorted by start time');
  assert.deepEqual(index.childrenOf.get('root'), ['early', 'late'], 'children are sorted by start time');
  assert.deepEqual(index.timeRange, { min: 500, max: 2000 });
  assert.equal(index.traceId, 't1');
  assert.equal(index.spans.get('late')?.serviceName, 'a');
  assert.equal(index.spans.get('orphan')?.serviceName, 'b');
  assert.equal(index.spans.get('early')?.durationMs, 100);
});

test('buildSpanIndex handles an empty trace', () => {
  const index = buildSpanIndex({ resourceSpans: [] });

  assert.equal(index.size, 0);
  assert.deepEqual(index.roots, []);
  assert.deepEqual(index.timeRange, { min: 0, max: 0 });
  assert.equal(index.traceId, '');
});
