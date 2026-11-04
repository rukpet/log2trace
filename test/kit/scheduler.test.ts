/**
 * The frame scheduler: one frame request for any number of clients, no frame
 * without dirty bits, the order of a frame (scheduled flushes, then paints),
 * kept bits, errors, disposal, the stats ring, and use as the trace store's
 * `schedule` option. Time and frames come from a fake clock the test drives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Slice, createTraceStore } from '../../src/core.ts';
import {
  DEFAULT_STATS_WINDOW,
  Dirty,
  FRAME_EMA_ALPHA,
  createFrameScheduler,
  getFrameScheduler,
  type FrameClient,
  type FrameScheduler,
} from '../../src/kit/scheduler.ts';
import { createFakeClock, type FakeClock } from '../support/fake-frame.ts';

function setup(statsWindow?: number): { clock: FakeClock; scheduler: FrameScheduler } {
  const clock = createFakeClock();
  const scheduler = createFrameScheduler({
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    now: clock.now,
    statsWindow,
  });
  return { clock, scheduler };
}

/** A client that records the bits of every paint, and optionally a name in a shared log. */
function recorder(log?: string[], name = 'paint'): { client: FrameClient; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    client: {
      paint(dirty) {
        calls.push(dirty);
        log?.push(name);
      },
    },
  };
}

test('the Dirty bits are distinct single bits and All covers them', () => {
  const bits = [Dirty.Size, Dirty.Theme, Dirty.Rows, Dirty.Scroll, Dirty.Camera, Dirty.Selection, Dirty.Hover];
  let seen = 0;
  for (const bit of bits) {
    assert.equal(bit & (bit - 1), 0, `${bit} is a single bit`);
    assert.equal(seen & bit, 0, `${bit} is not used twice`);
    seen |= bit;
  }
  assert.equal(Dirty.All & seen, seen);
  assert.ok(Dirty.All > 0 && (Dirty.All | (1 << 20)) === Dirty.All, 'All is positive and covers bits a painter adds itself');
});

test('many clients share one frame request and each paints once with all its bits', () => {
  const { clock, scheduler } = setup();
  const clients = Array.from({ length: 5 }, () => recorder());
  const handles = clients.map((c) => scheduler.register(c.client));

  handles.forEach((handle, i) => {
    handle.mark(Dirty.Camera);
    if (i % 2 === 0) handle.mark(Dirty.Hover);
  });
  assert.equal(clock.requests, 1, 'seven marks, one requestAnimationFrame');
  assert.equal(clock.pending, 1);
  assert.ok(clients.every((c) => c.calls.length === 0), 'nothing paints before the frame');

  assert.equal(clock.frame(), 1, 'one callback runs the whole frame');
  clients.forEach((c, i) => {
    assert.deepEqual(c.calls, [i % 2 === 0 ? Dirty.Camera | Dirty.Hover : Dirty.Camera], `client ${i}`);
  });
  assert.equal(clock.requests, 1, 'nothing is dirty afterwards, so no further request');
  assert.equal(clock.pending, 0);
});

