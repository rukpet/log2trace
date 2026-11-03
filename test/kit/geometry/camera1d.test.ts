/**
 * The 1D time camera: scale round-trips, cursor-anchored zoom, clamping and the
 * minimum window, resize, pan, wheel normalisation and the zoom readout. Cameras
 * are pure values, so everything runs in plain Node. Random cases use a seeded
 * generator so a failure reproduces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WHEEL_DELTA_PX,
  MIN_WINDOW_MS,
  PINCH_ZOOM_K,
  WHEEL_ZOOM_K,
  WheelDeltaMode,
  createCamera,
  formatZoom,
  normalizeWheelDelta,
  panByPx,
  panByTime,
  pxPerMs,
  pxToTime,
  resizeCamera,
  timeToPx,
  wheelZoomFactor,
  withWindow,
  zoomAt,
  zoomFactor,
  zoomRatio,
  type Camera1D,
} from '../../../src/kit/geometry/camera1d.ts';

/** Deterministic PRNG (mulberry32): same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertClose(actual: number, expected: number, tolerance: number, what = 'value'): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} within ${tolerance}, got ${actual}`,
  );
}

function assertValid(camera: Camera1D, what = 'camera'): void {
  for (const key of ['t0', 't1', 'total', 'widthPx'] as const) {
    assert.ok(Number.isFinite(camera[key]), `${what}.${key} is not finite: ${camera[key]}`);
  }
  const limit = Math.max(camera.total, MIN_WINDOW_MS);
  assert.ok(camera.t0 >= 0, `${what}: t0 ${camera.t0} < 0`);
  assert.ok(camera.t1 <= limit, `${what}: t1 ${camera.t1} > ${limit}`);
  assert.ok(camera.t1 - camera.t0 >= MIN_WINDOW_MS * (1 - 1e-6), `${what}: window ${camera.t1 - camera.t0} below the minimum`);
}

/** A camera over `total` ms showing `[t0, t1]` on a plot `width` px wide. */
function view(total: number, width: number, t0: number, t1: number): Camera1D {
  return withWindow(createCamera(total, width), t0, t1);
}

test('createCamera shows the whole trace and maps the window ends to the plot edges', () => {
  const camera = createCamera(2000, 1000);

  assert.deepEqual(camera, { t0: 0, t1: 2000, total: 2000, widthPx: 1000 });
  assert.equal(pxPerMs(camera), 0.5);
  assert.equal(timeToPx(camera, 0), 0);
  assert.equal(timeToPx(camera, 500), 250);
  assert.equal(timeToPx(camera, 2000), 1000);
  assert.equal(pxToTime(camera, 250), 500);
  assert.equal(pxToTime(camera, 1000), 2000);
});

test('time and pixels round-trip, inside and outside the window', () => {
  const random = mulberry32(1);
  for (let n = 0; n < 3000; n++) {
    const total = 1 + random() * 1e5;
    const width = 50 + random() * 4000;
    const length = Math.max(MIN_WINDOW_MS, total * 10 ** (-random() * 5));
    const t0 = random() * (total - length);
    const camera = view(total, width, t0, t0 + length);
    const scale = pxPerMs(camera);

    // The error is a few ulps of the largest time involved, and of that in pixels.
    const t = camera.t0 + (random() * 3 - 1) * (camera.t1 - camera.t0);
    const timeTolerance = 16 * Number.EPSILON * Math.max(1, Math.abs(t), camera.t1);
    assertClose(pxToTime(camera, timeToPx(camera, t)), t, timeTolerance, `time ${t}`);

    const x = (random() * 3 - 1) * width;
    const pxTolerance = 16 * Number.EPSILON * Math.max(1, Math.abs(x)) + timeTolerance * scale;
    assertClose(timeToPx(camera, pxToTime(camera, x)), x, pxTolerance, `pixel ${x}`);
  }
});

test('zoomAt keeps the time under the cursor within 1e-9 ms', () => {
  const random = mulberry32(2);
  const total = 20_000;
  for (let n = 0; n < 3000; n++) {
    const width = 300 + random() * 2000;
    // Wheel factors span exp(+-0.48) and, with Ctrl, exp(+-2.4) = 0.09..11. The window is at least
    // 3000 ms from both ends, so even an 11x zoom-out stays inside the trace, and at least 0.02 ms
    // long, so an 11x zoom-in stays above the minimum window; no clamping interferes.
    const length = 0.02 + random() * 250;
    const t0 = 3000 + random() * (total - 6000 - length);
    const camera = view(total, width, t0, t0 + length);

    const x = random() * width;
    const tc = pxToTime(camera, x);
    const event = { deltaY: (random() * 2 - 1) * 300, deltaMode: 0, ctrlKey: random() < 0.5 };
    const factor = wheelZoomFactor(event, 700);
    const zoomed = zoomAt(camera, tc, factor);

    assertClose(pxToTime(zoomed, x), tc, 1e-9, `time under x=${x}`);
    assertClose(timeToPx(zoomed, tc), x, 1e-6, `pixel of t=${tc}`);
    assertClose((zoomed.t1 - zoomed.t0) / (camera.t1 - camera.t0), factor, 1e-6 * factor, 'window ratio');
  }
});

