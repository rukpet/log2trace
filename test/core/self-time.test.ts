import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, createTraceStore } from '../../src/core/index.ts';
import { computeSpanTimings, spanTimings } from '../../src/core/self-time.ts';
import { span, trace } from '../support/trace-builder.ts';

test('computes exact interval-union self-time for overlapping and sequential children', () => {
  // root: [0, 100]
  //   c1: [10, 50]  (40ms)
  //   c2: [30, 70]  (40ms, overlaps c1 on [30, 50]) -> union with c1 is [10, 70] = 60ms
  //   c3: [80, 90]  (10ms, disjoint) -> total covered = 70ms -> root self = 30ms
  //     gc1: [82, 88] (6ms) -> c3 self = 4ms
  const index = buildSpanIndex(
    trace([
      'svc',
      [
        span('root', undefined, 0, 100),
        span('c1', 'root', 10, 50),
        span('c2', 'root', 30, 70),
        span('c3', 'root', 80, 90),
        span('gc1', 'c3', 82, 88),
      ],
    ]),
  );

  const timings = computeSpanTimings(index, null);
  const rowOf = (id: string): number => index.spans.get(id)?.idx ?? -1;

  assert.equal(timings.activeCount, 5);
  assert.equal(timings.duration[rowOf('root')], 100);
  assert.equal(timings.selfTime[rowOf('root')], 30);
  assert.equal(timings.selfTime[rowOf('c1')], 40);
  assert.equal(timings.selfTime[rowOf('c2')], 40);
  assert.equal(timings.selfTime[rowOf('c3')], 4);
  assert.equal(timings.selfTime[rowOf('gc1')], 6);
  assert.equal(timings.totalSelfMs, 30 + 40 + 40 + 4 + 6);
  assert.equal(timings.maxDurationMs, 100);
});

test('clamps children extending past parent bounds (clock skew) without negative self-time', () => {
  // parent: [20, 60] (40ms)
  // child:  [10, 80] (70ms, extends before and after parent) -> covers [20, 60] of parent -> parent self = 0
  const index = buildSpanIndex(
    trace([
      'svc',
      [
        span('parent', undefined, 20, 60),
        span('child', 'parent', 10, 80),
      ],
    ]),
  );

  const timings = computeSpanTimings(index, null);
  const rowOf = (id: string): number => index.spans.get(id)?.idx ?? -1;

  assert.equal(timings.duration[rowOf('parent')], 40);
  assert.equal(timings.selfTime[rowOf('parent')], 0);
  assert.equal(timings.duration[rowOf('child')], 70);
  assert.equal(timings.selfTime[rowOf('child')], 70);
});

test('handles zero-duration and inverted spans safely with and without a time window', () => {
  // instant-in:  [25, 25] -> duration 0, active in [20, 40]
  // instant-out: [50, 50] -> duration 0, outside [20, 40]
  // inverted:    [30, 10] -> clamped duration 0, active in [20, 40]
  // normal:      [0, 100] -> clipped to [20, 40] = 20ms
  const index = buildSpanIndex(
    trace([
      'svc',
      [
        span('normal', undefined, 0, 100),
        span('instant-in', 'normal', 25, 25),
        span('inverted', 'normal', 30, 10),
        span('instant-out', 'normal', 50, 50),
      ],
    ]),
  );

  const full = computeSpanTimings(index, null);
  assert.equal(full.activeCount, 4);
  for (let r = 0; r < index.size; r++) assert.equal(full.inWindow[r], 1);
  assert.equal(full.duration[index.spans.get('inverted')?.idx ?? 0], 0);
  assert.equal(full.selfTime[index.spans.get('inverted')?.idx ?? 0], 0);

  const win = computeSpanTimings(index, { t0: 20, t1: 40 });
  const rowOf = (id: string): number => index.spans.get(id)?.idx ?? -1;
  assert.equal(win.activeCount, 3);
  assert.equal(win.inWindow[rowOf('normal')], 1);
  assert.equal(win.inWindow[rowOf('instant-in')], 1);
  assert.equal(win.inWindow[rowOf('inverted')], 1);
  assert.equal(win.inWindow[rowOf('instant-out')], 0);
  assert.equal(win.duration[rowOf('normal')], 20);
  assert.equal(win.selfTime[rowOf('normal')], 20);
});

test('spanTimings selector caches across unrelated slices and recomputes on window change', () => {
  const index = buildSpanIndex(
    trace(['svc', [span('a', undefined, 0, 100), span('b', 'a', 20, 60)]]),
  );
  const store = createTraceStore();
  store.setData(index);

  const first = store.derive(spanTimings);
  store.setSelection(['a']);
  assert.strictEqual(store.derive(spanTimings), first, 'selection change keeps cached timings');

  store.setWindow({ t0: 10, t1: 50 });
  const second = store.derive(spanTimings);
  assert.notStrictEqual(second, first);
  assert.equal(second.duration[0], 40);
  assert.equal(second.duration[1], 30);
  assert.equal(second.selfTime[0], 10);
});
