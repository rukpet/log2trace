/**
 * Unit tests for sequence view settings and layout geometry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewOptions } from '../../../src/kit/view-options.ts';
import {
  DEFAULT_SEQUENCE_SETTINGS,
  readSequenceSettings,
} from '../../../src/views/sequence/settings.ts';
import {
  ACT_W,
  CANVAS_PAD_X,
  CANVAS_PAD_Y,
  COL_W,
  GUTTER_W,
  HEADER_H,
  MAX_COL_W,
  MAX_NEST,
  MIN_COL_W,
  NEST_DX,
  ROW_H_DEFAULT,
  ROW_H_MAX,
  ROW_H_MIN,
  SELF_LOOP_W,
  activationBoxX,
  columnAtContentX,
  computeSequenceLayout,
  detectTimeGaps,
  lifelineCenterX,
  stepAtBodyY,
  stepRowY,
} from '../../../src/views/sequence/model/layout.ts';

function makeOptions(
  config: Record<string, unknown> = {},
  attrs: Record<string, string> = {},
): ViewOptions {
  return {
    config,
    attribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? (attrs[name] ?? null) : null;
    },
  };
}

test('readSequenceSettings returns DEFAULT_SEQUENCE_SETTINGS when nothing is configured', () => {
  const settings = readSequenceSettings(makeOptions());
  assert.deepEqual(settings, DEFAULT_SEQUENCE_SETTINGS);
  assert.equal(settings.internal, 'auto');
  assert.equal(settings.returns, 'all');
  assert.equal(settings.foldMin, 3);
  assert.equal(settings.rowHeight, 28);
  assert.equal(settings.wheelZoom, false);
});

test('readSequenceSettings reads internal and returns from attributes and config', () => {
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-internal': 'hide' })).internal, 'hide');
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-internal': 'show' })).internal, 'show');
  assert.equal(readSequenceSettings(makeOptions({ sequenceInternal: 'hide' })).internal, 'hide');
  assert.equal(readSequenceSettings(makeOptions({ sequenceInternal: 'invalid' })).internal, 'auto');
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-internal': 'bogus' })).internal, 'auto');

  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-returns': 'errors' })).returns, 'errors');
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-returns': 'none' })).returns, 'none');
  assert.equal(readSequenceSettings(makeOptions({ sequenceReturns: 'errors' })).returns, 'errors');
  assert.equal(readSequenceSettings(makeOptions({ sequenceReturns: 'bogus' })).returns, 'all');
});

test('readSequenceSettings reads and clamps foldMin', () => {
  assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 0 })).foldMin, 0, '0 disables folding');
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '0' })).foldMin, 0);
  assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 1 })).foldMin, 2, '< 2 and !== 0 clamps to 2');
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '1' })).foldMin, 2);
  assert.equal(readSequenceSettings(makeOptions({ sequenceFold: -4 })).foldMin, 0, 'negative clamps to 0');
  assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 5.9 })).foldMin, 5, 'floors to integer');
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '4' })).foldMin, 4);
  assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': 'not-a-number' })).foldMin, 3);
});

test('readSequenceSettings reads and clamps rowHeight to [18, 48]', () => {
  assert.equal(readSequenceSettings(makeOptions({ rowHeight: 24 })).rowHeight, 24);
  assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': '32' })).rowHeight, 32);
  assert.equal(readSequenceSettings(makeOptions({ rowHeight: 10 })).rowHeight, 18);
  assert.equal(readSequenceSettings(makeOptions({ rowHeight: 100 })).rowHeight, 48);
  assert.equal(readSequenceSettings(makeOptions({ rowHeight: Number.NaN })).rowHeight, 28);
});

test('readSequenceSettings reads wheelZoom from attribute or config', () => {
  assert.equal(readSequenceSettings(makeOptions({}, { 'wheel-zoom': '' })).wheelZoom, true);
  assert.equal(readSequenceSettings(makeOptions({ wheelZoom: true })).wheelZoom, true);
  assert.equal(readSequenceSettings(makeOptions({ wheelZoom: false })).wheelZoom, false);
});

test('computeSequenceLayout computes default geometry and dimensions', () => {
  assert.equal(SELF_LOOP_W, 36);
  const layout = computeSequenceLayout({
    viewWidth: 1000,
    viewHeight: 600,
    columnCount: 4,
    rowCount: 10,
  });

  assert.equal(layout.viewWidth, 1000);
  assert.equal(layout.viewHeight, 600);
  assert.equal(layout.headerHeight, HEADER_H);
  assert.equal(layout.gutterWidth, GUTTER_W);
  assert.equal(layout.columnCount, 4);
  assert.equal(layout.columnWidth, COL_W);
  assert.equal(layout.rowCount, 10);
  assert.equal(layout.rowHeight, ROW_H_DEFAULT);
  assert.equal(layout.contentWidth, GUTTER_W + 2 * CANVAS_PAD_X + 4 * COL_W);
  assert.equal(layout.bodyHeight, 10 * ROW_H_DEFAULT + 2 * CANVAS_PAD_Y);
  assert.equal(layout.bodyViewportHeight, 600 - HEADER_H);
});

test('computeSequenceLayout handles fitColumns, custom rowHeight, custom gutterWidth, and degenerate inputs', () => {
  // Few columns with fitColumns clamps to MAX_COL_W
  const wide = computeSequenceLayout({
    viewWidth: 1200,
    viewHeight: 500,
    columnCount: 2,
    rowCount: 5,
    fitColumns: true,
    rowHeight: 10, // clamps to ROW_H_MIN
    gutterWidth: 100,
  });
  assert.equal(wide.columnWidth, MAX_COL_W);
  assert.equal(wide.rowHeight, ROW_H_MIN);
  assert.equal(wide.gutterWidth, 100);

  // Many columns with fitColumns clamps to MIN_COL_W
  const dense = computeSequenceLayout({
    viewWidth: 600,
    viewHeight: 500,
    columnCount: 20,
    rowCount: 5,
    fitColumns: true,
    rowHeight: 80, // clamps to ROW_H_MAX
  });
  assert.equal(dense.columnWidth, MIN_COL_W);
  assert.equal(dense.rowHeight, ROW_H_MAX);

  // Intermediate fitColumns width
  const fitted = computeSequenceLayout({
    viewWidth: GUTTER_W + 2 * CANVAS_PAD_X + 4 * 150,
    viewHeight: 400,
    columnCount: 4,
    rowCount: 3,
    fitColumns: true,
  });
  assert.equal(fitted.columnWidth, 150);

  // Degenerate / NaN inputs
  const empty = computeSequenceLayout({
    viewWidth: Number.NaN,
    viewHeight: 20,
    columnCount: 0,
    rowCount: -5,
  });
  assert.equal(empty.viewWidth, 0);
  assert.equal(empty.bodyViewportHeight, 0);
  assert.equal(empty.columnCount, 0);
  assert.equal(empty.rowCount, 0);
  assert.equal(empty.contentWidth, GUTTER_W);
  assert.equal(empty.bodyHeight, 2 * CANVAS_PAD_Y);
});

test('lifelineCenterX and activationBoxX position lifelines and nested activations with MAX_NEST clamping', () => {
  const layout = computeSequenceLayout({
    viewWidth: 1000,
    viewHeight: 600,
    columnCount: 3,
    rowCount: 5,
  });

  const c0 = lifelineCenterX(layout, 0);
  const c1 = lifelineCenterX(layout, 1);
  assert.equal(c0, GUTTER_W + CANVAS_PAD_X + 0.5 * COL_W);
  assert.equal(c1, GUTTER_W + CANVAS_PAD_X + 1.5 * COL_W);

  const box0 = activationBoxX(layout, 0, 0);
  assert.deepEqual(box0, { x: c0 - ACT_W / 2, w: ACT_W, clampedNest: 0 });

  const box2 = activationBoxX(layout, 0, 2);
  assert.deepEqual(box2, { x: c0 - ACT_W / 2 + 2 * NEST_DX, w: ACT_W, clampedNest: 2 });

  // Clamping above MAX_NEST and below 0
  const boxDeep = activationBoxX(layout, 0, MAX_NEST + 5);
  assert.deepEqual(boxDeep, {
    x: c0 - ACT_W / 2 + MAX_NEST * NEST_DX,
    w: ACT_W,
    clampedNest: MAX_NEST,
  });

  const boxNeg = activationBoxX(layout, 0, -3);
  assert.deepEqual(boxNeg, { x: c0 - ACT_W / 2, w: ACT_W, clampedNest: 0 });
});

test('stepRowY and stepAtBodyY round-trip step rows accurately', () => {
  const layout = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 400,
    columnCount: 3,
    rowCount: 4,
    rowHeight: 30,
  });

  const r0 = stepRowY(layout, 0);
  assert.deepEqual(r0, { top: CANVAS_PAD_Y, centerY: CANVAS_PAD_Y + 15, bottom: CANVAS_PAD_Y + 30 });

  const r2 = stepRowY(layout, 2);
  assert.deepEqual(r2, {
    top: CANVAS_PAD_Y + 60,
    centerY: CANVAS_PAD_Y + 75,
    bottom: CANVAS_PAD_Y + 90,
  });

  assert.equal(stepAtBodyY(layout, 0), -1, 'above top padding');
  assert.equal(stepAtBodyY(layout, CANVAS_PAD_Y - 0.1), -1);
  assert.equal(stepAtBodyY(layout, CANVAS_PAD_Y), 0);
  assert.equal(stepAtBodyY(layout, r2.centerY), 2);
  assert.equal(stepAtBodyY(layout, CANVAS_PAD_Y + 4 * 30 - 0.01), 3);
  assert.equal(stepAtBodyY(layout, CANVAS_PAD_Y + 4 * 30), -1, 'past last row');
  assert.equal(stepAtBodyY(layout, Number.NaN), -1);
});

test('columnAtContentX finds nearest column or returns -1 in gutter / when empty', () => {
  const layout = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 400,
    columnCount: 3,
    rowCount: 4,
  });

  assert.equal(columnAtContentX(layout, 0), -1);
  assert.equal(columnAtContentX(layout, GUTTER_W - 1), -1);
  assert.equal(columnAtContentX(layout, GUTTER_W), 0, 'in left pad resolves to col 0');
  assert.equal(columnAtContentX(layout, lifelineCenterX(layout, 0)), 0);
  assert.equal(columnAtContentX(layout, lifelineCenterX(layout, 1)), 1);
  assert.equal(columnAtContentX(layout, lifelineCenterX(layout, 2)), 2);
  assert.equal(columnAtContentX(layout, layout.contentWidth + 50), 2, 'past right edge clamps to last col');

  const empty = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 400,
    columnCount: 0,
    rowCount: 0,
  });
  assert.equal(columnAtContentX(empty, 200), -1);
});

test('detectTimeGaps flags significant gaps above threshold and computes gapMs', () => {
  // Single or empty arrays
  assert.deepEqual(detectTimeGaps(new Float64Array([]), 100), {
    isGap: new Uint8Array(0),
    gapMs: new Float64Array(0),
  });
  assert.deepEqual(detectTimeGaps(new Float64Array([10]), 100), {
    isGap: new Uint8Array([0]),
    gapMs: new Float64Array([0]),
  });

  // Steps: deltas are 2, 2, 2, 50, 2 (extent = 58)
  // Positive deltas sorted: [2, 2, 2, 2, 50] -> medianPositiveDelta = 2
  // Threshold = max(58 * 0.02 = 1.16, 2 * 3 = 6, 1) = 6
  // Step 4 has dt = 50 >= 6 -> gap!
  const times = new Float64Array([100, 102, 104, 106, 156, 158]);
  const { isGap, gapMs } = detectTimeGaps(times, 58);

  assert.deepEqual(Array.from(isGap), [0, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(gapMs), [0, 2, 2, 2, 50, 2]);

  // Sub-millisecond trace where all deltas < 1ms: threshold is at least 1ms, so no gaps flagged
  const subMs = new Float64Array([0, 0.1, 0.2, 0.9, 1.0]);
  const subResult = detectTimeGaps(subMs, 1.0);
  assert.deepEqual(Array.from(subResult.isGap), [0, 0, 0, 0, 0]);
});