test('the anchor holds when the minimum window caps the zoom', () => {
  const camera = view(1000, 800, 100, 100.0025);
  const x = 600;
  const tc = pxToTime(camera, x);

  const zoomed = zoomAt(camera, tc, 0.001);

  assertClose(zoomed.t1 - zoomed.t0, MIN_WINDOW_MS, 1e-12, 'window length');
  assertClose(pxToTime(zoomed, x), tc, 1e-9, 'time under the cursor');
});

test('zooming out at an edge shifts the window back in and keeps its length', () => {
  const left = zoomAt(view(1000, 800, 0, 100), 10, 2); // would be [-10, 190]
  assert.equal(left.t0, 0);
  assert.equal(left.t1, 200);

  const right = zoomAt(view(1000, 800, 900, 1000), 990, 2); // would be [810, 1010]
  assert.equal(right.t0, 800);
  assert.equal(right.t1, 1000);
});

test('repeated zoom-out ends at exactly [0, total]; repeated zoom-in stops at the minimum window', () => {
  let out = view(5000, 1000, 2000, 2100);
  for (let i = 0; i < 100; i++) out = zoomAt(out, 2050, 1.5);
  assert.equal(out.t0, 0);
  assert.equal(out.t1, 5000);
  assert.equal(zoomRatio(out), 1);

  let into = createCamera(5000, 1000);
  for (let i = 0; i < 200; i++) into = zoomAt(into, 1234.5, 0.5);
  assertClose(into.t1 - into.t0, MIN_WINDOW_MS, 1e-11, 'minimum window');
  assert.ok(into.t0 <= 1234.5 && 1234.5 <= into.t1, 'the anchor is still inside the window');

  // At the minimum a further zoom-in leaves the window where it is, to within rounding.
  let more = into;
  for (let i = 0; i < 50; i++) more = zoomAt(more, 1234.5, 0.9);
  assertClose(more.t0, into.t0, 1e-9, 't0 after more zoom-in');
  assertClose(more.t1, into.t1, 1e-9, 't1 after more zoom-in');
});

test('withWindow clamps to [0, total] and applies the minimum window', () => {
  const camera = createCamera(1000, 800);
  const cases: [string, number, number, number, number][] = [
    ['sticks out on the left, shifted in with its length', -100, 50, 0, 150],
    ['sticks out on the right, shifted in with its length', 900, 1200, 700, 1000],
    ['longer than the trace', -1e9, 1e9, 0, 1000],
    ['reversed ends', 50, 10, 10, 50],
    ['exactly the trace', 0, 1000, 0, 1000],
    ['NaN start', NaN, 10, 0, 1000],
    ['infinite end', 10, Infinity, 0, 1000],
  ];
  for (const [what, t0, t1, expectedT0, expectedT1] of cases) {
    const window = withWindow(camera, t0, t1);
    assert.equal(window.t0, expectedT0, `${what}: t0`);
    assert.equal(window.t1, expectedT1, `${what}: t1`);
  }

  const point = withWindow(camera, 5, 5);
  assertClose(point.t0, 5 - MIN_WINDOW_MS / 2, 1e-12, 'zero-length window, t0');
  assertClose(point.t1, 5 + MIN_WINDOW_MS / 2, 1e-12, 'zero-length window, t1');

  const atStart = withWindow(camera, 0, 0.0004);
  assert.equal(atStart.t0, 0);
  assert.equal(atStart.t1, MIN_WINDOW_MS);

  const atEnd = withWindow(camera, 999.99999, 999.999995);
  assertClose(atEnd.t0, 1000 - MIN_WINDOW_MS, 1e-9, 'minimum window at the end, t0');
  assert.equal(atEnd.t1, 1000);

  // The plot width and the trace length come along unchanged.
  const moved = withWindow(camera, 10, 20);
  assert.equal(moved.widthPx, 800);
  assert.equal(moved.total, 1000);
});

