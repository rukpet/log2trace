/**
 * The canvas surface against fakes: how the canvases are built and placed, how
 * the backing store follows the observer (device pixels, the fallback, the cap),
 * that the size is written only when it changes, that a zero size or a lost
 * context holds the frame and keeps the dirty bits, the pixel-ratio path,
 * resize notifications, and disposal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BACKING_PIXELS,
  MAX_BACKING_SIDE,
  createCanvasSurface,
  fitBackingStore,
  type CanvasSurface,
  type SurfaceSize,
} from '../../../src/kit/canvas/surface.ts';
import { Dirty, createFrameScheduler, type FrameScheduler } from '../../../src/kit/scheduler.ts';
import { createFakeClock, type FakeClock } from '../../support/fake-frame.ts';
import {
  createFakeSurfaceEnv,
  fakeContext,
  type FakeCanvas,
  type FakeResizeObserver,
  type FakeSurfaceEnv,
  type FakeSurfaceEnvOptions,
} from '../../support/fake-dom.ts';

interface Painted {
  readonly dirty: number;
  readonly size: SurfaceSize;
  readonly surface: CanvasSurface;
}

interface Rig {
  readonly clock: FakeClock;
  readonly scheduler: FrameScheduler;
  readonly fake: FakeSurfaceEnv;
  readonly surface: CanvasSurface;
  readonly paints: Painted[];
  /** Everything in the order it happened: `resize` for a notification, `paint` for a paint. */
  readonly log: string[];
  readonly scene: FakeCanvas;
  readonly overlay: FakeCanvas;
  readonly observer: FakeResizeObserver;
}

function setup(options: FakeSurfaceEnvOptions = {}): Rig {
  const clock = createFakeClock();
  const scheduler = createFrameScheduler({ requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame, now: clock.now });
  const fake = createFakeSurfaceEnv(options);
  const paints: Painted[] = [];
  const log: string[] = [];
  const surface = createCanvasSurface({
    host: fake.host,
    scheduler,
    env: fake.env,
    paint(dirty, painted) {
      log.push('paint');
      paints.push({ dirty, size: painted.size, surface: painted });
    },
  });
  surface.onResize(() => log.push('resize'));
  return { clock, scheduler, fake, surface, paints, log, scene: fake.canvases[0], overlay: fake.canvases[1], observer: fake.observers[0] };
}

test('builds an opaque scene and a transparent overlay, out of flow, before the host\'s other children', () => {
  const { fake, surface, scene, overlay, observer, clock, paints } = setup();

  assert.equal(fake.canvases.length, 2);
  assert.deepEqual(scene.getContextCalls, [{ kind: '2d', options: { alpha: false } }], 'the scene has no alpha');
  assert.deepEqual(overlay.getContextCalls, [{ kind: '2d', options: undefined }], 'the overlay keeps its alpha');
  assert.equal(fakeContext(surface.scene).canvas, scene);
  assert.equal(fakeContext(surface.overlay).canvas, overlay);

  for (const canvas of [scene, overlay]) {
    assert.deepEqual(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      pointerEvents: 'none',
    });
    assert.equal(canvas.attributes.get('aria-hidden'), 'true', 'decorative for screen readers');
  }
  assert.deepEqual(fake.host.children, [scene, overlay, 'existing child'], 'the canvases go first, so later siblings stack above them');

  assert.deepEqual(observer.observed, [{ target: scene, options: { box: 'device-pixel-content-box' } }], 'the scene canvas is watched');
  assert.deepEqual(fake.queries.map((q) => q.query), ['(resolution: 2dppx)']);
  assert.equal(fake.queries[0].listeners.size, 1);

  assert.equal(surface.ready, false, 'no size yet');
  assert.deepEqual(surface.size, { cssWidth: 0, cssHeight: 0, dpr: 2, pxWidth: 0, pxHeight: 0, scaleX: 2, scaleY: 2 });
  assert.equal(scene.widthWrites + scene.heightWrites + overlay.widthWrites + overlay.heightWrites, 0, 'the canvases keep their default size');
  assert.equal(clock.requests, 0, 'nothing is requested before there is something to paint');
  assert.equal(paints.length, 0);
});

