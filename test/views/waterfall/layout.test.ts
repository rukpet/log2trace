/**
 * Layout metrics and the row/pixel arithmetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHEVRON_SIZE,
  DEFAULT_METRICS,
  GUTTER_PADDING,
  LABEL_GAP,
  MIN_INDENT,
  chevronX,
  computeLayout,
  labelWidth,
  labelX,
  listMetrics,
  metricsFromSpanSizes,
  resolveMetrics,
  rowAt,
  rowTop,
} from '../../../src/views/waterfall/model/layout.ts';

test('defaults match the old element: 30 px bars in 35 px rows, a 40 px ruler, a 250 px gutter', () => {
  assert.deepEqual(resolveMetrics(), DEFAULT_METRICS);
  assert.equal(DEFAULT_METRICS.rowHeight, 35);
  assert.equal(DEFAULT_METRICS.barHeight, 30);
  assert.equal(DEFAULT_METRICS.headerHeight, 40);
  assert.equal(DEFAULT_METRICS.gutterWidth, 250);
});

test('resolveMetrics keeps valid overrides and replaces everything else with the default', () => {
  assert.deepEqual(resolveMetrics({ rowHeight: 28, barHeight: 24, gutterWidth: 300 }), {
    ...DEFAULT_METRICS, rowHeight: 28, barHeight: 24, gutterWidth: 300,
  });
  assert.deepEqual(
    resolveMetrics({ rowHeight: -5, barHeight: Number.NaN, headerHeight: Infinity, gutterWidth: -1, maxIndent: 0 }),
    DEFAULT_METRICS,
  );
  assert.equal(resolveMetrics({ rowHeight: 20, barHeight: 50 }).barHeight, 20, 'a bar cannot be taller than its row');
  assert.equal(resolveMetrics({ headerHeight: 0 }).headerHeight, 0, 'no ruler is allowed');
});

test('metricsFromSpanSizes turns span-height and span-padding into bar and row heights', () => {
  assert.deepEqual(metricsFromSpanSizes(30, 5), { barHeight: 30, rowHeight: 35 });
  assert.deepEqual(metricsFromSpanSizes(24, 0), { barHeight: 24, rowHeight: 24 });
  assert.deepEqual(metricsFromSpanSizes(0, -3), { barHeight: 30, rowHeight: 35 }, 'bad numbers fall back');
});

test('computeLayout splits the view into gutter, plot and body', () => {
  const layout = computeLayout(DEFAULT_METRICS, 1000, 600, 0);

  assert.equal(layout.width, 1000);
  assert.equal(layout.height, 600);
  assert.equal(layout.gutterWidth, 250);
  assert.equal(layout.plotLeft, 250);
  assert.equal(layout.plotWidth, 1000 - 250 - 24);
  assert.equal(layout.headerHeight, 40);
  assert.equal(layout.bodyHeight, 560);
  assert.equal(layout.barInset, 2.5);
  assert.equal(layout.indentStep, 20);
});

test('on a narrow view the gutter gives way, to half of the view at most', () => {
  const layout = computeLayout(DEFAULT_METRICS, 300, 400, 0);
  assert.equal(layout.gutterWidth, 150);
  assert.equal(layout.plotWidth, 300 - 150 - 24);

  const tiny = computeLayout(DEFAULT_METRICS, 40, 30, 0);
  assert.equal(tiny.gutterWidth, 20);
  assert.equal(tiny.plotWidth, 0);
  assert.equal(tiny.bodyHeight, 0, 'a view shorter than the ruler has no body');
});

test('a view with no size gives zeros, never NaN', () => {
  for (const [width, height] of [[0, 0], [-10, 5], [Number.NaN, Number.NaN], [Infinity, Infinity]]) {
    const layout = computeLayout(DEFAULT_METRICS, width, height, 12);
    for (const [key, value] of Object.entries(layout)) {
      assert.ok(Number.isFinite(value), `${key} is ${value} for a ${width}x${height} view`);
    }
    assert.equal(layout.plotWidth, 0);
    assert.equal(layout.gutterWidth, 0);
  }
});

test('the indent per level shrinks with depth so the deepest label keeps room', () => {
  const step = (maxDepth: number): number => computeLayout(DEFAULT_METRICS, 1000, 600, maxDepth).indentStep;

  assert.equal(step(0), 20);
  assert.equal(step(3), 20, 'a shallow trace keeps the full indent');
  assert.equal(step(30), (250 / 2 - 36) / 30);
  assert.equal(step(1000), MIN_INDENT, 'but never less than the minimum');
});

test('rows are placed below the ruler and scroll under it', () => {
  const layout = computeLayout(DEFAULT_METRICS, 1000, 600, 0);

  assert.equal(rowTop(layout, 0, 0), 40);
  assert.equal(rowTop(layout, 3, 0), 40 + 3 * 35);
  assert.equal(rowTop(layout, 3, 50), 40 + 3 * 35 - 50);
  assert.deepEqual(listMetrics(layout, 7), { rowHeight: 35, rowCount: 7, viewportHeight: 560 });
});

test('rowAt finds the row under a y coordinate', () => {
  const layout = computeLayout(DEFAULT_METRICS, 1000, 600, 0);

  assert.equal(rowAt(layout, 10, 0, 0), -1, 'the ruler is not a row');
  assert.equal(rowAt(layout, 10, 39.9, 0), -1);
  assert.equal(rowAt(layout, 10, 40, 0), 0);
  assert.equal(rowAt(layout, 10, 74.9, 0), 0);
  assert.equal(rowAt(layout, 10, 75, 0), 1);
  assert.equal(rowAt(layout, 10, 40, 50), 1, 'scrolling moves the rows under the pointer');
  assert.equal(rowAt(layout, 3, 599, 0), -1, 'below the last row there is nothing');
  assert.equal(rowAt(layout, 2, 40 + 2 * 35, 0), -1, 'one past the last row');
  assert.equal(rowAt(layout, 2, 40 + 2 * 35 - 0.1, 0), 1);
  assert.equal(rowAt(layout, 10, 600, 0), -1, 'outside the view');
  assert.equal(rowAt(layout, 10, Number.NaN, 0), -1);
  assert.equal(rowAt(layout, 0, 50, 0), -1, 'no rows at all');
});

test('gutter geometry: the chevron box, the label and the room it has', () => {
  const layout = computeLayout(DEFAULT_METRICS, 1000, 600, 4);

  assert.equal(chevronX(layout, 0), GUTTER_PADDING);
  assert.equal(chevronX(layout, 3), GUTTER_PADDING + 3 * layout.indentStep);
  assert.equal(labelX(layout, 0), GUTTER_PADDING + CHEVRON_SIZE + LABEL_GAP);
  assert.equal(labelWidth(layout, 0), 250 - labelX(layout, 0) - GUTTER_PADDING);
  assert.equal(labelWidth(layout, 100000), 0, 'never negative');

  const deepest = computeLayout(DEFAULT_METRICS, 1000, 600, 30);
  assert.ok(Math.abs(labelWidth(deepest, 30) - 250 / 2) < 1e-9, 'the deepest label keeps half of the gutter');
});
