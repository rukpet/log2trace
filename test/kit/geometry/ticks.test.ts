/**
 * Time-axis ticks: the step ladder, exact tick values, label formats and tick
 * counts for windows from 1e-3 ms to 1e7 ms. The ladder and the "exact
 * decimal" reference are written out here independently of the implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TICKS,
  MIN_TICK_SPACING_PX,
  niceTicks,
  type TickSet,
} from '../../../src/kit/geometry/ticks.ts';

function values(set: TickSet): number[] {
  return set.ticks.map(tick => tick.value);
}

function labels(set: TickSet): string[] {
  return set.ticks.map(tick => tick.label);
}

const CLOCK_STEPS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000,
];
const DAY = 86_400_000;

/** Mantissa of a number in scientific notation: 0.0002 -> 2, 5e6 -> 5, 1.5e4 -> 1.5. */
function mantissaOf(x: number): number {
  return Number(x.toExponential(9).split('e')[0]);
}

/** 1/2/5 x 10^k below one second, the clock table up to 12 h, then 1/2/5 x 10^k days. */
function onLadder(step: number): boolean {
  if (step < 1000) return [1, 2, 5].includes(mantissaOf(step));
  if (CLOCK_STEPS.includes(step)) return true;
  return step > 43_200_000 && [1, 2, 5].includes(mantissaOf(step / DAY));
}

/** The `index`-th multiple of `step`, as the double closest to the exact decimal. */
function multiple(step: number, index: number): number {
  if (step >= 1) return index * step; // integers, exact
  const [mantissa, exponent] = step.toExponential(9).split('e');
  return Number(`${index * Number(mantissa)}e${exponent}`); // e.g. 3 * 5e-2 -> "15e-2" -> 0.15
}