test('clients paint in the order they registered, whatever the order of the marks', () => {
  const { clock, scheduler } = setup();
  const log: string[] = [];
  const handles = ['a', 'b', 'c'].map((name) => scheduler.register(recorder(log, name).client));

  handles[2].mark(Dirty.Size);
  handles[0].mark(Dirty.Size);
  handles[1].mark(Dirty.Size);
  clock.frame();
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('no frame is requested while nothing is dirty', () => {
  const { clock, scheduler } = setup();
  const painter = recorder();
  const handle = scheduler.register(painter.client);
  scheduler.register(recorder().client);
  assert.equal(clock.requests, 0, 'registering requests nothing');

  handle.mark(0);
  assert.equal(clock.requests, 0, 'marking no bits requests nothing');
  assert.equal(handle.dirty, 0);

  handle.mark(Dirty.Scroll);
  assert.equal(handle.dirty, Dirty.Scroll);
  clock.frame();
  assert.deepEqual(painter.calls, [Dirty.Scroll]);
  assert.equal(handle.dirty, 0);
  assert.equal(clock.requests, 1);
  assert.equal(clock.frame(), 0, 'an idle page runs no frame callbacks');
  assert.equal(scheduler.stats().frames, 1, 'and records no empty frames');
});

test('bits marked during a paint wait for the next frame, which is requested once', () => {
  const { clock, scheduler } = setup();
  const calls: number[] = [];
  const client: FrameClient = {
    paint(dirty) {
      calls.push(dirty);
      if (calls.length === 1) {
        handle.mark(Dirty.Hover);
        handle.mark(Dirty.Hover);
      }
    },
  };
  const handle = scheduler.register(client);

  handle.mark(Dirty.Camera);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Camera], 'the mark made while painting is not painted in this frame');
  assert.equal(clock.pending, 1);
  assert.equal(clock.requests, 2);

  clock.frame();
  assert.deepEqual(calls, [Dirty.Camera, Dirty.Hover]);
  assert.equal(clock.pending, 0, 'and the loop stops once nothing is marked');
});

test('a client marked by one that paints after it waits for the next frame', () => {
  const { clock, scheduler } = setup();
  const first = recorder();
  const second = recorder();
  const firstHandle = scheduler.register(first.client);
  const secondHandle = scheduler.register(second.client);
  const trigger = scheduler.register({
    paint() {
      firstHandle.mark(Dirty.Theme);
      secondHandle.mark(Dirty.Theme);
    },
  });

  trigger.mark(Dirty.Size);
  clock.frame();
  assert.deepEqual(first.calls, [], 'registered before the trigger: its turn has passed');
  assert.deepEqual(second.calls, []);
  assert.equal(clock.pending, 1, 'so one more frame is requested');

  clock.frame();
  assert.deepEqual(first.calls, [Dirty.Theme]);
  assert.deepEqual(second.calls, [Dirty.Theme]);
  assert.equal(clock.pending, 0);
});

test('a client marked by one that paints before it is painted in the same frame', () => {
  const { clock, scheduler } = setup();
  const follower = recorder();
  const trigger = scheduler.register({
    paint() {
      followerHandle.mark(Dirty.Theme);
    },
  });
  const followerHandle = scheduler.register(follower.client);

  trigger.mark(Dirty.Size);
  clock.frame();
  assert.deepEqual(follower.calls, [Dirty.Theme]);
  assert.equal(clock.requests, 1, 'no extra frame for work the running frame took');
  assert.equal(clock.pending, 0);
});

test('a mark made by a scheduled flush is painted in the same frame, after the flush', () => {
  const { clock, scheduler } = setup();
  const log: string[] = [];
  const painter = recorder(log);
  const handle = scheduler.register(painter.client);

  scheduler.schedule(() => {
    log.push('flush');
    handle.mark(Dirty.Selection);
  });
  assert.equal(clock.requests, 1, 'scheduling a flush asks for a frame');
  assert.deepEqual(log, [], 'nothing runs before the frame');

  clock.frame();
  assert.deepEqual(log, ['flush', 'paint']);
  assert.deepEqual(painter.calls, [Dirty.Selection]);
  assert.equal(clock.requests, 1, 'the mark did not ask for a second frame');
  assert.equal(clock.pending, 0);
});

test('scheduled callbacks run once each, in the order they were queued, before any paint', () => {
  const { clock, scheduler } = setup();
  const log: string[] = [];
  const handle = scheduler.register(recorder(log).client);

  handle.mark(Dirty.Size);
  scheduler.schedule(() => log.push('first'));
  scheduler.schedule(() => log.push('second'));
  scheduler.schedule(() => log.push('third'));
  assert.equal(clock.requests, 1);

  clock.frame();
  assert.deepEqual(log, ['first', 'second', 'third', 'paint']);
  clock.frame();
  assert.deepEqual(log, ['first', 'second', 'third', 'paint'], 'a callback runs once');
});

