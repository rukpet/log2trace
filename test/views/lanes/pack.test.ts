import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, type SpanIndex } from '../../../src/core/index.ts';
import { INSTANT_MS, createPackScratch, packLevels } from '../../../src/views/lanes/model/pack.ts';
import { random, span, trace, treeTrace, type TreeNode } from '../../support/trace-builder.ts';
import type { Span } from '../../../src/core/otel/trace.ts';

interface Packed {
  readonly index: SpanIndex;
  readonly levels: Int32Array;
  readonly levelCount: number;
  readonly rowOf: (id: string) => number;
}

/** Pack every span of a one-service trace as one lane, with the parent constraint. */
function packAll(index: SpanIndex, lane = 0): Packed {
  const t = index.table;
  const rows = new Int32Array(t.length);
  for (let r = 0; r < t.length; r++) rows[r] = r;
  const laneOfRow = new Int32Array(t.length).fill(lane);
  const levels = new Int32Array(t.length).fill(-1);
  const levelCount = packLevels(rows, t.start, t.end, { parent: t.parent, laneOfRow, lane }, levels, createPackScratch(t.length));
  return { index, levels, levelCount, rowOf: id => index.table.ids.indexOf(id) };
}

function packTree(roots: TreeNode | readonly TreeNode[]): Packed {
  return packAll(buildSpanIndex(treeTrace(roots)));
}

/** Assert that no two spans on one level overlap (a span ending where the next starts does not). */
function assertNoOverlap(p: Packed): void {
  const t = p.index.table;
  const byLevel = new Map<number, number[]>();
  for (let r = 0; r < t.length; r++) {
    const list = byLevel.get(p.levels[r]) ?? [];
    list.push(r);
    byLevel.set(p.levels[r], list);
  }
  for (const rows of byLevel.values()) {
    rows.sort((a, b) => t.start[a] - t.start[b]);
    for (let k = 1; k < rows.length; k++) {
      const prev = rows[k - 1];
      const prevEnd = Math.max(t.end[prev], t.start[prev] + INSTANT_MS);
      assert.ok(t.start[rows[k]] >= prevEnd, `rows ${prev} and ${rows[k]} overlap on level ${p.levels[prev]}`);
    }
  }
}

test('an empty lane has no levels', () => {
  const levels = new Int32Array(0);
  assert.equal(packLevels(new Int32Array(0), new Float64Array(0), new Float64Array(0), null, levels, createPackScratch(0)), 0);
});

test('a nested chain goes one level deeper per generation', () => {
  const p = packTree({ id: 'a', start: 0, end: 100, children: [{ id: 'b', start: 10, end: 90, children: [{ id: 'c', start: 20, end: 80 }] }] });
  assert.deepEqual([p.levels[p.rowOf('a')], p.levels[p.rowOf('b')], p.levels[p.rowOf('c')]], [0, 1, 2]);
  assert.equal(p.levelCount, 3);
});

test('sequential spans share a level, back-to-back ones too', () => {
  const p = packTree([{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 10, end: 20 }, { id: 'c', start: 30, end: 40 }]);
  assert.deepEqual([...p.levels], [0, 0, 0]);
  assert.equal(p.levelCount, 1);
});

test('concurrent siblings take separate levels and freed levels are reused', () => {
  const p = packTree({
    id: 'root', start: 0, end: 100,
    children: [
      { id: 'a', start: 10, end: 50 },
      { id: 'b', start: 20, end: 30 },
      { id: 'c', start: 25, end: 60 },
      { id: 'd', start: 35, end: 45 },
      { id: 'e', start: 70, end: 80 },
    ],
  });
  const level = (id: string): number => p.levels[p.rowOf(id)];
  assert.equal(level('root'), 0);
  assert.equal(level('a'), 1);
  assert.equal(level('b'), 2);
  assert.equal(level('c'), 3);
  assert.equal(level('d'), 2, 'b has ended, so d takes its level');
  assert.equal(level('e'), 1, 'a has ended, so e takes the lowest free level below the parent');
  assert.equal(p.levelCount, 4);
  assertNoOverlap(p);
});

test('a child is strictly below its parent in the same lane, even when concurrency is high', () => {
  const kids: TreeNode[] = [];
  for (let i = 0; i < 6; i++) kids.push({ id: `k${i}`, start: i, end: 50 + i, children: [{ id: `g${i}`, start: i + 1, end: 20 + i }] });
  const p = packTree({ id: 'root', start: 0, end: 100, children: kids });
  const t = p.index.table;
  for (let r = 0; r < t.length; r++) {
    if (t.parent[r] >= 0) assert.ok(p.levels[r] > p.levels[t.parent[r]], `row ${r} is not below its parent`);
  }
  assertNoOverlap(p);
});

