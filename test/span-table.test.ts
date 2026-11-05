/**
 * The SpanTable (typed-array form of a trace) and the SpanIndex built around it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, type SpanIndex } from '../src/core/span-index.ts';
import { SpanKind, type Span, type TraceData } from '../src/core/otel/trace.ts';
import { demoLogsIndex, demoOtelIndex, sha256 } from './support/demo-data.ts';
import { BASE_NS, event, random, span, trace } from './support/trace-builder.ts';

/** Checks everything the table promises, for any index. */
function assertTableInvariants(index: SpanIndex): void {
  const { table, ordered } = index;
  const n = table.length;
  assert.equal(n, index.size);
  assert.equal(ordered.length, n);
  assert.equal(table.ids.length, n);
  assert.equal(table.evOff.length, n + 1);
  assert.equal(table.evOff[n], table.evT.length);
  assert.equal(table.evT.length, table.evSrc.length);
  assert.equal(new Set(table.ids).size, n, 'span ids are unique');

  let previousRootStart = -Infinity;
  for (let row = 0; row < n; row++) {
    assert.equal(ordered[row].idx, row);
    assert.equal(ordered[row].spanId, table.ids[row]);
    assert.equal(index.spans.get(table.ids[row]), ordered[row]);

    const parent = table.parent[row];
    if (parent < 0) {
      assert.equal(table.depth[row], 0);
      assert.ok(table.start[row] >= previousRootStart, 'roots are in start order');
      previousRootStart = table.start[row];
    } else {
      assert.ok(parent < row, 'a parent comes before its children');
      assert.ok(row < table.subtreeEnd[parent], 'a child lies inside its parent subtree');
      assert.equal(table.depth[row], table.depth[parent] + 1);
    }

    const end = table.subtreeEnd[row];
    assert.ok(end > row && end <= n, 'a subtree is a non-empty range of rows');
    for (let inner = row + 1; inner < end; inner++) {
      assert.ok(table.depth[inner] > table.depth[row], 'a descendant is deeper than its ancestor');
    }
    if (end < n) assert.ok(table.depth[end] <= table.depth[row], 'the row after a subtree is not inside it');

    assert.ok(table.evOff[row] <= table.evOff[row + 1], 'event offsets never decrease');
    for (let k = table.evOff[row] + 1; k < table.evOff[row + 1]; k++) {
      assert.ok(table.evT[k] >= table.evT[k - 1], 'events are in time order');
    }
  }

  // siblings are in start order: walk each parent's children by jumping over subtrees
  for (let row = 0; row < n; row++) {
    let previousStart = -Infinity;
    for (let child = row + 1; child < table.subtreeEnd[row]; child = table.subtreeEnd[child]) {
      assert.equal(table.parent[child], row);
      assert.ok(table.start[child] >= previousStart, 'siblings are in start order');
      previousStart = table.start[child];
    }
  }
}

/** Ids in pre-order, walking the object form of the index. */
function preorder(index: SpanIndex): string[] {
  const out: string[] = [];
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      out.push(id);
      walk(index.childrenOf.get(id) ?? []);
    }
  };
  walk(index.roots);
  return out;
}

test('rows are in depth-first pre-order, siblings and roots by start time', () => {
  const index = buildSpanIndex(trace(
    ['svc', [
      span('b', 'root', 30, 40),
      span('r2', undefined, 200, 300),
      span('a1', 'a', 12, 15),
      span('root', undefined, 0, 100),
      span('orphan', 'missing', 5, 6),
      span('a', 'root', 10, 20),
    ]],
  ));
  const { table } = index;

  assert.deepEqual(table.ids, ['root', 'a', 'a1', 'b', 'orphan', 'r2']);
  assert.deepEqual(Array.from(table.parent), [-1, 0, 1, 0, -1, -1]);
  assert.deepEqual(Array.from(table.depth), [0, 1, 2, 1, 0, 0]);
  assert.deepEqual(Array.from(table.subtreeEnd), [4, 3, 3, 4, 5, 6]);
  assert.deepEqual(index.roots, ['root', 'orphan', 'r2']);
  assert.deepEqual(index.childrenOf.get('root'), ['a', 'b']);
  assert.deepEqual(index.childrenOf.get('a'), ['a1']);
  assert.equal(index.childrenOf.has('b'), false);
  assert.equal(index.spans.get('a1')?.idx, 2);
  assertTableInvariants(index);
});