test('a callback queued by a callback runs in the same frame; a runaway chain is cut off and goes on next frame', () => {
  const { clock, scheduler } = setup();
  const log: string[] = [];
  scheduler.schedule(() => {
    log.push('a');
    scheduler.schedule(() => {
      log.push('b');
      scheduler.schedule(() => log.push('c'));
    });
  });
  clock.frame();
  assert.deepEqual(log, ['a', 'b', 'c']);
  assert.equal(clock.pending, 0);

  let runs = 0;
  const again = (): void => {
    runs++;
    scheduler.schedule(again);
  };
  scheduler.schedule(again);
  clock.frame();
  const firstFrame = runs;
  assert.ok(firstFrame > 1 && firstFrame < 100, `the frame ran ${firstFrame} rounds and stopped`);
  assert.equal(clock.pending, 1, 'the rest was handed to the next frame');
  clock.frame();
  assert.equal(runs, 2 * firstFrame);
});

test('works as the schedule option of the trace store: one flush and one frame per tick', () => {
  const { clock, scheduler } = setup();
  const log: string[] = [];
  const store = createTraceStore({ schedule: scheduler.schedule });
  const painter = recorder(log);
  const handle = scheduler.register(painter.client);
  const masks: number[] = [];
  store.subscribe((change) => {
    log.push('notify');
    masks.push(change.mask);
    handle.mark(Dirty.Rows);
  });

  store.setPhase('loading');
  store.setPhase('error', 'boom');
  assert.equal(store.state.data.phase, 'error', 'state is current at once');
  assert.deepEqual(masks, [], 'notifications wait for the frame');
  assert.equal(clock.requests, 1, 'two changes, one frame');

  clock.frame();
  assert.deepEqual(log, ['notify', 'paint'], 'listeners run first, so the paint sees their marks');
  assert.deepEqual(masks, [Slice.Data], 'the two changes arrive merged');
  assert.deepEqual(painter.calls, [Dirty.Rows]);
  assert.equal(clock.requests, 1);
  assert.equal(clock.pending, 0);

  store.setPhase('ready');
  assert.equal(clock.requests, 2, 'the next change asks for the next frame');
  clock.frame();
  assert.deepEqual(masks, [Slice.Data, Slice.Data]);
  assert.deepEqual(painter.calls, [Dirty.Rows, Dirty.Rows]);

  store.flushSync();
  assert.equal(masks.length, 2, 'nothing is left to deliver');
});

test('a paint can keep bits without asking for a frame, and gets them again with the next mark', () => {
  const { clock, scheduler } = setup();
  let ready = false;
  const calls: number[] = [];
  const handle = scheduler.register({
    paint(dirty) {
      calls.push(dirty);
      if (!ready) return dirty;
    },
  });

  handle.mark(Dirty.Camera);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Camera]);
  assert.equal(handle.dirty, Dirty.Camera, 'the bits were kept');
  assert.equal(clock.pending, 0, 'keeping bits does not request a frame');
  assert.equal(clock.frame(), 0);
  assert.equal(calls.length, 1);

  ready = true;
  handle.mark(Dirty.Hover);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Camera, Dirty.Camera | Dirty.Hover], 'kept and new bits arrive together');
  assert.equal(handle.dirty, 0);
});

test('a paint that handles part of the bits keeps the rest', () => {
  const { clock, scheduler } = setup();
  const calls: number[] = [];
  const handle = scheduler.register({
    paint(dirty) {
      calls.push(dirty);
      return dirty & Dirty.Theme;
    },
  });

  handle.mark(Dirty.Theme | Dirty.Camera);
  clock.frame();
  assert.equal(handle.dirty, Dirty.Theme);
  handle.mark(Dirty.Hover);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Theme | Dirty.Camera, Dirty.Theme | Dirty.Hover]);
});