test('a child that starts before its parent (clock skew) is still placed below it without overlap', () => {
  const p = packAll(buildSpanIndex(trace(['svc', [
    span('other', undefined, 0, 12),
    span('parent', undefined, 10, 50),
    span('child', 'parent', 5, 30),
    span('late', undefined, 40, 60),
  ]])));
  const level = (id: string): number => p.levels[p.rowOf(id)];
  assert.ok(level('child') > level('parent'));
  assertNoOverlap(p);
});

test('instants at the same moment stack instead of hiding each other', () => {
  const p = packAll(buildSpanIndex(trace(['svc', [
    span('a', undefined, 10, 10),
    span('b', undefined, 10, 10),
    span('c', undefined, 10, 10),
    span('d', undefined, 11, 11),
    span('inverted', undefined, 20, 15),
    span('after', undefined, 20, 21),
  ]])));
  const level = (id: string): number => p.levels[p.rowOf(id)];
  assert.deepEqual([level('a'), level('b'), level('c')].sort(), [0, 1, 2]);
  assert.equal(level('d'), 0, 'a later instant reuses a free level');
  assert.notEqual(level('inverted'), level('after'));
  assertNoOverlap(p);
});

test('a span whose parent is in another lane starts at level 0 of its own lane', () => {
  const index = buildSpanIndex(trace(
    ['front', [span('f', undefined, 0, 100)]],
    ['back', [span('b1', 'f', 10, 90), span('b2', 'b1', 20, 80)]],
  ));
  const t = index.table;
  const laneOfRow = Int32Array.from(t.svc);
  const levels = new Int32Array(t.length).fill(-1);
  const scratch = createPackScratch(t.length);
  for (let lane = 0; lane < t.services.length; lane++) {
    const rows = Int32Array.from({ length: t.length }, (_, r) => r).filter(r => laneOfRow[r] === lane);
    packLevels(rows, t.start, t.end, { parent: t.parent, laneOfRow, lane }, levels, scratch);
  }
  const level = (id: string): number => levels[index.table.ids.indexOf(id)];
  assert.equal(level('f'), 0);
  assert.equal(level('b1'), 0);
  assert.equal(level('b2'), 1);
});

test('without a constraint spans are packed as plain intervals', () => {
  const start = Float64Array.of(0, 5, 10, 12);
  const end = Float64Array.of(10, 15, 20, 14);
  const levels = new Int32Array(4);
  const rows = Int32Array.of(0, 1, 2, 3);
  const count = packLevels(rows, start, end, null, levels, createPackScratch(4));
  assert.deepEqual([...levels], [0, 1, 0, 2]);
  assert.equal(count, 3);
});

test('random lanes: no overlap, children below parents, level count at least the peak overlap', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rnd = random(seed);
    const spans: Span[] = [];
    for (let i = 0; i < 300; i++) {
      const parent = i > 0 && rnd() < 0.6 ? `s${Math.floor(rnd() * i)}` : undefined;
      const s = Math.floor(rnd() * 400);
      const dur = rnd() < 0.1 ? 0 : Math.floor(rnd() * 60);
      spans.push(span(`s${i}`, parent, s, s + dur));
    }
    const p = packAll(buildSpanIndex(trace(['svc', spans])));
    const t = p.index.table;
    assertNoOverlap(p);
    for (let r = 0; r < t.length; r++) {
      if (t.parent[r] >= 0) assert.ok(p.levels[r] > p.levels[t.parent[r]]);
    }
    let peak = 0;
    for (let r = 0; r < t.length; r++) {
      let open = 0;
      for (let q = 0; q < t.length; q++) if (t.start[q] <= t.start[r] && t.end[q] > t.start[r]) open++;
      peak = Math.max(peak, open);
    }
    assert.ok(p.levelCount >= peak, `seed ${seed}: ${p.levelCount} levels for peak ${peak}`);
  }
});

test('packing sorts the rows into placement order, ascending in start within every level', () => {
  const p = packTree({ id: 'root', start: 0, end: 100, children: [{ id: 'a', start: 10, end: 20 }, { id: 'b', start: 30, end: 40 }] });
  const t = p.index.table;
  const rows = Int32Array.from({ length: t.length }, (_, r) => r);
  const levels = new Int32Array(t.length);
  packLevels(rows, t.start, t.end, { parent: t.parent, laneOfRow: new Int32Array(t.length), lane: 0 }, levels, createPackScratch(t.length));
  for (let k = 1; k < rows.length; k++) assert.ok(t.start[rows[k]] >= t.start[rows[k - 1]]);
});