test('the first size resizes both canvases and paints at once, inside the observer callback', () => {
  const { surface, scene, overlay, observer, clock, paints, log } = setup();

  observer.notify(800, 600, { width: 1600, height: 1200 });

  assert.deepEqual(log, ['resize', 'paint'], 'listeners hear about the size before the paint');
  assert.equal(paints.length, 1, 'painted without waiting for a frame');
  assert.equal(paints[0].dirty, Dirty.Size);
  assert.equal(paints[0].surface, surface);
  assert.deepEqual(surface.size, { cssWidth: 800, cssHeight: 600, dpr: 2, pxWidth: 1600, pxHeight: 1200, scaleX: 2, scaleY: 2 });
  assert.equal(surface.ready, true);

  for (const canvas of [scene, overlay]) {
    assert.deepEqual([canvas.width, canvas.height], [1600, 1200]);
    assert.deepEqual([canvas.widthWrites, canvas.heightWrites], [1, 1]);
  }
  assert.equal(clock.pending, 0, 'the frame requested for the paint was not needed');
  clock.frame();
  assert.equal(paints.length, 1);
});

test('writes the backing store only where it differs, because every write clears the canvas', () => {
  const { surface, scene, overlay, observer, paints } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });
  const first = surface.size;
  const writes = () => [scene.widthWrites, scene.heightWrites, overlay.widthWrites, overlay.heightWrites];
  assert.deepEqual(writes(), [1, 1, 1, 1]);

  observer.notify(800, 600, { width: 1600, height: 1200 });
  assert.deepEqual(writes(), [1, 1, 1, 1], 'the same size again writes nothing');
  assert.equal(paints.length, 1, 'and paints nothing');
  assert.equal(surface.size, first, 'and the size is the very same object');

  observer.notify(900, 600, { width: 1800, height: 1200 });
  assert.deepEqual(writes(), [2, 1, 2, 1], 'only the width changed, so only the width was written');
  assert.equal(paints.length, 2);
  assert.equal(paints[1].dirty, Dirty.Size);
  assert.notEqual(surface.size, first);

  observer.notify(900, 650, { width: 1800, height: 1300 });
  assert.deepEqual(writes(), [2, 2, 2, 2], 'only the height changed');

  const before = surface.size;
  observer.notify(900.25, 650, { width: 1800, height: 1300 });
  assert.deepEqual(writes(), [2, 2, 2, 2], 'a CSS size that moved by a fraction leaves the device size, so no write');
  assert.equal(paints.length, 4, 'but the scale changed, so it paints');
  assert.notEqual(surface.size, before);
  assert.ok(Math.abs(surface.size.scaleX - 1800 / 900.25) < 1e-12);
});

test('takes the device pixel size the browser reports, and scales CSS px onto it exactly', () => {
  const { surface, observer, scene } = setup({ dpr: 1.5 });
  observer.notify(100.4, 50.2, { width: 151, height: 75 });

  const size = surface.size;
  assert.deepEqual([size.pxWidth, size.pxHeight], [151, 75]);
  assert.deepEqual([scene.width, scene.height], [151, 75]);
  assert.ok(Math.abs(size.scaleX - 151 / 100.4) < 1e-12);
  assert.ok(Math.abs(size.scaleY - 75 / 50.2) < 1e-12);
  assert.equal(size.dpr, 1.5);

  for (const ctx of [surface.scene, surface.overlay]) {
    surface.applyScale(ctx);
    assert.deepEqual(fakeContext(ctx).transform, [size.scaleX, 0, 0, size.scaleY, 0, 0]);
  }
});

