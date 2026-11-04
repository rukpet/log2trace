/**
 * Where bars and event markers fall on the plot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex } from '../../../src/core.ts';
import { createCamera, pxPerMs, withWindow } from '../../../src/kit/geometry/camera1d.ts';
import {
  CLIP_MARGIN,
  MAX_EVENT_MARKERS,
  MIN_BAR_WIDTH,
  MIN_BAR_WIDTH_FOR_EVENTS,
  MIN_EVENT_GAP,
  barExtent,
  createBarExtent,
  eventMarkers,
  lowerBound,
} from '../../../src/views/waterfall/model/bars.ts';
import { random, treeTrace } from '../../support/trace-builder.ts';

test('lowerBound finds the first value not below the target', () => {
  const values = new Float64Array([1, 3, 3, 5, 8]);
  assert.equal(lowerBound(values, 0, 5, 0), 0);
  assert.equal(lowerBound(values, 0, 5, 3), 1);
  assert.equal(lowerBound(values, 0, 5, 4), 3);
  assert.equal(lowerBound(values, 0, 5, 9), 5);
  assert.equal(lowerBound(values, 1, 4, 1), 1, 'stays inside the range');
  assert.equal(lowerBound(values, 2, 2, 3), 2, 'an empty range');
});

test('a bar is placed from the camera: start, end, visibility', () => {
  const camera = createCamera(1000, 1000); // 1 px per ms
  const out = createBarExtent();

  assert.equal(barExtent(camera, 100, 300, out), out, 'the result goes into the object given');
  assert.deepEqual(out, { x0: 100, x1: 300, visible: true, clippedLeft: false, clippedRight: false });
});

test('a bar that starts before the window is clipped at its left, one past the end at its right', () => {
  const zoomed = withWindow(createCamera(1000, 1000), 250, 350); // 10 px per ms
  const out = createBarExtent();

  assert.deepEqual(barExtent(zoomed, 100, 300, out), {
    x0: -CLIP_MARGIN, x1: 500, visible: true, clippedLeft: true, clippedRight: false,
  });
  assert.deepEqual(barExtent(zoomed, 300, 900, out), {
    x0: 500, x1: 1000 + CLIP_MARGIN, visible: true, clippedLeft: false, clippedRight: true,
  });
  assert.equal(barExtent(zoomed, 0, 100, out).visible, false, 'ends before the window');
  assert.equal(barExtent(zoomed, 400, 500, out).visible, false, 'starts after the window');
});

test('a bar is never narrower than the minimum, and a span that ends before it starts still shows', () => {
  const camera = createCamera(1000, 1000);
  const out = createBarExtent();

  barExtent(camera, 100, 100.1, out);
  assert.equal(out.x1 - out.x0, MIN_BAR_WIDTH);
  barExtent(camera, 100, 100, out);
  assert.equal(out.x1 - out.x0, MIN_BAR_WIDTH);
  barExtent(camera, 100, 50, out);
  assert.deepEqual([out.x0, out.x1], [100, 100 + MIN_BAR_WIDTH]);
  barExtent(camera, 100, Number.NaN, out);
  assert.deepEqual([out.x0, out.x1], [100, 100 + MIN_BAR_WIDTH]);
});

test('extreme zoom and degenerate cameras give finite numbers', () => {
  const out = createBarExtent();
  const deep = withWindow(createCamera(1e7, 1e8), 5e6, 5e6 + 0.001); // 1e11 px per ms on a 1e8 px plot

  barExtent(deep, 0, 1e7, out);
  assert.deepEqual(out, { x0: -CLIP_MARGIN, x1: 1e8 + CLIP_MARGIN, visible: true, clippedLeft: true, clippedRight: true });
  barExtent(deep, 5e6, 5e6 + 0.0005, out);
  assert.ok(Number.isFinite(out.x0) && Number.isFinite(out.x1));

  barExtent(createCamera(1000, 0), 100, 200, out); // a plot with no width
  assert.ok(Number.isFinite(out.x0) && Number.isFinite(out.x1));
  barExtent(createCamera(0, 500), 0, 0, out); // an empty trace
  assert.ok(Number.isFinite(out.x0) && Number.isFinite(out.x1));
});

// -- event markers ------------------------------------------------------------------------

/** One span of `extent` ms with the given events, indexed. */
function spanWithEvents(extent: number, events: number[], status = 0) {
  const index = buildSpanIndex(treeTrace({ id: 's', start: 0, end: extent, events, status }));
  return index.table;
}

function markers(table: ReturnType<typeof spanWithEvents>, camera = createCamera(table.extentMs, 1000), capacity = MAX_EVENT_MARKERS): number[] {
  const out = new Float32Array(capacity);
  const extent = barExtent(camera, table.start[0], table.end[0], createBarExtent());
  const count = eventMarkers(table, 0, camera, extent, out, 0, capacity);
  return Array.from(out.subarray(0, count));
}

test('few events each get a marker at their time', () => {
  const table = spanWithEvents(1000, [0, 500, 1000]);
  assert.deepEqual(markers(table), [0, 500, 1000]);
});