test('a trace shorter than the minimum window still gets the minimum window', () => {
  const camera = createCamera(0.0004, 800);

  assert.equal(camera.total, 0.0004);
  assert.equal(camera.t0, 0);
  assert.equal(camera.t1, MIN_WINDOW_MS);
  assert.equal(zoomRatio(camera), 1);
  assert.equal(formatZoom(zoomRatio(camera)), '100%');
});

test('resizeCamera keeps the time window and only changes the scale', () => {
  const camera = view(1000, 1000, 100, 300);
  const centre = pxToTime(camera, 500);

  const narrower = resizeCamera(camera, 500);

  assert.equal(narrower.t0, 100);
  assert.equal(narrower.t1, 300);
  assert.equal(narrower.total, 1000);
  assert.equal(narrower.widthPx, 500);
  assert.equal(pxPerMs(camera), 5);
  assert.equal(pxPerMs(narrower), 2.5);
  assert.equal(timeToPx(camera, 150), 250);
  assert.equal(timeToPx(narrower, 150), 125);
  assert.equal(pxToTime(narrower, 250), centre, 'the same time stays in the middle of the plot');

  const hidden = resizeCamera(camera, 0);
  assert.equal(hidden.t0, 100);
  assert.equal(hidden.t1, 300);
  assert.equal(pxPerMs(hidden), 0);
  assert.equal(timeToPx(hidden, 150), 0);
  assert.equal(pxToTime(hidden, 500), 100);

  for (const bad of [-5, NaN, Infinity]) {
    assert.equal(resizeCamera(camera, bad).widthPx, 0, `width ${bad}`);
  }
});

test('panByPx moves the window against the drag, by dx / pxPerMs', () => {
  const camera = view(1000, 1000, 100, 200); // 10 px per ms

  const dragRight = panByPx(camera, 50);
  assert.equal(dragRight.t0, 95);
  assert.equal(dragRight.t1, 195);

  const dragLeft = panByPx(camera, -50);
  assert.equal(dragLeft.t0, 105);
  assert.equal(dragLeft.t1, 205);

  assert.equal(panByTime(camera, 7).t0, 107);
});

test('panning stops at the ends of the trace without changing the window length', () => {
  const start = view(1000, 1000, 0, 100);
  const stuckAtStart = panByPx(start, 100);
  assert.equal(stuckAtStart.t0, 0);
  assert.equal(stuckAtStart.t1, 100);

  const end = view(1000, 1000, 900, 1000);
  const stuckAtEnd = panByPx(end, -100);
  assert.equal(stuckAtEnd.t0, 900);
  assert.equal(stuckAtEnd.t1, 1000);

  const flung = panByPx(view(1000, 1000, 400, 500), -1e8);
  assert.equal(flung.t0, 900);
  assert.equal(flung.t1, 1000);

  // Several small pans never change the length beyond rounding.
  let camera = view(1000, 1000, 300, 400);
  for (let i = 0; i < 500; i++) camera = panByPx(camera, i % 2 === 0 ? 37 : -11);
  assertClose(camera.t1 - camera.t0, 100, 1e-9, 'window length after many pans');
});

test('zoom and pan ignore input that is not a usable number', () => {
  const camera = view(1000, 1000, 100, 200);

  for (const factor of [0, -1, NaN]) assert.equal(zoomAt(camera, 150, factor), camera, `factor ${factor}`);
  for (const anchor of [NaN, Infinity, -Infinity]) assert.equal(zoomAt(camera, anchor, 0.5), camera, `anchor ${anchor}`);
  for (const dt of [0, -0, NaN, Infinity]) assert.equal(panByTime(camera, dt), camera, `dt ${dt}`);
  for (const dx of [0, NaN, Infinity]) assert.equal(panByPx(camera, dx), camera, `dx ${dx}`);

  assert.equal(zoomAt(camera, 150, Infinity).t0, 0, 'an infinite factor zooms out to the whole trace');
  assert.equal(zoomAt(camera, 150, Infinity).t1, 1000);
});

test('the functions return new cameras and never modify their input', () => {
  const camera = Object.freeze(view(1000, 800, 100, 300));

  assert.doesNotThrow(() => {
    zoomAt(camera, 150, 0.5);
    zoomAt(camera, 150, 3);
    panByPx(camera, 40);
    panByTime(camera, 40);
    resizeCamera(camera, 300);
    withWindow(camera, 0, 10);
  });
  assert.deepEqual(camera, { t0: 100, t1: 300, total: 1000, widthPx: 800 });
});

