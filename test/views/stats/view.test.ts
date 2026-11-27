import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, buildSpanIndex, createTraceStore } from '../../../src/core/index.ts';
import { StatsController } from '../../../src/views/stats/controller.ts';
import { span, trace } from '../../support/trace-builder.ts';

test('StatsController revealSpan locates span directly or via owning group and scrolls into view', () => {
  const spans = [];
  for (let i = 0; i < 40; i++) {
    spans.push(span(`s-${i}`, undefined, i * 10, i * 10 + (i + 1), { name: `op-${i}`, kind: SpanKind.Internal }));
  }
  const index = buildSpanIndex(trace(['worker', spans]));
  const store = createTraceStore();
  store.setData(index);
  store.flushSync();

  let scrolledTo = 0;
  const controller = new StatsController({
    store,
    origin: 'stats-test',
    onScrollTo: (top) => {
      scrolledTo = top;
    },
  });
  controller.setViewport(800, 180);
  controller.ensureProjection();

  // op-0 has shortest selfTime (1ms), so under default self desc it sits at row 39
  controller.revealSpan('s-0');
  assert.equal(controller.viewState.focusRow, 39);
  assert.ok(scrolledTo > 0, 'revealing a bottom row scrolls down');
});