test('without devicePixelContentBoxSize the store is round(css × dpr)', () => {
  const { surface, observer } = setup({ dpr: 1.5 });
  observer.notify(100.4, 50.2);
  assert.deepEqual([surface.size.pxWidth, surface.size.pxHeight], [151, 75], 'round(150.6) and round(75.3)');
  assert.ok(Math.abs(surface.size.scaleX - 151 / 100.4) < 1e-12);

  observer.notify(100, 50);
  assert.deepEqual([surface.size.pxWidth, surface.size.pxHeight], [150, 75]);
});

test('falls back to observing the content box where the device-pixel box is rejected', () => {
  const { surface, observer, scene } = setup({ rejectDevicePixelBox: true });
  assert.deepEqual(observer.observed, [{ target: scene, options: { box: 'content-box' } }]);

  observer.notify(400, 300);
  assert.deepEqual([surface.size.pxWidth, surface.size.pxHeight], [800, 600]);
  assert.equal(surface.ready, true);
});

test('caps the backing store at about 8 Mpx and tells the painter the scale it really has', () => {
  const { surface, observer, scene } = setup({ dpr: 2 });
  observer.notify(3000, 2000);

  const { pxWidth, pxHeight, scaleX, scaleY } = surface.size;
  assert.ok(pxWidth * pxHeight <= MAX_BACKING_PIXELS, `${pxWidth}×${pxHeight} is over the cap`);
  assert.ok(pxWidth * pxHeight > 0.99 * MAX_BACKING_PIXELS, 'but close to it');
  assert.ok(Math.abs(pxWidth / pxHeight - 3 / 2) < 0.002, 'with the same aspect ratio');
  assert.ok(scaleX < 2 && scaleY < 2, 'so the scale is below the pixel ratio');
  assert.ok(Math.abs(scaleX * 3000 - pxWidth) < 1e-9, 'and maps the whole CSS width onto the store');
  assert.deepEqual([scene.width, scene.height], [pxWidth, pxHeight]);
});

test('fitBackingStore keeps what fits, shrinks what does not, and refuses what is not a size', () => {
  assert.deepEqual(fitBackingStore(1600, 1200), { width: 1600, height: 1200 });
  assert.deepEqual(fitBackingStore(3.9, 2.2), { width: 3, height: 2 }, 'whole pixels');
  assert.deepEqual(fitBackingStore(1, 1), { width: 1, height: 1 });

  const big = fitBackingStore(20_000, 20_000);
  assert.ok(big.width * big.height <= MAX_BACKING_PIXELS);
  assert.equal(big.width, big.height, 'square stays square');
  assert.deepEqual(fitBackingStore(MAX_BACKING_PIXELS, 1), { width: MAX_BACKING_SIDE, height: 1 }, 'a side is limited too');
  assert.deepEqual(fitBackingStore(100_000, 10), { width: MAX_BACKING_SIDE, height: 10 });
  const wide = fitBackingStore(40_000, 400);
  assert.ok(wide.width <= MAX_BACKING_SIDE && wide.height >= 1);

  assert.deepEqual(fitBackingStore(2000, 4000), { width: 2000, height: 4000 }, 'exactly 8 Mpx is allowed');
  for (const [w, h] of [[2829, 2829], [4000, 2500], [3000, 3000]] as const) {
    const fitted = fitBackingStore(w, h);
    assert.ok(fitted.width * fitted.height <= MAX_BACKING_PIXELS, `${w}×${h} became ${fitted.width}×${fitted.height}, over the cap`);
    assert.ok(fitted.width * fitted.height > 0.99 * MAX_BACKING_PIXELS, `${w}×${h} was shrunk further than it had to be`);
  }

  for (const [w, h] of [[0, 100], [100, 0], [-5, 100], [100, NaN], [NaN, NaN], [0.5, 100], [Infinity, 100]] as const) {
    assert.deepEqual(fitBackingStore(w, h), { width: 0, height: 0 }, `${w}×${h}`);
  }
});

