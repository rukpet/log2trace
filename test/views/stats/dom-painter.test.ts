import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SPAN_SET, SpanKind, buildSpanIndex } from '../../../src/core/index.ts';
import { computeSpanTimings } from '../../../src/core/self-time.ts';
import { buildStatsAggregation } from '../../../src/views/stats/model/aggregate.ts';
import { projectStatsRows } from '../../../src/views/stats/model/projection.ts';
import { createStatsDomPainter, type StatsDomClasses } from '../../../src/views/stats/paint/dom.ts';
import { FakeElement, installFakeDom } from '../../support/fake-dom-tree.ts';
import { span, trace } from '../../support/trace-builder.ts';

const CLASSES: StatsDomClasses = {
  canvas: 'canvas',
  header: 'header',
  headerGridGrouped: 'grid-grouped',
  headerGridFlat: 'grid-flat',
  headerCell: 'hcell',
  headerCellSticky: 'hcell-sticky',
  headerCellRight: 'hcell-right',
  headerCellSorted: 'hcell-sorted',
  sortIndicator: 'sort-ind',
  body: 'body',
  row: 'row',
  rowChild: 'row-child',
  rowHovered: 'row-hover',
  rowSelected: 'row-selected',
  rowDimmed: 'row-dim',
  cell: 'cell',
  cellIdentity: 'cell-id',
  cellIdentityChild: 'cell-id-child',
  cellMetric: 'cell-metric',
  cellText: 'cell-text',
  chevron: 'chevron',
  kindDot: 'kind-dot',
  kindColor: { '0': 'k0', '1': 'k1', '2': 'k2', '3': 'k3', '4': 'k4', '5': 'k5' },
  primaryLabel: 'primary',
  secondaryLabel: 'secondary',
  metricValue: 'mval',
  mutedValue: 'muted',
  errorValue: 'err',
  barTrack: 'bar-track',
  barFillSelf: 'bar-self',
  barFillTotal: 'bar-total',
  emptyNotice: 'empty-notice',
};

test('paints grouped and flat rows using a virtualized DOM pool', () => {
  const restore = installFakeDom();
  try {
    const index = buildSpanIndex(
      trace(
        ['api', [span('r', undefined, 0, 100, { name: 'GET /items', kind: SpanKind.Server })]],
        [
          'db',
          [
            span('q1', 'r', 10, 30, { name: 'SELECT', kind: SpanKind.Client }),
            span('q2', 'r', 35, 85, { name: 'SELECT', kind: SpanKind.Client, status: { code: 2 } }),
          ],
        ],
      ),
    );
    const timings = computeSpanTimings(index, null);
    const agg = buildStatsAggregation(index, timings, null, 'service-operation', true);
    const proj = projectStatsRows(agg, 'self', 'desc', new Set());

    const host = new FakeElement('div');
    const painter = createStatsDomPainter({ host: host as unknown as HTMLElement }, CLASSES);
    painter.paint({
      projection: proj,
      rowHeight: 28,
      scrollTop: 0,
      viewportHeight: 300,
      expandedGroups: new Set(),
      selectedIds: new Set(['q2']),
      hoveredRow: -1,
      matched: null,
      matchesOnly: true,
    });

    const headers = host.findAll('hcell');
    assert.equal(headers.length, 10);
    assert.equal(headers[3].getAttribute('aria-sort'), 'descending');

    const rows = host.findAll('row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute('aria-selected'), 'true');
    assert.equal(rows[0].findAll('primary')[0].textContent, 'SELECT');
    assert.equal(rows[0].findAll('secondary')[0].textContent, 'db');

    // Switch to flat Spans mode and reuse pooled rows
    const flatAgg = buildStatsAggregation(index, timings, null, 'none', true);
    const flatProj = projectStatsRows(flatAgg, 'total', 'desc', new Set());
    painter.paint({
      projection: flatProj,
      rowHeight: 28,
      scrollTop: 0,
      viewportHeight: 300,
      expandedGroups: new Set(),
      selectedIds: EMPTY_SPAN_SET,
      hoveredRow: 0,
      matched: null,
      matchesOnly: true,
    });

    assert.equal(host.findAll('hcell').length, 7);
    assert.equal(painter.stats().visibleRows, 3);
    assert.equal(painter.stats().poolSize, 3);

    painter.destroy();
  } finally {
    restore();
  }
});