test('the object form keeps the input order of `spans` and the legacy time range', () => {
  const index = buildSpanIndex(trace(
    ['svc', [span('late', undefined, 50, 60), span('early', undefined, 0, 10)]],
  ));

  assert.deepEqual([...index.spans.keys()], ['late', 'early'], 'Map order is input order');
  assert.deepEqual(index.table.ids, ['early', 'late'], 'table order is start order');
  assert.deepEqual(index.timeRange, { min: Number(BASE_NS / 1_000_000n), max: Number(BASE_NS / 1_000_000n) + 60 });
});

test('times are exact milliseconds after the earliest start, sub-millisecond included', () => {
  const index = buildSpanIndex(trace(
    ['svc', [
      span('a', undefined, 0, 500),
      span('b', 'a', 123.456789, 234.567891, { events: [event('e', 150.000001)] }),
    ]],
  ));
  const { table } = index;

  assert.equal(table.originNs, BASE_NS);
  assert.equal(table.start[0], 0);
  assert.equal(table.end[0], 500);
  assert.equal(table.start[1], 123.456789);
  assert.equal(table.end[1], 234.567891);
  assert.equal(table.evT[0], 150.000001);
  assert.equal(table.extentMs, 500);

  const b = index.spans.get('b');
  assert.equal(b?.startMs, Number(BASE_NS / 1_000_000n) + 123, 'the epoch-ms fields keep the old truncation');
  assert.equal(b?.endMs, Number(BASE_NS / 1_000_000n) + 234);
  assert.equal(b?.durationMs, 111);
});

test('precision survives a trace hours long', () => {
  const hours = 6 * 60 * 60 * 1000;
  const index = buildSpanIndex(trace(
    ['svc', [span('a', undefined, 0, 1), span('b', undefined, hours + 0.000123, hours + 0.5)]],
  ));
  assert.equal(index.table.start[1], hours + 0.000123);
  assert.equal(index.table.extentMs, hours + 0.5);
});

test('a span id that occurs twice keeps the later span, in the first one\'s place', () => {
  const index = buildSpanIndex(trace(
    ['one', [span('x', undefined, 10, 20, { name: 'first' }), span('y', undefined, 0, 5)]],
    ['two', [span('x', undefined, 30, 40, { name: 'second' })]],
  ));

  assert.equal(index.size, 2);
  assert.deepEqual([...index.spans.keys()], ['x', 'y']);
  assert.equal(index.spans.get('x')?.span.name, 'second');
  assert.equal(index.spans.get('x')?.serviceName, 'two');
  assert.deepEqual(index.table.ids, ['y', 'x']);
  assertTableInvariants(index);
});

test('parent cycles are cut at the member that starts first, so no span is lost', () => {
  const index = buildSpanIndex(trace(
    ['svc', [
      span('self', 'self', 40, 50),
      span('p', 'q', 10, 20),
      span('q', 'p', 5, 30),
      span('under-q', 'q', 6, 7),
      span('ring-a', 'ring-c', 61, 70),
      span('ring-b', 'ring-a', 62, 70),
      span('ring-c', 'ring-b', 60, 70),
    ]],
  ));

  assert.equal(index.size, 7);
  assert.equal(index.table.length, 7);
  assert.deepEqual(index.roots, ['q', 'self', 'ring-c']);
  assert.deepEqual(index.table.ids, ['q', 'under-q', 'p', 'self', 'ring-c', 'ring-a', 'ring-b']);
  assertTableInvariants(index);
});

test('events are laid out per span and sorted by time, with their source positions', () => {
  const index = buildSpanIndex(trace(
    ['svc', [
      span('quiet', undefined, 0, 100),
      span('busy', undefined, 10, 100, {
        events: [event('late', 30), event('first', 10), event('mid', 20), event('first-again', 10)],
      }),
      span('one', undefined, 20, 100, { events: [event('only', 25)] }),
    ]],
  ));
  const { table } = index;

  assert.deepEqual(table.ids, ['quiet', 'busy', 'one']);
  assert.deepEqual(Array.from(table.evOff), [0, 0, 4, 5]);
  assert.deepEqual(Array.from(table.evT), [10, 10, 20, 30, 25]);
  assert.deepEqual(Array.from(table.evSrc), [1, 3, 2, 0, 0], 'equal times keep their source order');

  const busy = index.spans.get('busy')?.span;
  const names = Array.from(table.evSrc.slice(table.evOff[1], table.evOff[2]), (k) => busy?.events?.[k].name);
  assert.deepEqual(names, ['first', 'first-again', 'mid', 'late']);
  assertTableInvariants(index);
});