test('dense events are thinned to at most the capacity, at least a gap apart', () => {
  const times = Array.from({ length: 1000 }, (_, i) => i);
  const table = spanWithEvents(1000, times);

  const all = markers(table);
  assert.ok(all.length <= MAX_EVENT_MARKERS && all.length >= 60, `got ${all.length} markers`);
  assert.equal(all[0], 0, 'the earliest event always makes it');
  for (let i = 1; i < all.length; i++) assert.ok(all[i] - all[i - 1] >= 1000 / MAX_EVENT_MARKERS - 1e-3);

  const few = markers(table, createCamera(1000, 1000), 8);
  assert.equal(few.length, 8);
  assert.deepEqual(few, [0, 125, 250, 375, 500, 625, 750, 875]);
});

test('a bar narrower than the minimum shows no markers', () => {
  const table = spanWithEvents(1000, [0, 500, 1000]);
  const camera = createCamera(1000, (MIN_BAR_WIDTH_FOR_EVENTS - 1) - 0.5); // bar about 5 px wide
  assert.deepEqual(markers(table, camera), []);
  assert.equal(markers(table, createCamera(1000, MIN_BAR_WIDTH_FOR_EVENTS + 1)).length > 0, true);
});

test('only events inside the span and inside the visible window are drawn', () => {
  const table = spanWithEvents(1000, [-5, 100, 150, 199, 200, 600, 1005]);

  // 200 is 1 px after 199 and the markers of a 1000 px bar keep about 16 px apart: the earlier one stays
  assert.deepEqual(markers(table), [100, 150, 199, 600], 'events outside the span are skipped');

  const zoomed = withWindow(createCamera(1000, 1000), 100, 200); // 10 px per ms
  assert.deepEqual(markers(table, zoomed), [0, 500, 990], 'only the window, and 200 is 10 px after 199');
});

test('markers sit exactly at (time - window start) * scale', () => {
  const table = spanWithEvents(1000, [100, 400]);
  const camera = withWindow(createCamera(1000, 724), 50, 450);
  const [first, second] = markers(table, camera);
  assert.ok(Math.abs(first - (100 - 50) * pxPerMs(camera)) < 1e-3);
  assert.ok(Math.abs(second - (400 - 50) * pxPerMs(camera)) < 1e-3);
});

test('a bar outside the plot has no markers, and markers append at the offset given', () => {
  const table = spanWithEvents(1000, [100, 200]);
  const camera = withWindow(createCamera(1000, 1000), 500, 900);
  const out = new Float32Array(10).fill(-1);

  const hidden = barExtent(camera, 0, 400, createBarExtent());
  assert.equal(eventMarkers(table, 0, camera, hidden, out, 0, 10), 0);

  const whole = createCamera(1000, 1000);
  const extent = barExtent(whole, 0, 1000, createBarExtent());
  assert.equal(eventMarkers(table, 0, whole, extent, out, 3, 10), 2);
  assert.deepEqual(Array.from(out.subarray(0, 6)), [-1, -1, -1, 100, 200, -1]);
});

test('skipping with a binary search picks the same markers as a linear greedy scan', () => {
  for (const seed of [21, 22, 23, 24, 25]) {
    const next = random(seed);
    const total = 500 + Math.floor(next() * 5000);
    const times = Array.from({ length: 1 + Math.floor(next() * 3000) }, () => next() * total).sort((a, b) => a - b);
    const table = spanWithEvents(total, times);
    const evT = Array.from(table.evT);

    for (let trial = 0; trial < 12; trial++) {
      const plot = 100 + Math.floor(next() * 1900);
      const width = Math.max(1, next() * total);
      const t0 = next() * (total - width);
      const camera = withWindow(createCamera(total, plot), t0, t0 + width);
      const extent = barExtent(camera, table.start[0], table.end[0], createBarExtent());
      const out = new Float32Array(MAX_EVENT_MARKERS);
      const count = eventMarkers(table, 0, camera, extent, out, 0);

      // the greedy reference: walk the events in order, keep one when it is a gap past the last kept
      const scale = pxPerMs(camera);
      const expected: number[] = [];
      if (extent.visible && extent.x1 - extent.x0 >= MIN_BAR_WIDTH_FOR_EVENTS) {
        const gapMs = Math.max(MIN_EVENT_GAP, (extent.x1 - extent.x0) / MAX_EVENT_MARKERS) / scale;
        let nextAllowed = -Infinity;
        for (const t of evT) {
          if (t < Math.max(table.start[0], camera.t0)) continue;
          if (t > Math.min(table.end[0], camera.t1)) break;
          if (t >= nextAllowed && expected.length < MAX_EVENT_MARKERS) {
            expected.push(Math.fround((t - camera.t0) * scale));
            nextAllowed = t + gapMs;
          }
        }
      }
      assert.deepEqual(Array.from(out.subarray(0, count)), expected, `seed ${seed}, trial ${trial}`);
    }
  }
});