const UNIT_MS: Record<string, number> = { 'µs': 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/** The time a label stands for, in ms. */
function parseLabel(label: string): number {
  const match = /^(-?\d+(?:\.\d+)?)(\S+)$/.exec(label);
  assert.ok(match, `unparseable label ${label}`);
  assert.ok(match[2] in UNIT_MS, `unknown unit in ${label}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

/** Every property that holds for any tick set of a window. */
function assertWellFormed(set: TickSet, t0: number, t1: number, width: number, what: string): void {
  const { ticks, step } = set;
  assert.ok(ticks.length >= 1, `${what}: no ticks`);
  assert.ok(onLadder(step), `${what}: step ${step} is not on the ladder`);

  for (let i = 0; i < ticks.length; i++) {
    const { value, label } = ticks[i];
    assert.ok(value >= t0 && value <= t1, `${what}: tick ${value} outside [${t0}, ${t1}]`);
    assert.equal(value, multiple(step, Math.round(value / step)), `${what}: tick ${value} is not an exact multiple of ${step}`);
    assert.equal(Number(value.toPrecision(12)), value, `${what}: float noise in ${value}`);
    assert.ok(!Object.is(value, -0), `${what}: negative zero`);
    if (i > 0) {
      assert.equal(
        Math.round(value / step) - Math.round(ticks[i - 1].value / step),
        1,
        `${what}: ticks ${ticks[i - 1].value} and ${value} are not neighbours`,
      );
    }

    const fraction = label.split(set.unit)[0].split('.')[1] ?? '';
    assert.equal(fraction.length, set.decimals, `${what}: ${label} should have ${set.decimals} decimals`);
    assert.ok(label.endsWith(set.unit), `${what}: ${label} should end with ${set.unit}`);
    assert.ok(
      Math.abs(parseLabel(label) - value) <= 1e-12 * Math.max(1, Math.abs(value)),
      `${what}: label ${label} does not read as ${value}`,
    );
  }
  assert.equal(new Set(labels(set)).size, ticks.length, `${what}: duplicate labels ${labels(set).join(' ')}`);

  if (width > 0) {
    const spacing = (step * width) / (t1 - t0);
    assert.ok(spacing >= MIN_TICK_SPACING_PX * (1 - 2e-5), `${what}: ticks only ${spacing} px apart`);
  }
}

test('defaults: ticks are at least 100 px apart and at most 12 are shown', () => {
  assert.equal(MIN_TICK_SPACING_PX, 100);
  assert.equal(MAX_TICKS, 12);
});

test('a 1 s window on a 1000 px plot: 100 ms steps, labelled in seconds with one decimal', () => {
  const set = niceTicks(0, 1000, 1000);

  assert.equal(set.step, 100);
  assert.deepEqual(values(set), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.equal(set.unit, 's');
  assert.equal(set.decimals, 1);
  assert.deepEqual(labels(set), ['0.0s', '0.1s', '0.2s', '0.3s', '0.4s', '0.5s', '0.6s', '0.7s', '0.8s', '0.9s', '1.0s']);
});

test('a 100 ms window: 10 ms steps labelled in milliseconds', () => {
  const set = niceTicks(0, 100, 1000);

  assert.equal(set.step, 10);
  assert.equal(set.unit, 'ms');
  assert.equal(set.decimals, 0);
  assert.deepEqual(labels(set), ['0ms', '10ms', '20ms', '30ms', '40ms', '50ms', '60ms', '70ms', '80ms', '90ms', '100ms']);
});

test('a half-millisecond window is labelled in microseconds', () => {
  const set = niceTicks(0, 0.5, 1000);

  assert.equal(set.step, 0.05);
  assert.equal(set.unit, 'µs');
  assert.equal(set.decimals, 0);
  assert.deepEqual(labels(set), ['0µs', '50µs', '100µs', '150µs', '200µs', '250µs', '300µs', '350µs', '400µs', '450µs', '500µs']);
});

test('tick values are exact decimals, not accumulated float noise', () => {
  // 3 * 0.05 is 0.15000000000000002 and 3 * 0.1 is 0.30000000000000004 in doubles.
  assert.deepEqual(values(niceTicks(0, 0.3, 1000)), [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);
  assert.deepEqual(values(niceTicks(0.1, 0.7, 1000)), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  assert.deepEqual(values(niceTicks(0.0003, 0.0009, 1000)), [0.0003, 0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009]);
});

test('a tick exactly on a window edge is kept, even where the index estimate rounds the wrong way', () => {
  // In doubles 0.07 * 100 is 7.000000000000001 and 0.29 * 100 is 28.999999999999996, so the
  // naive first and last tick indices are off by one for these edges.
  const start = niceTicks(0.07, 0.14, 1000);
  assert.equal(start.step, 0.01);
  assert.deepEqual(values(start), [0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14]);

  const end = niceTicks(0.22, 0.29, 1000);
  assert.equal(end.step, 0.01);
  assert.deepEqual(values(end), [0.22, 0.23, 0.24, 0.25, 0.26, 0.27, 0.28, 0.29]);
});

test('a window of whole steps keeps both edge ticks, for every decimal step', () => {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  for (const step of steps) {
    for (let first = 0; first < 400; first++) {
      const t0 = multiple(step, first);
      const t1 = multiple(step, first + 8);
      const set = niceTicks(t0, t1, 1000);
      const what = `[${t0}, ${t1}]`;

      assert.equal(set.step, step, `${what}: step`);
      assert.equal(set.ticks.length, 9, `${what}: tick count`);
      assert.equal(values(set)[0], t0, `${what}: first tick`);
      assert.equal(values(set)[8], t1, `${what}: last tick`);
    }
  }
});

test('deep zoom: labels carry as many decimals as the step needs, so neighbours differ', () => {
  const set = niceTicks(1.234, 1.235, 1000);

  assert.equal(set.step, 1e-4);
  assert.equal(set.decimals, 4);
  assert.deepEqual(labels(set), [
    '1.2340ms', '1.2341ms', '1.2342ms', '1.2343ms', '1.2344ms', '1.2345ms',
    '1.2346ms', '1.2347ms', '1.2348ms', '1.2349ms', '1.2350ms',
  ]);
});

test('deep zoom late in a long trace stays exact and distinct', () => {
  const set = niceTicks(5_000_000, 5_000_000.001, 1000);

  assert.equal(set.unit, 's');
  assert.equal(set.decimals, 7);
  assert.equal(set.ticks[0].label, '5000.0000000s');
  assert.equal(set.ticks[1].label, '5000.0000001s');
  assert.ok(set.ticks.length >= 10 && set.ticks.length <= 12, `got ${set.ticks.length} ticks`);
  assertWellFormed(set, 5_000_000, 5_000_000.001, 1000, 'late deep zoom');
});

test('seconds and minutes use 1/2/5/10/15/30, labelled in whole units', () => {
  const cases: [string, number, number, number, string[]][] = [
    ['90 s', 90_000, 1000, 10_000, ['0s', '10s', '20s', '30s', '40s', '50s', '60s', '70s', '80s', '90s']],
    ['10 min', 600_000, 1200, 60_000, ['0min', '1min', '2min', '3min', '4min', '5min', '6min', '7min', '8min', '9min', '10min']],
    ['3 h', 10_800_000, 1000, 1_800_000, ['0min', '30min', '60min', '90min', '120min', '150min', '180min']],
    ['10 h', 36_000_000, 1000, 3_600_000, ['0h', '1h', '2h', '3h', '4h', '5h', '6h', '7h', '8h', '9h', '10h']],
    ['3 days', 259_200_000, 1000, 43_200_000, ['0h', '12h', '24h', '36h', '48h', '60h', '72h']],
    ['100 days', 8_640_000_000, 1000, 864_000_000, ['0d', '10d', '20d', '30d', '40d', '50d', '60d', '70d', '80d', '90d', '100d']],
  ];
  for (const [what, span, width, step, expected] of cases) {
    const set = niceTicks(0, span, width);
    assert.equal(set.step, step, `${what}: step`);
    assert.deepEqual(labels(set), expected, `${what}: labels`);
  }

  // 15 and 30 are on the ladder between 10 and 60 for both seconds and minutes.
  assert.equal(niceTicks(0, 120_000, 1000).step, 15_000);
  assert.equal(niceTicks(0, 7_200_000, 1000).step, 900_000);
  assert.equal(niceTicks(0, 240_000, 1000).step, 30_000);
});

test('windows from 1e-3 ms to 1e7 ms: 3 to 12 ticks, ladder steps, exact values, distinct labels', () => {
  const total = 1e7;
  let sets = 0;
  for (const width of [800, 1000, 1200, 1600, 1920, 3840]) {
    for (let exponent = -3; exponent <= 7; exponent++) {
      for (const mantissa of [1, 1.2, 1.3, 2, 2.5, 3.7, 5, 7.9]) {
        const length = mantissa * 10 ** exponent;
        if (length < 0.001 || length > total) continue;

        for (const t0 of [0, 0.37 * (total - length), total - length]) {
          const t1 = t0 + length;
          const set = niceTicks(t0, t1, width);
          const what = `window ${length} ms at ${t0}, ${width} px`;

          assert.ok(set.ticks.length >= 3 && set.ticks.length <= MAX_TICKS, `${what}: ${set.ticks.length} ticks`);
          assertWellFormed(set, t0, t1, width, what);
          sets++;
        }
      }
    }
  }
  assert.ok(sets > 1000, `only ${sets} cases ran`);
});

test('the step grows with the window and stays within 2.5x of the ideal', () => {
  const width = 1000;
  let previous = 0;
  for (let length = 0.001; length <= 1e7; length *= 1.05) {
    const { step } = niceTicks(0, length, width);
    const ideal = length / (width / MIN_TICK_SPACING_PX);

    assert.ok(step >= previous, `step shrank from ${previous} to ${step} at ${length} ms`);
    assert.ok(step >= ideal * (1 - 2e-5), `step ${step} puts ticks closer than ${MIN_TICK_SPACING_PX} px at ${length} ms`);
    assert.ok(step < ideal * 2.5, `step ${step} is too coarse at ${length} ms`);
    previous = step;
  }
});

test('the tick count never passes 12, even for a window of exactly 12 steps', () => {
  // Step 1 would fit 13 ticks (0..12) in 1920 px at 148 px apart; the cap takes step 2 instead.
  const set = niceTicks(0, 12, 1920);
  assert.equal(set.step, 2);
  assert.deepEqual(values(set), [0, 2, 4, 6, 8, 10, 12]);

  for (const width of [1920, 3840, 1e6]) {
    for (const exponent of [-3, 0, 3, 6]) {
      const length = 12 * 10 ** exponent;
      const count = niceTicks(0, length, width).ticks.length;
      assert.ok(count >= 3 && count <= MAX_TICKS, `${length} ms at ${width} px: ${count} ticks`);
    }
  }
});

test('narrow and very wide plots keep the tick count in bounds', () => {
  const random = mulberry(7);
  for (let n = 0; n < 500; n++) {
    const length = 10 ** (-3 + random() * 10);
    const t0 = random() * (1e7 - length);

    const narrow = niceTicks(t0, t0 + length, 300);
    assert.ok(narrow.ticks.length >= 1 && narrow.ticks.length <= MAX_TICKS, `300 px, ${length} ms: ${narrow.ticks.length} ticks`);
    assertWellFormed(narrow, t0, t0 + length, 0, `300 px, ${length} ms`);

    for (const width of [5000, 1e8]) {
      const wide = niceTicks(t0, t0 + length, width);
      assert.ok(wide.ticks.length >= 3 && wide.ticks.length <= MAX_TICKS, `${width} px, ${length} ms: ${wide.ticks.length} ticks`);
    }
  }
});

test('options change the spacing and the count limit', () => {
  const loose = niceTicks(0, 1000, 1000);
  const sparse = niceTicks(0, 1000, 1000, { minSpacingPx: 200 });
  assert.equal(loose.ticks.length, 11);
  assert.equal(sparse.step, 200);
  assert.deepEqual(values(sparse), [0, 200, 400, 600, 800, 1000]);

  const capped = niceTicks(0, 1000, 1920, { maxTicks: 4 });
  assert.ok(capped.ticks.length <= 4, `got ${capped.ticks.length} ticks`);

  const fallback = niceTicks(0, 1000, 1000, { minSpacingPx: -5, maxTicks: NaN });
  assert.deepEqual(values(fallback), values(loose));
});

test('windows that cannot have ticks get none, and bad widths still work', () => {
  for (const [t0, t1] of [[5, 5], [10, 5], [NaN, 5], [0, NaN], [0, Infinity], [-Infinity, 0], [0, 1e-12]]) {
    const set = niceTicks(t0, t1, 1000);
    assert.equal(set.step, 0, `window [${t0}, ${t1}]`);
    assert.deepEqual(set.ticks, [], `window [${t0}, ${t1}]`);
  }

  for (const width of [0, -10, NaN, Infinity]) {
    const set = niceTicks(0, 1000, width);
    assertWellFormed(set, 0, 1000, 0, `width ${width}`);
    assert.ok(set.ticks.length >= 1 && set.ticks.length <= MAX_TICKS);
  }
});

test('negative times are labelled with a sign, and zero is never negative zero', () => {
  const set = niceTicks(-5, 5, 1000);

  assert.deepEqual(values(set), [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
  assert.ok(Object.is(values(set)[5], 0));
  assert.equal(labels(set)[0], '-5ms');
  assert.equal(labels(set)[5], '0ms');

  // A window starting just below zero must not produce "-0".
  assert.ok(Object.is(niceTicks(-0.0004, 0.5, 1000).ticks[0].value, 0));
});

/** Deterministic PRNG (mulberry32): same seed, same sequence. */
function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