test('an empty trace (total 0) never yields NaN or Infinity', () => {
  const empty = createCamera(0, 800);
  assert.deepEqual(empty, { t0: 0, t1: MIN_WINDOW_MS, total: 0, widthPx: 800 });

  const numbers = [
    pxPerMs(empty),
    timeToPx(empty, 0),
    timeToPx(empty, 5),
    pxToTime(empty, 0),
    pxToTime(empty, 800),
    zoomRatio(empty),
  ];
  for (const value of numbers) assert.ok(Number.isFinite(value), `got ${value}`);

  const next = [
    zoomAt(empty, 0, 0.5),
    zoomAt(empty, 0, 2),
    zoomAt(empty, 3, 10),
    panByPx(empty, 100),
    panByTime(empty, 5),
    withWindow(empty, 0, 0),
    withWindow(empty, 5, 5),
    resizeCamera(empty, 0),
  ];
  for (const camera of next) {
    assertValid(camera);
    assert.equal(camera.t0, 0);
    assert.equal(camera.t1, MIN_WINDOW_MS);
  }
  assert.equal(formatZoom(zoomRatio(empty)), '100%');

  for (const bad of [NaN, -1, Infinity]) {
    assertValid(createCamera(bad, 800), `createCamera(${bad})`);
  }
});

test('a zero-length window does not break the scale', () => {
  // Not constructible through the API, but a caller can build the literal.
  const degenerate: Camera1D = { t0: 5, t1: 5, total: 100, widthPx: 800 };

  assert.equal(pxPerMs(degenerate), 800 / MIN_WINDOW_MS);
  assert.equal(timeToPx(degenerate, 5), 0);
  assert.equal(timeToPx(degenerate, 6), 800 / MIN_WINDOW_MS);
  assertClose(pxToTime(degenerate, 400), 5 + MIN_WINDOW_MS / 2, 1e-12);
  assert.ok(Number.isFinite(zoomRatio(degenerate)));

  // Any operation that rebuilds the window repairs it.
  const repaired = zoomAt(degenerate, 5, 2);
  assertValid(repaired);
  assertClose(repaired.t0, 5 - MIN_WINDOW_MS / 2, 1e-12);
  assertClose(repaired.t1, 5 + MIN_WINDOW_MS / 2, 1e-12);
  assertValid(panByPx(degenerate, 30));
});

test('1e8-pixel extremes stay finite', () => {
  // A 1e8 px wide plot, and the narrowest window at the very end of a 1e7 ms trace.
  const wide = createCamera(1e7, 1e8);
  const deep = withWindow(wide, 1e7 - 1, 1e7);
  const deepest = withWindow(wide, 9_999_999.999, 1e7);
  assertValid(deepest);

  for (const camera of [wide, deep, deepest]) {
    const numbers = [
      pxPerMs(camera),
      timeToPx(camera, 0),
      timeToPx(camera, 1e7),
      timeToPx(camera, camera.t0),
      pxToTime(camera, 0),
      pxToTime(camera, 1e8),
      pxToTime(camera, -1e8),
      zoomRatio(camera),
    ];
    for (const value of numbers) assert.ok(Number.isFinite(value), `got ${value}`);
    assert.equal(timeToPx(camera, camera.t0), 0);
    assertClose(timeToPx(camera, camera.t1), 1e8, 1e-6 * 1e8, 'window end maps to the plot edge');

    for (const next of [
      zoomAt(camera, camera.t1, zoomFactor(1e9, PINCH_ZOOM_K)),
      zoomAt(camera, camera.t0, zoomFactor(-1e9, PINCH_ZOOM_K)),
      panByPx(camera, 1e8),
      panByPx(camera, -1e8),
      panByPx(camera, 1e300),
      resizeCamera(camera, 1e8),
    ]) {
      assertValid(next);
    }
  }

  // A bar spanning the whole trace, seen through the deepest window, lands about 1e18 px away: finite.
  const farLeft = timeToPx(deepest, 0);
  assert.ok(farLeft < -1e17 && Number.isFinite(farLeft));
});

test('deep zoom late in a long trace keeps the pixel scale usable', () => {
  const total = 1e7;
  const camera = view(total, 1000, 5_000_000, 5_000_000.001);

  assertClose(pxPerMs(camera), 1000 / MIN_WINDOW_MS, 1000 / MIN_WINDOW_MS * 1e-3, 'scale');
  const x = timeToPx(camera, 5_000_000.0005);
  // Doubles resolve ~1e-9 ms at 5e6 ms, i.e. ~1e-3 of this 0.001 ms window.
  assertClose(x, 500, 1, 'middle of the window');
  assertClose(pxToTime(camera, x), 5_000_000.0005, 1e-8);
});

