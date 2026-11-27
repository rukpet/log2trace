import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIP_MARGIN, MIN_BAR_WIDTH, barExtent, createBarExtent, lowerBound } from '../../../src/kit/geometry/extent.ts';
import { barExtent as barExtentFromWaterfall } from '../../../src/views/waterfall/model/bars.ts';
import type { Camera1D } from '../../../src/kit/geometry/camera1d.ts';

const camera: Camera1D = { t0: 100, t1: 200, total: 1000, widthPx: 1000 };

test('a bar inside the window maps time to pixels', () => {
  const e = barExtent(camera, 110, 120, createBarExtent());
  assert.equal(e.x0, 100);
  assert.equal(e.x1, 200);
  assert.ok(e.visible && !e.clippedLeft && !e.clippedRight);
});

test('a bar is at least MIN_BAR_WIDTH wide, also when it ends before it starts', () => {
  const tiny = barExtent(camera, 150, 150, createBarExtent());
  assert.equal(tiny.x1 - tiny.x0, MIN_BAR_WIDTH);
  const inverted = barExtent(camera, 150, 140, createBarExtent());
  assert.equal(inverted.x1 - inverted.x0, MIN_BAR_WIDTH);
});

test('a bar wider than the view is clipped just outside the plot', () => {
  const e = barExtent(camera, -1e9, 1e9, createBarExtent());
  assert.equal(e.x0, -CLIP_MARGIN);
  assert.equal(e.x1, camera.widthPx + CLIP_MARGIN);
  assert.ok(e.visible && e.clippedLeft && e.clippedRight);
});

test('a bar outside the window is not visible', () => {
  assert.equal(barExtent(camera, 10, 20, createBarExtent()).visible, false);
  assert.equal(barExtent(camera, 300, 310, createBarExtent()).visible, false);
});

test('lowerBound finds the first value not below the target within a range', () => {
  const values = Float64Array.of(1, 3, 3, 5, 9);
  assert.equal(lowerBound(values, 0, 5, 3), 1);
  assert.equal(lowerBound(values, 0, 5, 4), 3);
  assert.equal(lowerBound(values, 0, 5, 10), 5);
  assert.equal(lowerBound(values, 2, 4, 0), 2);
});

test('the waterfall still exports the same bar geometry', () => {
  assert.equal(barExtentFromWaterfall, barExtent);
});