test('a zero size holds the frame and keeps every dirty bit for when there is a size', () => {
  const { surface, observer, scene, clock, paints } = setup();

  observer.notify(0, 0);
  assert.equal(surface.ready, false);
  assert.deepEqual([scene.widthWrites, scene.heightWrites], [0, 0], 'a zero size does not touch the canvas');

  surface.mark(Dirty.Camera);
  surface.mark(Dirty.Hover);
  assert.equal(clock.requests, 1);
  clock.frame();
  assert.equal(paints.length, 0, 'no paint at zero size');
  assert.equal(clock.pending, 0, 'and no frame loop spinning meanwhile');
  assert.equal(clock.frame(), 0);

  observer.notify(800, 600, { width: 1600, height: 1200 });
  assert.equal(paints.length, 1);
  assert.equal(paints[0].dirty, Dirty.Camera | Dirty.Hover | Dirty.Size, 'the kept bits arrive with the size');
});

test('hiding the host and showing it again at the same size keeps the canvas and what changed meanwhile', () => {
  const { surface, observer, scene, overlay, clock, paints } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });
  assert.equal(paints.length, 1);

  observer.notify(0, 0, { width: 0, height: 0 });
  assert.equal(surface.ready, false);
  surface.mark(Dirty.Selection);
  clock.frame();
  assert.equal(paints.length, 1, 'nothing paints while hidden');

  observer.notify(800, 600, { width: 1600, height: 1200 });
  assert.equal(paints.length, 2);
  assert.equal(paints[1].dirty, Dirty.Selection | Dirty.Size);
  assert.deepEqual([scene.widthWrites, scene.heightWrites, overlay.widthWrites, overlay.heightWrites], [1, 1, 1, 1], 'the backing store was never rewritten');
});

test('a side with no length, or a length that is not a number, is no size', () => {
  const { surface, observer, paints } = setup();
  for (const [w, h] of [[0, 600], [800, 0], [NaN, 600], [800, -4], [Infinity, 600]] as const) {
    observer.notify(w, h, { width: 1600, height: 1200 });
    assert.equal(surface.ready, false, `${w}×${h}`);
    assert.equal(surface.size.pxWidth, 0);
    assert.equal(surface.size.scaleX, 2, 'the scale stays a number');
  }
  assert.equal(paints.length, 0);
});

test('a change of the pixel ratio renews the query, recomputes the store and paints', () => {
  const { surface, observer, fake, scene, paints, log } = setup({ dpr: 1 });
  assert.deepEqual(fake.queries.map((q) => q.query), ['(resolution: 1dppx)']);
  observer.notify(800, 600, { width: 800, height: 600 });
  assert.deepEqual([scene.width, scene.height], [800, 600]);
  log.length = 0;

  fake.setDpr(2);
  fake.queries[0].fire();
  assert.deepEqual(fake.queries.map((q) => q.query), ['(resolution: 1dppx)', '(resolution: 2dppx)'], 'subscribed again for the new ratio');
  assert.equal(fake.queries[0].listeners.size, 0, 'and left the old one');
  assert.equal(fake.queries[1].listeners.size, 1);

  assert.deepEqual([surface.size.dpr, surface.size.pxWidth, surface.size.pxHeight], [2, 1600, 1200]);
  assert.deepEqual([scene.width, scene.height, scene.widthWrites, scene.heightWrites], [1600, 1200, 2, 2]);
  assert.deepEqual(log, ['resize', 'paint']);
  assert.equal(paints.at(-1)?.dirty, Dirty.Size);

  fake.queries[1].fire();
  assert.equal(fake.queries.length, 3, 'a notification without a change still renews the query');
  assert.equal(fake.queries[1].listeners.size, 0);
  assert.equal(paints.length, 2, 'but nothing changed, so nothing paints');
});