test('kinds, statuses, services and names are stored as small integers', () => {
  const index = buildSpanIndex(trace(
    ['alpha', [
      span('a', undefined, 0, 10, { kind: SpanKind.Server, status: { code: 2, message: 'boom' }, name: 'op' }),
      span('b', 'a', 1, 2, { kind: SpanKind.Client, status: { code: 1 }, name: 'op' }),
    ]],
    ['beta', [span('c', 'a', 3, 4, { name: 'other' }), span('d', 'a', 5, 6, { kind: 99 as SpanKind })]],
  ));
  const { table } = index;

  assert.deepEqual(table.ids, ['a', 'b', 'c', 'd']);
  assert.deepEqual(Array.from(table.kind), [2, 3, 1, 99]);
  assert.deepEqual(Array.from(table.status), [2, 1, 0, 0]);
  assert.deepEqual(table.services, ['alpha', 'beta']);
  assert.deepEqual(Array.from(table.svc), [0, 0, 1, 1]);
  assert.deepEqual(table.names, ['op', 'other', 'd']);
  assert.deepEqual(Array.from(table.nameId), [0, 0, 1, 2]);
});

test('a missing service.name becomes "unknown-service"', () => {
  const data: TraceData = {
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 't' }, spans: [span('a', undefined, 0, 1)] }] }],
  };
  const index = buildSpanIndex(data);
  assert.equal(index.spans.get('a')?.serviceName, 'unknown-service');
  assert.deepEqual(index.table.services, ['unknown-service']);
});

test('an empty trace has an empty table', () => {
  const { table } = buildSpanIndex({ resourceSpans: [] });
  assert.equal(table.length, 0);
  assert.equal(table.originNs, 0n);
  assert.equal(table.extentMs, 0);
  assert.deepEqual(Array.from(table.evOff), [0]);
});

test('a time that is not a nanosecond timestamp is reported with the span it belongs to', () => {
  const broken = (patch: Partial<Span>): TraceData => trace(['svc', [span('s1', undefined, 0, 1, patch)]]);

  assert.throws(() => buildSpanIndex(broken({ startTimeUnixNano: 'soon' })), /start time of span s1.*"soon"/);
  assert.throws(() => buildSpanIndex(broken({ endTimeUnixNano: '1.5' })), /end time of span s1.*"1\.5"/);
  assert.throws(
    () => buildSpanIndex(broken({ events: [{ timeUnixNano: 'x', name: 'e', attributes: [] }] })),
    /time of event 0 of span s1/,
  );
});

test('a chain 20000 spans deep is walked without recursion', () => {
  const spans: Span[] = [];
  for (let i = 0; i < 20_000; i++) spans.push(span(`s${i}`, i === 0 ? undefined : `s${i - 1}`, i, i + 1));
  const index = buildSpanIndex(trace(['svc', spans.reverse()]));

  assert.equal(index.table.depth[19_999], 19_999);
  assert.equal(index.table.subtreeEnd[0], 20_000);
  assert.equal(index.table.ids[19_999], 's19999');
  assert.equal(index.roots.length, 1);
});

test('50000 spans index in well under a few seconds and keep every invariant', () => {
  const spans: Span[] = [];
  for (let i = 0; i < 50_000; i++) {
    const events = i % 7 === 0 ? [event('e', i + 0.5), event('f', i + 0.25)] : undefined;
    spans.push(span(`s${i}`, i === 0 ? undefined : `s${Math.floor((i - 1) / 4)}`, i, i + 3, { events }));
  }
  const data = trace(['svc', spans]);

  const started = performance.now();
  const index = buildSpanIndex(data);
  const elapsed = performance.now() - started;

  assert.equal(index.table.length, 50_000);
  assert.equal(index.table.subtreeEnd[0], 50_000);
  assert.ok(elapsed < 3000, `indexing took ${elapsed.toFixed(0)} ms`);
  assertTableInvariants(index);
});