test('paintNow paints the pending bits at once and the frame does not paint them again', () => {
  const { clock, scheduler } = setup();
  const painter = recorder();
  const handle = scheduler.register(painter.client);

  handle.paintNow();
  assert.deepEqual(painter.calls, [], 'nothing pending, nothing painted');

  handle.mark(Dirty.Size | Dirty.Camera);
  assert.equal(clock.pending, 1);
  handle.paintNow();
  assert.deepEqual(painter.calls, [Dirty.Size | Dirty.Camera]);
  assert.equal(handle.dirty, 0);
  assert.equal(clock.pending, 0, 'the frame requested for those bits is not needed any more');
  assert.equal(clock.cancels, 1);

  assert.equal(clock.frame(), 0);
  assert.deepEqual(painter.calls, [Dirty.Size | Dirty.Camera]);
  assert.equal(scheduler.stats().frames, 0, 'nothing ran, so no frame is counted');
});

test('paintNow leaves the frame in place when another client still needs it, and that frame does not paint the bits again', () => {
  const { clock, scheduler } = setup();
  const now = recorder();
  const other = recorder();
  const nowHandle = scheduler.register(now.client);
  const otherHandle = scheduler.register(other.client);

  nowHandle.mark(Dirty.Size);
  otherHandle.mark(Dirty.Hover);
  nowHandle.paintNow();
  assert.equal(clock.cancels, 0);
  assert.equal(clock.pending, 1);

  clock.frame();
  assert.deepEqual(now.calls, [Dirty.Size], 'painted once, by paintNow');
  assert.deepEqual(other.calls, [Dirty.Hover]);
});

test('paintNow from inside the same client\'s paint does not recurse: the bits wait for the next frame', () => {
  const { clock, scheduler } = setup();
  const calls: number[] = [];
  const handle = scheduler.register({
    paint(dirty) {
      calls.push(dirty);
      if (calls.length === 1) {
        handle.mark(Dirty.Hover);
        handle.paintNow();
      }
    },
  });

  handle.mark(Dirty.Size);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Size]);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Size, Dirty.Hover]);
  assert.equal(clock.pending, 0);
});

test('a client that throws does not stop the others or the loop', () => {
  const { clock, scheduler } = setup();
  const bad = scheduler.register({
    paint() {
      throw new Error('boom');
    },
  });
  const good = recorder();
  const goodHandle = scheduler.register(good.client);

  bad.mark(Dirty.Camera);
  goodHandle.mark(Dirty.Camera);
  assert.throws(() => clock.frame(), /boom/, 'the error surfaces once the frame is done');
  assert.deepEqual(good.calls, [Dirty.Camera], 'the other client still painted');
  assert.equal(bad.dirty, 0, 'a failed paint is not retried on every frame');
  assert.equal(clock.pending, 0);
  assert.equal(scheduler.stats().frames, 1, 'the failed frame is counted');

  goodHandle.mark(Dirty.Hover);
  clock.frame();
  assert.deepEqual(good.calls, [Dirty.Camera, Dirty.Hover], 'the loop still runs');
});

test('a scheduled callback that throws does not stop the other callbacks or the paints', () => {
  const { clock, scheduler } = setup();
  const log: string[] = [];
  const painter = recorder(log);
  const handle = scheduler.register(painter.client);

  handle.mark(Dirty.Size);
  scheduler.schedule(() => {
    throw new Error('first flush failed');
  });
  scheduler.schedule(() => log.push('second flush'));
  assert.throws(() => clock.frame(), /first flush failed/);
  assert.deepEqual(log, ['second flush', 'paint']);
  assert.equal(clock.pending, 0);
});

test('paintNow lets the error of a paint reach its caller and drops the bits', () => {
  const { clock, scheduler } = setup();
  const handle = scheduler.register({
    paint() {
      throw new Error('boom');
    },
  });
  handle.mark(Dirty.Size);
  assert.throws(() => handle.paintNow(), /boom/);
  assert.equal(handle.dirty, 0);
  clock.frame();
});