test('after a pixel-ratio change the device size measured at the old ratio is not trusted until the observer reports again', () => {
  const { surface, observer, fake } = setup({ dpr: 2 });
  observer.notify(800, 600, { width: 1600, height: 1200 });

  fake.setDpr(3);
  fake.queries[0].fire();
  assert.deepEqual([surface.size.pxWidth, surface.size.pxHeight], [2400, 1800], 'round(css × new dpr), not the stale 1600 × 1200');

  observer.notify(800, 600, { width: 2399, height: 1800 });
  assert.deepEqual([surface.size.pxWidth, surface.size.pxHeight], [2399, 1800], 'the browser\'s own figure wins once it arrives');
});

test('a pixel ratio that is not a usable number counts as 1', () => {
  for (const bad of [0, -2, NaN, Infinity]) {
    const { surface, observer, fake } = setup({ dpr: bad });
    assert.equal(surface.size.dpr, 1, `initial ${bad}`);
    assert.equal(fake.queries[0].query, '(resolution: 1dppx)');
    observer.notify(100, 50);
    assert.deepEqual([surface.size.pxWidth, surface.size.pxHeight], [100, 50]);
  }
});

test('a lost context holds the frame, its loss is cancelled so it is restored, and a restore repaints everything', () => {
  const { surface, observer, scene, clock, paints } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });
  assert.equal(paints.length, 1);

  const lost = scene.dispatch('contextlost');
  assert.equal(lost.defaultPrevented, true, 'the browser restores a 2D context only if the loss is cancelled');
  assert.equal(surface.ready, false);

  surface.mark(Dirty.Camera);
  clock.frame();
  assert.equal(paints.length, 1, 'no painting on a lost context');
  assert.equal(clock.pending, 0);

  scene.dispatch('contextrestored');
  assert.equal(surface.ready, true);
  clock.frame();
  assert.equal(paints.length, 2);
  assert.equal(paints[1].dirty, Dirty.All, 'the canvas is blank: everything is dirty, the held bit included');
});

test('the scene and the overlay lose and regain their contexts independently', () => {
  const { surface, observer, scene, overlay, clock, paints } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });

  overlay.dispatch('contextlost');
  scene.dispatch('contextlost');
  overlay.dispatch('contextrestored');
  assert.equal(surface.ready, false, 'the scene is still lost');
  clock.frame();
  assert.equal(paints.length, 1);

  scene.dispatch('contextrestored');
  clock.frame();
  assert.equal(paints.length, 2);
  assert.equal(paints[1].dirty, Dirty.All);

  overlay.dispatch('contextlost');
  assert.equal(overlay.listenerCount('contextlost'), 1);
  assert.equal(surface.ready, false);
});

test('paint is called once per frame with all the bits marked since, and the surface', () => {
  const { surface, observer, clock, paints } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });
  paints.length = 0;
  const requests = clock.requests;

  surface.mark(Dirty.Camera);
  surface.mark(Dirty.Hover);
  surface.mark(Dirty.Camera);
  assert.equal(clock.requests, requests + 1, 'one frame request for three marks');
  assert.equal(paints.length, 0, 'nothing paints before the frame');

  clock.frame();
  assert.equal(paints.length, 1);
  assert.equal(paints[0].dirty, Dirty.Camera | Dirty.Hover);
  assert.equal(paints[0].surface, surface);

  assert.equal(clock.frame(), 0);
  assert.equal(paints.length, 1, 'nothing dirty, nothing painted');
});

test('shares the frame request with the other clients of the scheduler', () => {
  const { surface, observer, scheduler, clock } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });
  const other: number[] = [];
  const otherHandle = scheduler.register({ paint: (dirty) => { other.push(dirty); } });
  const requests = clock.requests;

  surface.mark(Dirty.Camera);
  otherHandle.mark(Dirty.Theme);
  assert.equal(clock.requests, requests + 1);
  clock.frame();
  assert.deepEqual(other, [Dirty.Theme]);
});

