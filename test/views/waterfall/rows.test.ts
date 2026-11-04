/**
 * Row projection: collapse, filter and context rows, against a naive recursive reference.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, SpanMask, type SpanIndex } from '../../../src/core.ts';
import { Chevron, chevronOf, projectRows, type RowProjection } from '../../../src/views/waterfall/model/rows.ts';
import { demoLogsIndex } from '../../support/demo-data.ts';
import { random, span, trace, treeTrace, type TreeNode } from '../../support/trace-builder.ts';

//   a
//   ├ b
//   │ ├ c
//   │ └ d
//   └ e
//     └ f
//   g
const TREE: TreeNode[] = [
  { id: 'a', start: 0, end: 100, children: [
    { id: 'b', start: 1, end: 50, children: [{ id: 'c', start: 2, end: 10 }, { id: 'd', start: 11, end: 20 }] },
    { id: 'e', start: 51, end: 90, children: [{ id: 'f', start: 52, end: 60 }] },
  ] },
  { id: 'g', start: 120, end: 130 },
];

function ids(index: SpanIndex, projection: RowProjection): string[] {
  return Array.from(projection.rows, (row) => index.table.ids[row]);
}

function mask(index: SpanIndex, spanIds: Iterable<string>): SpanMask {
  return SpanMask.of(index, spanIds);
}

test('without collapse or filter every span has a row, in depth-first order', () => {
  const index = buildSpanIndex(treeTrace(TREE));
  const rows = projectRows(index, null, null);

  assert.equal(rows.count, 7);
  assert.deepEqual(ids(index, rows), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(Array.from(rows.rowOf), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(rows.context), [0, 0, 0, 0, 0, 0, 0]);
});

test('collapsing a span hides its whole subtree and nothing else', () => {
  const index = buildSpanIndex(treeTrace(TREE));

  const one = projectRows(index, mask(index, ['b']), null);
  assert.deepEqual(ids(index, one), ['a', 'b', 'e', 'f', 'g']);
  assert.deepEqual(Array.from(one.rowOf), [0, 1, -1, -1, 2, 3, 4]);

  const nested = projectRows(index, mask(index, ['a', 'b']), null);
  assert.deepEqual(ids(index, nested), ['a', 'g'], 'a collapsed parent hides an also-collapsed child');

  const all = projectRows(index, mask(index, ['a', 'b', 'e']), null);
  assert.deepEqual(ids(index, all), ['a', 'g']);
});

test('a filter keeps the matches and their ancestors, the ancestors as context rows', () => {
  const index = buildSpanIndex(treeTrace(TREE));
  const rows = projectRows(index, null, mask(index, ['d', 'f']));

  assert.deepEqual(ids(index, rows), ['a', 'b', 'd', 'e', 'f']);
  assert.deepEqual(Array.from(rows.context), [1, 1, 0, 1, 0]);
  assert.deepEqual(Array.from(rows.rowOf), [0, 1, -1, 2, 3, 4, -1]);
});

test('a match that also has matching descendants is not context', () => {
  const index = buildSpanIndex(treeTrace(TREE));
  const rows = projectRows(index, null, mask(index, ['b', 'c']));

  assert.deepEqual(ids(index, rows), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(rows.context), [1, 0, 0]);
});

test('collapsing hides matches below the collapsed span, filter or not', () => {
  const index = buildSpanIndex(treeTrace(TREE));
  const rows = projectRows(index, mask(index, ['b']), mask(index, ['c', 'f']));

  assert.deepEqual(ids(index, rows), ['a', 'b', 'e', 'f']);
  assert.deepEqual(Array.from(rows.context), [1, 1, 1, 0]);
});

test('a filter with no match leaves no rows, and one that matches everything changes nothing', () => {
  const index = buildSpanIndex(treeTrace(TREE));

  const none = projectRows(index, null, mask(index, []));
  assert.equal(none.count, 0);
  assert.equal(none.rows.length, 0);
  assert.deepEqual(Array.from(none.rowOf), new Array(7).fill(-1));

  const everything = projectRows(index, null, mask(index, ['a', 'b', 'c', 'd', 'e', 'f', 'g']));
  assert.deepEqual(ids(index, everything), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(everything.context.every((flag) => flag === 0), true);
});

test('an empty trace has no rows', () => {
  const index = buildSpanIndex({ resourceSpans: [] });
  const rows = projectRows(index, SpanMask.empty(index), null);
  assert.equal(rows.count, 0);
  assert.equal(rows.rowOf.length, 0);
});

test('a mask of another trace is refused', () => {
  const index = buildSpanIndex(treeTrace(TREE));
  const other = buildSpanIndex(trace(['svc', [span('x', undefined, 0, 1)]]));
  assert.throws(() => projectRows(index, SpanMask.empty(other), null), /collapsed mask has 1 rows, the trace has 7/);
  assert.throws(() => projectRows(index, null, SpanMask.empty(other)), /match mask has 1 rows, the trace has 7/);
});

test('chevrons: collapsed, expanded, or none for leaves and for spans whose children are filtered out', () => {
  const index = buildSpanIndex(treeTrace(TREE));
  const chevrons = (collapsed: SpanMask | null, matched: SpanMask | null): number[] => {
    const rows = projectRows(index, collapsed, matched);
    return Array.from({ length: rows.count }, (_, row) => chevronOf(index, rows, collapsed, row));
  };

  assert.deepEqual(chevrons(null, null), [
    Chevron.Expanded, Chevron.Expanded, Chevron.None, Chevron.None, Chevron.Expanded, Chevron.None, Chevron.None,
  ]);
  assert.deepEqual(chevrons(mask(index, ['b', 'e']), null), [
    Chevron.Expanded, Chevron.Collapsed, Chevron.Collapsed, Chevron.None,
  ]);
  // b matches, but neither of its children does: it is shown without a chevron
  assert.deepEqual(chevrons(null, mask(index, ['b'])), [Chevron.Expanded, Chevron.None]);
});

// -- differential test ------------------------------------------------------------------------

interface ReferenceRow {
  readonly id: string;
  readonly context: boolean;
}

/** The rows by plain recursion over `childrenOf`, written for clarity rather than speed. */
function referenceRows(index: SpanIndex, collapsed: ReadonlySet<string>, matched: ReadonlySet<string> | null): ReferenceRow[] {
  const holdsMatch = (id: string): boolean =>
    matched === null || matched.has(id) || (index.childrenOf.get(id) ?? []).some(holdsMatch);
  const rows: ReferenceRow[] = [];
  const walk = (spanIds: readonly string[]): void => {
    for (const id of spanIds) {
      if (!holdsMatch(id)) continue;
      rows.push({ id, context: matched !== null && !matched.has(id) });
      if (!collapsed.has(id)) walk(index.childrenOf.get(id) ?? []);
    }
  };
  walk(index.roots);
  return rows;
}