test('dispose stops painting and cancels a frame that only that client needed', () => {
  const { clock, scheduler } = setup();
  const painter = recorder();
  const handle = scheduler.register(painter.client);

  handle.mark(Dirty.Camera);
  handle.dispose();
  assert.equal(clock.cancels, 1);
  assert.equal(clock.pending, 0);
  assert.equal(handle.dirty, 0, 'pending bits are dropped');

  handle.mark(Dirty.Camera);
  handle.paintNow();
  handle.dispose();
  assert.equal(clock.requests, 1, 'a disposed handle requests nothing');
  assert.equal(clock.cancels, 1);
  assert.deepEqual(painter.calls, []);
});

test('dispose leaves the frame alone while another client or a callback still needs it', () => {
  const { clock, scheduler } = setup();
  const a = recorder();
  const b = recorder();
  const ha = scheduler.register(a.client);
  const hb = scheduler.register(b.client);

  ha.mark(Dirty.Camera);
  hb.mark(Dirty.Hover);
  ha.dispose();
  assert.equal(clock.cancels, 0);
  clock.frame();
  assert.deepEqual(a.calls, []);
  assert.deepEqual(b.calls, [Dirty.Hover]);

  const hc = scheduler.register(recorder().client);
  hc.mark(Dirty.Size);
  let flushed = false;
  scheduler.schedule(() => {
    flushed = true;
  });
  hc.dispose();
  assert.equal(clock.cancels, 0, 'a queued callback keeps the frame');
  clock.frame();
  assert.ok(flushed);
});

test('a client can dispose another one, or itself, in the middle of a frame', () => {
  const { clock, scheduler } = setup();
  const victim = recorder();
  const survivor = recorder();
  const calls: number[] = [];
  const killer = scheduler.register({
    paint(dirty) {
      calls.push(dirty);
      victimHandle.dispose();
      killer.dispose();
    },
  });
  const victimHandle = scheduler.register(victim.client);
  const survivorHandle = scheduler.register(survivor.client);

  killer.mark(Dirty.Size);
  victimHandle.mark(Dirty.Size);
  survivorHandle.mark(Dirty.Size);
  clock.frame();
  assert.deepEqual(calls, [Dirty.Size]);
  assert.deepEqual(victim.calls, [], 'disposed before its turn, so it never paints');
  assert.deepEqual(survivor.calls, [Dirty.Size]);

  survivorHandle.mark(Dirty.Hover);
  clock.frame();
  assert.deepEqual(survivor.calls, [Dirty.Size, Dirty.Hover], 'the list still works after the removals');
  assert.deepEqual(calls, [Dirty.Size], 'the client that removed itself is gone');
});

test('stats record what each frame cost, not the time between frames', () => {
  const { clock, scheduler } = setup();
  const empty = scheduler.stats();
  assert.deepEqual(empty, { frames: 0, recent: [], last: 0, mean: 0, p95: 0, max: 0, ema: 0 });

  const costs = [4, 2, 10, 6];
  const handle = scheduler.register({
    paint() {
      clock.advance(costs.shift() ?? 0);
    },
  });
  for (let i = 0; i < 4; i++) {
    handle.mark(Dirty.Camera);
    clock.frame();
  }

  const stats = scheduler.stats();
  assert.equal(stats.frames, 4);
  assert.deepEqual(stats.recent, [4, 2, 10, 6]);
  assert.equal(stats.last, 6);
  assert.equal(stats.mean, 5.5);
  assert.equal(stats.max, 10);
  assert.equal(stats.p95, 10, 'nearest rank: ceil(0.95 * 4) = 4th of 4');

  let ema = 4;
  for (const cost of [2, 10, 6]) ema += FRAME_EMA_ALPHA * (cost - ema);
  assert.ok(Math.abs(stats.ema - ema) < 1e-12, `ema ${stats.ema} vs ${ema}`);
});