test('normalizeWheelDelta converts lines and pages to pixels', () => {
  assert.deepEqual([WheelDeltaMode.Pixel, WheelDeltaMode.Line, WheelDeltaMode.Page], [0, 1, 2]);

  assert.equal(normalizeWheelDelta(120, WheelDeltaMode.Pixel, 700), 120);
  assert.equal(normalizeWheelDelta(3, WheelDeltaMode.Line, 700), 48);
  assert.equal(normalizeWheelDelta(-2, WheelDeltaMode.Page, 700), -1400);
  assert.equal(normalizeWheelDelta(0.5, WheelDeltaMode.Page, 800), 400);

  // Straight from `event.deltaMode`, which is a plain number.
  assert.equal(normalizeWheelDelta(100, 0, 700), 100);
  assert.equal(normalizeWheelDelta(1, 1, 700), 16);
  assert.equal(normalizeWheelDelta(1, 2, 700), 700);

  assert.equal(normalizeWheelDelta(100, 7 as WheelDeltaMode, 700), 100, 'an unknown mode is taken as pixels');
  assert.equal(normalizeWheelDelta(NaN, WheelDeltaMode.Pixel, 700), 0);
  assert.equal(normalizeWheelDelta(Infinity, WheelDeltaMode.Line, 700), 0);
  assert.equal(normalizeWheelDelta(1, WheelDeltaMode.Page, NaN), 0);
});

test('zoomFactor is exp(dy * k) with |dy| limited to 240', () => {
  assert.equal(MAX_WHEEL_DELTA_PX, 240);
  assert.equal(WHEEL_ZOOM_K, 0.002);
  assert.equal(PINCH_ZOOM_K, 0.01);

  assertClose(zoomFactor(100, WHEEL_ZOOM_K), Math.exp(0.2), 1e-12);
  assertClose(zoomFactor(-100, PINCH_ZOOM_K), Math.exp(-1), 1e-12);
  assert.equal(zoomFactor(0, WHEEL_ZOOM_K), 1);

  assert.equal(zoomFactor(240, WHEEL_ZOOM_K), Math.exp(240 * WHEEL_ZOOM_K));
  assert.equal(zoomFactor(10_000, WHEEL_ZOOM_K), Math.exp(240 * WHEEL_ZOOM_K));
  assert.equal(zoomFactor(-1e9, PINCH_ZOOM_K), Math.exp(-240 * PINCH_ZOOM_K));
  assert.equal(zoomFactor(Infinity, WHEEL_ZOOM_K), Math.exp(240 * WHEEL_ZOOM_K));

  assert.equal(zoomFactor(NaN, WHEEL_ZOOM_K), 1);
});

test('wheelZoomFactor normalises deltaMode and speeds up with Ctrl', () => {
  const page = 700;
  const wheel = (deltaY: number, deltaMode: number, ctrlKey = false) => wheelZoomFactor({ deltaY, deltaMode, ctrlKey }, page);

  assertClose(wheel(100, 0), Math.exp(100 * 0.002), 1e-12);
  assertClose(wheel(3, 1), Math.exp(48 * 0.002), 1e-12);
  assertClose(wheel(1, 2), Math.exp(240 * 0.002), 1e-12); // one page is 700 px, limited to 240
  assertClose(wheel(5, 0, true), Math.exp(5 * 0.01), 1e-12);
  assertClose(wheel(2, 1, true), Math.exp(32 * 0.01), 1e-12);

  assert.ok(wheel(1, 0) > 1, 'scrolling down zooms out');
  assert.ok(wheel(-1, 0) < 1, 'scrolling up zooms in');
  assert.equal(wheel(0, 0), 1);
  assert.equal(wheel(NaN, 0), 1);
});

test('the zoom readout is a percentage, then an x multiplier above 1000%', () => {
  const camera = createCamera(1000, 800);
  const label = (length: number) => formatZoom(zoomRatio(withWindow(camera, 0, length)));

  assert.equal(label(1000), '100%');
  assert.equal(label(800), '125%');
  assert.equal(label(500), '200%');
  assert.equal(label(400), '250%');
  assert.equal(label(100), '1000%', '1000% is still a percentage');
  assert.equal(label(99), '10.1x');
  assert.equal(label(80), '12.5x');
  assert.equal(label(50), '20x');
  assert.equal(label(10), '100x');
  assert.equal(label(2.5), '400x');
  assert.equal(label(0.01), '100000x');
  assert.equal(label(MIN_WINDOW_MS), '1e6x');

  assert.equal(formatZoom(1.234), '123%');
  assert.equal(formatZoom(12_345_678), '1.2e7x');
  for (const bad of [NaN, 0, -3, Infinity]) assert.equal(formatZoom(bad), '100%', `ratio ${bad}`);
});
