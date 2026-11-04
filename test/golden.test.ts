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
import type { SpanIndex } from '../src/core/span-index.ts';
import { demoLogs, demoLogsIndex, demoLogsTrace, demoOtelIndex } from './support/demo-data.ts';

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
  const logs = demoLogs();
  const traceData = demoLogsTrace();
  const index = demoLogsIndex();

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
  const sha256 = createHash('sha256').update(JSON.stringify(demoLogsTrace())).digest('hex');
  assert.equal(sha256, '924aeeffc937e5174fe1fbea5c22cd62b3246ba85fb394e37ec85028cd3e1cf8');
});

test('demo/otel-trace.json: index keeps its shape', () => {
  const index = demoOtelIndex();

  assert.equal(index.size, 12);
  assert.equal(index.roots.length, 1);
  assert.equal(maxDepth(index), 4);
  assert.equal(new Set([...index.spans.values()].map((s) => s.serviceName)).size, 6);
  assert.equal(index.traceId, '5b8efff798038103d269b633813fc60c');
  assert.deepEqual(index.timeRange, { min: 1706889600000, max: 1706889602450 });
});
