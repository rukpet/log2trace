import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanMask, buildSpanIndex, createTraceStore } from '../../../src/core/index.ts';
import { StatsController, StatsDirty } from '../../../src/views/stats/controller.ts';
import { DisplayRowKind } from '../../../src/views/stats/model/projection.ts';
import { span, trace } from '../../support/trace-builder.ts';

function setup() {
  const index = buildSpanIndex(
    trace(
      ['api', [span('root', undefined, 0, 100, { name: 'GET /orders', kind: SpanKind.Server })]],
      [
        'db',
        [
          span('q1', 'root', 10, 30, { name: 'SELECT', kind: SpanKind.Client }),
          span('q2', 'root', 35, 85, { name: 'SELECT', kind: SpanKind.Client, status: { code: 2 } }),
        ],
      ],
    ),
  );
  const store = createTraceStore();
  store.setData(index);
  store.flushSync();

  const scrolls: Array<{ top: number; left?: number }> = [];
  const controller = new StatsController({
    store,
    origin: 'stats-1',
    onScrollTo: (top, left) => scrolls.push({ top, left }),
  });
  controller.setViewport(800, 300);
  return { index, store, controller, scrolls };
}

test('selectDisplayRow syncs group and member spans to TraceStore', () => {
  const { store, controller } = setup();
  const proj = controller.ensureProjection();
  assert.equal(proj.rowCount, 2);

  // Row 0 is db/SELECT (self = 70ms > api/GET /orders self = 30ms)
  controller.selectDisplayRow(0);
  assert.deepEqual([...store.state.selection.ids].sort(), ['q1', 'q2']);
  assert.equal(store.state.selection.primary, 'q2');

  // Expand group 0 and select member span q1
  controller.toggleGroupExpanded(proj.rowIndex[0]);
  const expanded = controller.ensureProjection();
  assert.equal(expanded.rowCount, 4);
  assert.equal(expanded.rowKind[2], DisplayRowKind.Span);
  controller.selectDisplayRow(2);
  assert.deepEqual([...store.state.selection.ids], ['q1']);
  assert.equal(store.state.selection.primary, 'q1');
});

test('keyboard navigation expands, descends, collapses, and clears selection', () => {
  const { store, controller } = setup();
  controller.ensureProjection();

  controller.handleNavigationKey('ArrowDown');
  assert.equal(controller.viewState.focusRow, 0);

  // ArrowRight expands group 0
  controller.handleNavigationKey('ArrowRight');
  assert.equal(controller.ensureProjection().rowCount, 4);

  // Second ArrowRight moves into first member span
  controller.handleNavigationKey('ArrowRight');
  assert.equal(controller.viewState.focusRow, 1);

  // ArrowLeft from member span jumps back to parent group
  controller.handleNavigationKey('ArrowLeft');
  assert.equal(controller.viewState.focusRow, 0);

  // ArrowLeft on expanded group collapses it
  controller.handleNavigationKey('ArrowLeft');
  assert.equal(controller.ensureProjection().rowCount, 2);

  // Escape clears selection
  const esc = controller.handleNavigationKey('Escape');
  assert.equal(esc.handled, true);
  assert.equal(store.state.selection.ids.size, 0);
});

test('supports toolbar actions, filter toggling, and getState/setState round-trip', () => {
  const { index, store, controller } = setup();
  store.setMatched(SpanMask.of(index, ['q2']));
  store.flushSync();
  controller.handleStoreChange({ mask: 16, origin: 'shell', prev: store.state });

  // Matches only ON: 1 group, 1 span
  assert.equal(controller.ensureProjection().rowCount, 1);
  assert.equal(controller.summaryReadout(), '1 group · 1 span');

  // Toggle to dim: 2 groups, 3 spans
  controller.toggleMatchesOnly();
  assert.equal(controller.matchesOnlyReadout(), 'dim');
  assert.equal(controller.ensureProjection().rowCount, 2);

  // Cycle group-by and sort
  controller.cycleGroupBy();
  assert.equal(controller.viewState.groupBy, 'service');
  controller.toggleSort('errors');
  assert.equal(controller.viewState.sort, 'errors');
  assert.equal(controller.viewState.sortDir, 'desc');

  const saved = controller.getState();
  const restored = new StatsController({ store, origin: 'stats-2' });
  restored.setViewport(800, 300);
  restored.setState(saved);
  assert.equal(restored.viewState.groupBy, 'service');
  assert.equal(restored.viewState.sort, 'errors');
  assert.equal(restored.viewState.matchesOnly, false);

  // Reset restores defaults
  const dirty = restored.resetToDefaults();
  assert.equal(dirty, StatsDirty.All);
  assert.equal(restored.viewState.groupBy, 'service-operation');
  assert.equal(restored.viewState.sort, 'self');
  assert.equal(restored.viewState.matchesOnly, true);
});

test('toggleSort resets scrollTop to 0 and applySettings overrides interactive state even when matching prior default', () => {
  const spans = [];
  for (let i = 0; i < 40; i++) {
    spans.push(span(`s-${i}`, undefined, i * 10, i * 10 + (i + 1), { name: `op-${i}`, kind: SpanKind.Internal }));
  }
  const index = buildSpanIndex(trace(['worker', spans]));
  const store = createTraceStore();
  store.setData(index);
  store.flushSync();

  const controller = new StatsController({ store, origin: 'stats-sort' });
  controller.setViewport(800, 180);
  controller.ensureProjection();

  // Clicking sort with focusRow === -1 must keep scrollTop at 0 instead of chasing old row 0
  controller.toggleSort('self');
  assert.equal(controller.viewState.scrollTop, 0);
  controller.setScroll(200, 0);
  controller.toggleSort('name');
  assert.equal(controller.viewState.scrollTop, 0);

  // User cycles groupBy interactively, then host applies settings back to prior default ('service-operation')
  controller.cycleGroupBy();
  assert.equal(controller.viewState.groupBy, 'service');
  controller.applySettings({
    groupBy: 'service-operation',
    sort: 'self',
    sortDir: 'desc',
    matchesOnly: true,
    rowHeight: 28,
  });
  assert.equal(controller.viewState.groupBy, 'service-operation');
  assert.equal(controller.viewState.sort, 'self');
});
