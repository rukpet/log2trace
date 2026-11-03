/**
 * Characterisation tests for the data layer (transform + index) on the demo data.
 *
 * The numbers below were recorded from the implementation before the v2 rework.
 * They are the safety net for moving the data layer into `core/`: a failure means
 * behaviour changed. When a change is intended, update the value deliberately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformLogs } from '../src/transform.ts';
import { buildSpanIndex, type SpanIndex } from '../src/span-index.ts';
import type { LogEntry, SpanKindRule, TransformConfig } from '../src/config.ts';
import type { TraceData } from '../src/opentelemetry/trace.ts';

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../demo/${name}`, import.meta.url), 'utf8'));
}

function rule(field: string, value: string, kind: string): SpanKindRule {
  return { match: { [field]: value }, kind };
}

/** The mapping used by `demo/logs-transform.html` (attributes plus `<span-kind-rule>` children). */
const DEMO_CONFIG: TransformConfig = {
  traceIdField: 'text.BTMID',
  spanGroupFields: ['text.Application', 'text.Action'],
  spanNameField: 'text.Action',
  serviceNameField: 'text.Application',
  timestampField: 'text.CreateDate',
  statusCodeField: 'text.Code',
  parentSpanLookupFields: ['text.InitiatingApplication'],
  spanKindRules: [
    rule('text.ClassName', 'API', 'Server'),
    rule('text.MethodName', 'LogOutgoingDomainRequest', 'Client'),
    rule('text.MethodName', 'LogReceivedDomainResponse', 'Client'),
    rule('text.ClassName', 'HttpUtilSync', 'Client'),
    rule('text.MethodName', 'UnaryServerHandler', 'Server'),
    rule('text.ClassName', 'LoggingInterceptor', 'Server'),
    rule('text.ClassName', 'ServerLoggingInterceptor', 'Server'),
    rule('text.ClassName', 'LoggerInterceptor', 'Server'),
    rule('text.ClassName', '<ProcessConsumeResult>d__27', 'Consumer'),
    rule('text.ClassName', '<ProcessConsumeResult>d__26', 'Consumer'),
    rule('text.ClassName', 'DomainServiceMessageInspector', 'Internal'),
  ],
};

function maxDepth(index: SpanIndex): number {
  let depth = 0;
  const walk = (ids: readonly string[], level: number): void => {
    for (const id of ids) {
      depth = Math.max(depth, level);
      walk(index.childrenOf.get(id) ?? [], level + 1);
    }
  };
  walk(index.roots, 0);
  return depth;
}

test('demo/logs.json: transform and index keep their shape', () => {
  const logs = readJson('logs.json') as LogEntry[];
  const traceData = transformLogs(logs, DEMO_CONFIG);
  const index = buildSpanIndex(traceData);

  assert.equal(logs.length, 432);
  assert.equal(traceData.resourceSpans.length, 34, 'one ResourceSpans per service');
  assert.equal(index.size, 94);
  assert.equal(index.roots.length, 2);
  assert.equal(maxDepth(index), 4);
  assert.equal(index.traceId, 'c0a2126788d7b128510d4fe91942eeaa');
  assert.deepEqual(index.timeRange, { min: 1772084240340, max: 1772084368286 });

  let events = 0;
  for (const { span } of index.spans.values()) events += span.events?.length ?? 0;
  assert.equal(events, logs.length, 'every log becomes exactly one event');
});

test('demo/logs.json: TraceData fingerprint is stable', () => {
  const traceData = transformLogs(readJson('logs.json') as LogEntry[], DEMO_CONFIG);
  const sha256 = createHash('sha256').update(JSON.stringify(traceData)).digest('hex');
  assert.equal(sha256, '924aeeffc937e5174fe1fbea5c22cd62b3246ba85fb394e37ec85028cd3e1cf8');
});

test('demo/otel-trace.json: index keeps its shape', () => {
  const index = buildSpanIndex(readJson('otel-trace.json') as TraceData);

  assert.equal(index.size, 12);
  assert.equal(index.roots.length, 1);
  assert.equal(maxDepth(index), 4);
  assert.equal(new Set([...index.spans.values()].map((s) => s.serviceName)).size, 6);
  assert.equal(index.traceId, '5b8efff798038103d269b633813fc60c');
  assert.deepEqual(index.timeRange, { min: 1706889600000, max: 1706889602450 });
});