test('random trees: rows, rowOf and context agree with the recursive reference', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const next = random(seed);
    const count = 600;
    const spans = [];
    for (let i = 0; i < count; i++) {
      const parent = i === 0 || next() < 0.04 ? undefined : `s${Math.floor(next() * i)}`;
      spans.push(span(`s${i}`, parent, i, i + 1 + next() * 5));
    }
    const index = buildSpanIndex(trace(['svc', spans]));

    for (const [collapseShare, matchShare] of [[0, null], [0.1, null], [0.5, null], [0, 0.05], [0.1, 0.3], [0.3, 0.02], [0, 1]] as const) {
      const collapsedIds = new Set(index.table.ids.filter(() => next() < collapseShare));
      const matchedIds = matchShare === null ? null : new Set(index.table.ids.filter(() => next() < matchShare));
      // collapsing a leaf is not possible in the store, so keep the masks as the store would
      const collapsedMask = SpanMask.of(index, [...collapsedIds].filter((id) => index.childrenOf.has(id)));
      const matchedMask = matchedIds === null ? null : SpanMask.of(index, matchedIds);

      const rows = projectRows(index, collapsedMask, matchedMask);
      const expected = referenceRows(index, new Set(collapsedMask), matchedIds);

      assert.deepEqual(ids(index, rows), expected.map((row) => row.id), `seed ${seed}, ${collapseShare}/${matchShare}`);
      assert.deepEqual(Array.from(rows.context, Boolean), expected.map((row) => row.context));

      // rowOf is the inverse of rows, -1 elsewhere
      let shown = 0;
      for (let tableRow = 0; tableRow < index.size; tableRow++) {
        const row = rows.rowOf[tableRow];
        if (row >= 0) {
          shown++;
          assert.equal(rows.rows[row], tableRow);
        }
      }
      assert.equal(shown, rows.count);
    }
  }
});

test('demo/logs.json: collapsing the first root leaves the two roots', () => {
  const index = demoLogsIndex();
  const rows = projectRows(index, SpanMask.of(index, [index.roots[0]]), null);
  assert.equal(rows.count, 2);
  assert.deepEqual(ids(index, rows), [...index.roots]);
});

test('projecting 50000 rows takes well under a few milliseconds', () => {
  const spans = [];
  for (let i = 0; i < 50_000; i++) spans.push(span(`s${i}`, i === 0 ? undefined : `s${Math.floor((i - 1) / 4)}`, i, i + 3));
  const index = buildSpanIndex(trace(['svc', spans]));
  const collapsed = SpanMask.of(index, ['s1', 's2', 's7']);
  const matched = SpanMask.of(index, index.table.ids.filter((_, row) => row % 97 === 0));

  const started = performance.now();
  for (let run = 0; run < 20; run++) {
    projectRows(index, collapsed, null);
    projectRows(index, collapsed, matched);
  }
  const perProjection = (performance.now() - started) / 40;

  assert.ok(perProjection < 25, `a projection took ${perProjection.toFixed(2)} ms`);
});
