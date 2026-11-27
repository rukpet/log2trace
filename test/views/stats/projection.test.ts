import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex } from '../../../src/core/index.ts';
import { computeSpanTimings } from '../../../src/core/self-time.ts';
import { buildStatsAggregation } from '../../../src/views/stats/model/aggregate.ts';
import {
  DisplayRowKind,
  columnsForMode,
  findDisplayRowForSpan,
  normalizeSortColumn,
  projectStatsRows,
} from '../../../src/views/stats/model/projection.ts';
import { span, trace } from '../../support/trace-builder.ts';

function buildIndex() {
  return buildSpanIndex(
    trace(
      ['api', [span('root', undefined, 0, 100, { name: 'GET /items', kind: SpanKind.Server })]],
      [
        'db',
        [
          span('q1', 'root', 10, 20, { name: 'SELECT', kind: SpanKind.Client }),
          span('q2', 'root', 25, 75, { name: 'SELECT', kind: SpanKind.Client, status: { code: 2 } }),
        ],
      ],
      ['cache', [span('c1', 'root', 80, 95, { name: 'GET key', kind: SpanKind.Client })]],
    ),
  );
}

test('sorts groups by selected column and splices expanded member spans inline', () => {
  const index = buildIndex();
  const timings = computeSpanTimings(index, null);
  const agg = buildStatsAggregation(index, timings, null, 'service-operation', true);

  // Self times: db/SELECT = 60ms, api/GET /items = 25ms, cache/GET key = 15ms
  const collapsed = projectStatsRows(agg, 'self', 'desc', new Set());
  assert.equal(collapsed.rowCount, 3);
  assert.deepEqual(
    [0, 1, 2].map((i) => agg.label[collapsed.rowIndex[i]]),
    ['SELECT', 'GET /items', 'GET key'],
  );

  // Expand db/SELECT group
  const dbGroup = collapsed.rowIndex[0];
  const expanded = projectStatsRows(agg, 'self', 'desc', new Set([agg.groupKeys[dbGroup]]));
  assert.equal(expanded.rowCount, 5);
  assert.equal(expanded.rowKind[0], DisplayRowKind.Group);
  assert.equal(expanded.rowKind[1], DisplayRowKind.Span);
  assert.equal(expanded.rowKind[2], DisplayRowKind.Span);
  assert.equal(expanded.parentGroup[1], dbGroup);
  assert.equal(expanded.parentGroup[2], dbGroup);
  // Members sorted by self desc: q2 (50ms) before q1 (10ms)
  assert.equal(index.table.ids[expanded.rowIndex[1]], 'q2');
  assert.equal(index.table.ids[expanded.rowIndex[2]], 'q1');

  // findDisplayRowForSpan returns direct span row when expanded, else owning group row
  const q1Row = index.spans.get('q1')?.idx ?? -1;
  assert.equal(findDisplayRowForSpan(expanded, q1Row), 2);
  assert.equal(findDisplayRowForSpan(collapsed, q1Row), 0);
});

test('projects flat spans mode and normalizes incompatible sort columns across modes', () => {
  const index = buildIndex();
  const timings = computeSpanTimings(index, null);
  const flatAgg = buildStatsAggregation(index, timings, null, 'none', true);

  assert.equal(columnsForMode('none').length, 7);
  assert.equal(columnsForMode('service-operation').length, 10);
  assert.equal(normalizeSortColumn('none', 'p95'), 'total');
  assert.equal(normalizeSortColumn('none', 'count'), 'self');
  assert.equal(normalizeSortColumn('service-operation', 'start'), 'self');

  const proj = projectStatsRows(flatAgg, 'p95', 'desc', new Set());
  assert.equal(proj.sort, 'total');
  assert.equal(proj.rowCount, 4);
  // Durations desc: root (100), q2 (50), c1 (15), q1 (10)
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => index.table.ids[proj.rowIndex[i]]),
    ['root', 'q2', 'c1', 'q1'],
  );
});