// -- differential test against a naive reference -------------------------------------------

/** The row order the old implementation implied: children by start (ties by input order), depth-first. */
function referenceOrder(spans: readonly Span[]): string[] {
  const slotOf = new Map(spans.map((s, slot) => [s.spanId, slot]));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  spans.forEach((s, slot) => {
    const parent = s.parentSpanId ? slotOf.get(s.parentSpanId) : undefined;
    if (parent === undefined) {
      roots.push(slot);
    } else {
      const list = children.get(parent);
      if (list) list.push(slot);
      else children.set(parent, [slot]);
    }
  });
  const compare = (a: number, b: number): number => {
    const x = BigInt(spans[a].startTimeUnixNano);
    const y = BigInt(spans[b].startTimeUnixNano);
    return x < y ? -1 : x > y ? 1 : a - b;
  };
  const out: string[] = [];
  const walk = (slots: number[]): void => {
    for (const slot of slots.slice().sort(compare)) {
      out.push(spans[slot].spanId);
      walk(children.get(slot) ?? []);
    }
  };
  walk(roots);
  return out;
}

test('random trees, shuffled, come out in the reference order (many equal start times)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const next = random(seed);
    const count = 1500;
    const made: Span[] = [];
    for (let i = 0; i < count; i++) {
      // parents are created earlier, so there are no cycles; some parents are absent from the data
      const parent = i === 0 || next() < 0.05 ? (next() < 0.5 ? undefined : 'absent') : `s${Math.floor(next() * i)}`;
      const start = Math.floor(next() * 40); // few distinct values: lots of ties
      made.push(span(`s${i}`, parent, start, start + 1 + Math.floor(next() * 5)));
    }
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [made[i], made[j]] = [made[j], made[i]];
    }

    const index = buildSpanIndex(trace(['svc', made]));
    assert.deepEqual(index.table.ids, referenceOrder(made), `seed ${seed}`);
    assert.deepEqual(preorder(index), index.table.ids, 'the object form agrees with the table');
    assertTableInvariants(index);
  }
});

// -- the demo data, against what the pre-rework implementation produced ------------------------

test('demo/logs.json keeps the order the old index produced', () => {
  const index = demoLogsIndex();
  const children = [...index.childrenOf].map(([parent, kids]) => `${parent}>${kids.join(',')}`).sort();

  assert.deepEqual(index.roots, ['3a3f24de298ab89f', '1cf2b7dfe9171040']);
  assert.equal(sha256(preorder(index)), '3745275f2546c79c689d39cd35a225c410b73502bf3c3f953e9650d479df94a4');
  assert.equal(sha256(children), 'ed8d37c513357613d924a7bb6e6851151ec63f7d7e1969e24eb72c536a4e3b22');
  assert.equal(sha256([...index.spans.keys()]), '5ec7ab97ebb85ce26f233d03aeee2bc38fb38659856eeb5c92b63e5c1b50aa00');
  assert.deepEqual(index.table.ids, preorder(index));
  assertTableInvariants(index);
});

test('demo/otel-trace.json keeps the order the old index produced', () => {
  const index = demoOtelIndex();
  const children = [...index.childrenOf].map(([parent, kids]) => `${parent}>${kids.join(',')}`).sort();

  assert.deepEqual(index.roots, ['eee19b7ec3c1b174']);
  assert.equal(sha256(preorder(index)), '13bc4304793cf41977403f51572008263e4f254558a1b63ccdd2f771f033e325');
  assert.equal(sha256(children), '4600cd82d0e2ffafbc878633719edced49c53f9d833f53a17c1e8df541ccfc37');
  assert.equal(sha256([...index.spans.keys()]), '2f79f35559cdcd3fce0c78335a64726b2f3c52d98dd30e41c7d97fdf42881d20');
  assert.equal(index.table.extentMs, 2450);
  assert.equal(index.table.end[0], 2450);
  assertTableInvariants(index);
});

test('demo/logs.json: every log is an event, and the table counts them all', () => {
  assert.equal(demoLogsIndex().table.evT.length, 432);
});