test('resize listeners hear about every size change, also the loss of size, and can stop listening', () => {
  const { surface, observer } = setup();
  const heard: SurfaceSize[] = [];
  const stop = surface.onResize((size) => heard.push(size));

  observer.notify(800, 600, { width: 1600, height: 1200 });
  observer.notify(800, 600, { width: 1600, height: 1200 });
  observer.notify(0, 0);
  assert.equal(heard.length, 2, 'the repeated size is not news');
  assert.deepEqual([heard[0].cssWidth, heard[0].pxWidth], [800, 1600]);
  assert.deepEqual([heard[1].cssWidth, heard[1].pxWidth], [0, 0], 'losing the size is reported too');

  stop();
  observer.notify(400, 300, { width: 800, height: 600 });
  assert.equal(heard.length, 2);
});

test('a resize listener that throws does not stop the others or the paint, and its error comes out afterwards', () => {
  const { surface, observer, paints } = setup();
  const heard: string[] = [];
  surface.onResize(() => {
    throw new Error('listener failed');
  });
  surface.onResize(() => heard.push('second'));

  assert.throws(() => observer.notify(800, 600, { width: 1600, height: 1200 }), /listener failed/);
  assert.deepEqual(heard, ['second']);
  assert.equal(paints.length, 1, 'the paint still happened');
  assert.equal(surface.ready, true);
});

test('dispose stops everything: observer, queries, context listeners, canvases and the frame loop', () => {
  const { surface, observer, fake, scene, overlay, clock, paints } = setup();
  observer.notify(800, 600, { width: 1600, height: 1200 });
  surface.mark(Dirty.Camera);
  assert.equal(clock.pending, 1);

  surface.dispose();
  assert.equal(observer.disconnected, true);
  assert.equal(fake.queries[0].listeners.size, 0);
  for (const canvas of [scene, overlay]) {
    assert.equal(canvas.removed, true);
    assert.equal(canvas.listenerCount('contextlost'), 0);
    assert.equal(canvas.listenerCount('contextrestored'), 0);
  }
  assert.equal(clock.pending, 0, 'the frame that was requested for the pending bits is cancelled');

  surface.mark(Dirty.Hover);
  assert.equal(clock.pending, 0);
  observer.notify(400, 300, { width: 800, height: 600 });
  fake.queries[0].fire();
  clock.frame();
  assert.equal(paints.length, 1, 'no paint after dispose');
  assert.deepEqual([scene.widthWrites, scene.heightWrites], [1, 1], 'and no resize');

  surface.dispose();
});

test('a browser without 2D contexts makes creation fail and adds nothing to the host', () => {
  const clock = createFakeClock();
  const scheduler = createFrameScheduler({ requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame, now: clock.now });
  const fake = createFakeSurfaceEnv({ refuseContext: true });

  assert.throws(
    () => createCanvasSurface({ host: fake.host, scheduler, env: fake.env, paint: () => undefined }),
    /2D canvas context/,
  );
  assert.deepEqual(fake.host.children, ['existing child']);
  assert.equal(fake.observers.length, 0);
  assert.equal(fake.queries.length, 0);
});

test('a failure while setting up leaves the host untouched', () => {
  const clock = createFakeClock();
  const scheduler = createFrameScheduler({ requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame, now: clock.now });
  const fake = createFakeSurfaceEnv();

  assert.throws(
    () =>
      createCanvasSurface({
        host: fake.host,
        scheduler,
        env: {
          ...fake.env,
          createResizeObserver() {
            throw new Error('no ResizeObserver here');
          },
        },
        paint: () => undefined,
      }),
    /no ResizeObserver here/,
  );
  assert.deepEqual(fake.host.children, ['existing child'], 'the canvases are added only once everything else worked');
});

test('without a document the default environment says what to pass', () => {
  const clock = createFakeClock();
  const scheduler = createFrameScheduler({ requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame, now: clock.now });
  assert.equal(Reflect.get(globalThis, 'document'), undefined, 'this test needs a page without a document');
  assert.throws(
    () => createCanvasSurface({ host: createFakeSurfaceEnv().host, scheduler, paint: () => undefined }),
    /env\.createCanvas/,
  );
});