test('stats cover the flush phase too, and p95 uses the nearest rank', () => {
  const { clock, scheduler } = setup();
  for (let i = 1; i <= 20; i++) {
    scheduler.schedule(() => clock.advance(i));
    clock.frame();
  }
  const stats = scheduler.stats();
  assert.equal(stats.frames, 20);
  assert.equal(stats.p95, 19, 'ceil(0.95 * 20) = 19th of 20');
  assert.equal(stats.max, 20);
  assert.equal(stats.mean, 10.5);
});

test('the stats ring keeps only the newest frames, oldest first, and counts them all', () => {
  const { clock, scheduler } = setup(3);
  for (let cost = 1; cost <= 5; cost++) {
    scheduler.schedule(() => clock.advance(cost));
    clock.frame();
  }
  const stats = scheduler.stats();
  assert.equal(stats.frames, 5);
  assert.deepEqual(stats.recent, [3, 4, 5]);
  assert.equal(stats.last, 5);
  assert.equal(stats.mean, 4);
  assert.equal(stats.max, 5);
});

test('the stats window defaults when it is not a usable number', () => {
  for (const wanted of [undefined, 0, -4, NaN, Infinity]) {
    const { clock, scheduler } = setup(wanted);
    for (let i = 0; i < DEFAULT_STATS_WINDOW + 10; i++) {
      scheduler.schedule(() => clock.advance(1));
      clock.frame();
    }
    assert.equal(scheduler.stats().recent.length, DEFAULT_STATS_WINDOW, `statsWindow ${String(wanted)}`);
  }
  const { clock, scheduler } = setup(2.9);
  for (let i = 0; i < 5; i++) {
    scheduler.schedule(() => clock.advance(1));
    clock.frame();
  }
  assert.equal(scheduler.stats().recent.length, 2, 'a fractional window rounds down');
});

test('a scheduler without a requestAnimationFrame says what to inject', () => {
  const handle = createFrameScheduler().register({ paint: () => undefined });
  assert.throws(() => handle.mark(Dirty.Size), /requestFrame/);
  assert.equal(handle.dirty, Dirty.Size, 'the bits are kept, so a retry works once there is a frame source');
});

test('the shared scheduler is one object and requests the page\'s single animation frame for all clients', () => {
  const requested: Array<(time: number) => void> = [];
  const cancelled: number[] = [];
  const saved = ['requestAnimationFrame', 'cancelAnimationFrame'].map((name) => [name, Reflect.get(globalThis, name)] as const);
  Reflect.set(globalThis, 'requestAnimationFrame', (callback: (time: number) => void) => requested.push(callback));
  Reflect.set(globalThis, 'cancelAnimationFrame', (handle: number) => cancelled.push(handle));
  try {
    const scheduler = getFrameScheduler();
    assert.equal(getFrameScheduler(), scheduler, 'every caller gets the same scheduler');

    const a = recorder();
    const b = recorder();
    const ha = scheduler.register(a.client);
    const hb = scheduler.register(b.client);
    assert.equal(requested.length, 0, 'creating and registering touched nothing');

    ha.mark(Dirty.Camera);
    hb.mark(Dirty.Hover);
    scheduler.schedule(() => undefined);
    assert.equal(requested.length, 1, 'one requestAnimationFrame for both clients and a callback');

    requested[0](0);
    assert.deepEqual(a.calls, [Dirty.Camera]);
    assert.deepEqual(b.calls, [Dirty.Hover]);
    assert.equal(requested.length, 1);

    ha.mark(Dirty.Size);
    ha.dispose();
    assert.deepEqual(cancelled, [2], 'dispose cancels through the page\'s cancelAnimationFrame');
    hb.dispose();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else Reflect.set(globalThis, name, value);
    }
  }
});
