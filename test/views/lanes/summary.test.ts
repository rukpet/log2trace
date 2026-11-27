import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSteps, busyOf, idleGapAt, intervalsOf, levelAt, sampleColumns, stepsOfRows,
  type IdleGap, type Steps,
} from '../../../src/views/lanes/model/summary.ts';
import { random } from '../../support/trace-builder.ts';

/** In-flight count at `t` by looking at every interval. */
function brute(starts: readonly number[], ends: readonly number[], t: number): number {
  let count = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= t && t < ends[i]) count++;
  return count;
}

function randomIntervals(seed: number, count: number): { starts: number[]; ends: number[] } {
  const rnd = random(seed);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = Math.floor(rnd() * 200);
    starts.push(s);
    ends.push(s + 1 + Math.floor(rnd() * 40));
  }
  return { starts, ends };
}

function steps(starts: readonly number[], ends: readonly number[]): Steps {
  return buildSteps(Float64Array.from(starts), Float64Array.from(ends));
}

test('no intervals give no steps', () => {
  const s = buildSteps(new Float64Array(0), new Float64Array(0));
  assert.equal(s.times.length, 0);
  assert.equal(s.peak, 0);
  assert.equal(levelAt(s, 5), 0);
});

test('steps go up at starts and down at ends, back-to-back intervals do not overlap', () => {
  const s = steps([0, 5, 10], [5, 10, 20]);
  assert.deepEqual([...s.times], [0, 20]);
  assert.deepEqual([...s.level], [1, 0]);
  assert.equal(s.peak, 1);
});

test('overlapping intervals stack', () => {
  const s = steps([0, 2, 4], [10, 6, 8]);
  assert.deepEqual([...s.times], [0, 2, 4, 6, 8, 10]);
  assert.deepEqual([...s.level], [1, 2, 3, 2, 1, 0]);
  assert.equal(s.peak, 3);
});

test('the step function agrees with a brute-force count on random intervals', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const { starts, ends } = randomIntervals(seed, 150);
    const s = steps(starts, ends);
    for (let t = -5; t < 260; t += 0.5) assert.equal(levelAt(s, t), brute(starts, ends, t), `seed ${seed} t ${t}`);
    assert.equal(s.level[s.level.length - 1], 0);
    for (let k = 1; k < s.times.length; k++) {
      assert.ok(s.times[k] > s.times[k - 1]);
      assert.notEqual(s.level[k], s.level[k - 1], 'equal neighbours are merged');
    }
  }
});

test('column sampling takes the maximum over each slice and agrees with brute force', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { starts, ends } = randomIntervals(seed, 120);
    const s = steps(starts, ends);
    const t0 = 20;
    const t1 = 180;
    const columns = 40;
    const out = new Int32Array(columns);
    const max = sampleColumns(s, t0, t1, columns, out);
    const dt = (t1 - t0) / columns;
    let expectedMax = 0;
    for (let c = 0; c < columns; c++) {
      const a = t0 + c * dt;
      const b = a + dt;
      // the count only changes at interval boundaries, so the maximum is at the slice start or at a boundary inside it
      let expected = brute(starts, ends, a);
      for (const t of [...starts, ...ends]) if (t > a && t < b) expected = Math.max(expected, brute(starts, ends, t));
      assert.equal(out[c], expected, `seed ${seed} column ${c}`);
      expectedMax = Math.max(expectedMax, expected);
    }
    assert.equal(max, expectedMax);
  }
});

test('sampling a window with nothing in it, or before and after the data, gives zeros', () => {
  const s = steps([100], [110]);
  const out = new Int32Array(4).fill(9);
  assert.equal(sampleColumns(s, 0, 50, 4, out), 0);
  assert.deepEqual([...out], [0, 0, 0, 0]);
  assert.equal(sampleColumns(s, 200, 300, 4, out), 0);
  assert.equal(sampleColumns(NO_STEPS_FOR_TEST, 0, 10, 4, out), 0);
});

test('a short interval inside a wide column still shows up', () => {
  const s = steps([50.1], [50.2]);
  const out = new Int32Array(10);
  sampleColumns(s, 0, 100, 10, out);
  assert.deepEqual([...out], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
});

test('a step exactly on a column boundary belongs to the column it starts', () => {
  const s = steps([10], [20]);
  const out = new Int32Array(4);
  sampleColumns(s, 0, 40, 4, out);
  assert.deepEqual([...out], [0, 1, 0, 0]);
});

test('busy stretches are the union of the intervals and idle gaps lie between them', () => {
  const s = steps([0, 5, 30, 50], [10, 12, 35, 60]);
  const busy = busyOf(s);
  assert.deepEqual([...busy.from], [0, 30, 50]);
  assert.deepEqual([...busy.to], [12, 35, 60]);
  assert.equal(busy.totalMs, 12 + 5 + 10);

  const gap: IdleGap = { from: 0, to: 0 };
  assert.equal(idleGapAt(busy, 20, gap), true);
  assert.deepEqual(gap, { from: 12, to: 30 });
  assert.equal(idleGapAt(busy, 40, gap), true);
  assert.deepEqual(gap, { from: 35, to: 50 });
  assert.equal(idleGapAt(busy, 12, gap), true, 'the end of a stretch is idle');
  assert.equal(idleGapAt(busy, 30, gap), false, 'the start of a stretch is busy');
  assert.equal(idleGapAt(busy, 8, gap), false, 'inside a stretch');
  assert.equal(idleGapAt(busy, -5, gap), false, 'before the first stretch');
  assert.equal(idleGapAt(busy, 70, gap), false, 'after the last stretch');
});

test('an empty lane has no busy time and no gaps', () => {
  const busy = busyOf(steps([], []));
  assert.equal(busy.totalMs, 0);
  assert.equal(idleGapAt(busy, 1, { from: 0, to: 0 }), false);
});

test('intervals of rows give instants and inverted spans a tiny width', () => {
  const start = Float64Array.of(10, 20, 30);
  const end = Float64Array.of(10, 15, 40);
  const { starts, ends } = intervalsOf(Int32Array.of(0, 1, 2), 0, 3, start, end);
  for (let k = 0; k < 3; k++) assert.ok(ends[k] > starts[k]);
  const s = buildSteps(starts, ends);
  assert.equal(s.peak, 1);
  assert.equal(levelAt(s, 10), 1);
});

test('with a mask only matched rows count', () => {
  const start = Float64Array.of(0, 0, 0, 20);
  const end = Float64Array.of(10, 10, 10, 30);
  const rows = Int32Array.of(0, 1, 2, 3);
  const all = stepsOfRows(rows, 0, 4, start, end);
  assert.equal(all.peak, 3);

  const matched = stepsOfRows(rows, 0, 4, start, end, Uint8Array.of(1, 0, 0, 1));
  assert.equal(matched.peak, 1);
  assert.equal(levelAt(matched, 5), 1);
  assert.equal(levelAt(matched, 25), 1);
  assert.equal(levelAt(matched, 15), 0);

  const none = stepsOfRows(rows, 0, 4, start, end, new Uint8Array(4));
  assert.equal(none.peak, 0);
  assert.equal(none.times.length, 0);

  const partial = stepsOfRows(rows, 1, 3, start, end);
  assert.equal(partial.peak, 2, 'only the rows of the range count');
});

const NO_STEPS_FOR_TEST = buildSteps(new Float64Array(0), new Float64Array(0));
