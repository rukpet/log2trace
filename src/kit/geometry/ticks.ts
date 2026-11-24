/**
 * Kit geometry: time-axis ticks
 *
 * "Nice" tick marks for a time window: a step from a human-friendly ladder
 * (1-2-5 x 10^k below one second; 1/2/5/10/15/30 for seconds and for minutes;
 * 1/2/3/6/12 for hours; 1-2-5 x 10^k days beyond that), tick values that are
 * exact multiples of the step, and labels whose decimals follow from the step,
 * so neighbouring labels never collapse into each other at deep zoom.
 *
 * Pure functions with no DOM: the canvas and DOM painters draw from the same
 * {@link TickSet}, and tests run in plain Node.
 */

/** Closest two ticks are placed, px. A label is about 60-80 px wide. */
export const MIN_TICK_SPACING_PX = 100;

/** Most ticks one axis shows. */
export const MAX_TICKS = 12;

/** Windows shorter than this (ms) are too small for the arithmetic to be meaningful and get no ticks. */
const MIN_SPAN_MS = 1e-9;

/**
 * How much (relative) smaller than ideal a step may be. Without it, float
 * noise in the ends of a round window (1.235 - 1.234 is 0.001000000000000112)
 * would bump the step up a rung, halving the tick count for no visible gain.
 * Doubles near 1e7 are only ~1e-6 of a 0.001 ms window apart, hence 1e-5.
 */
const STEP_TOLERANCE = 1e-5;

/** Hard ceiling for `TickOptions.maxTicks`. */
const MAX_TICKS_LIMIT = 100;

/** The 1-2-5 mantissas of the decimal ladder. */
const MANTISSAS = [1, 2, 5] as const;

/** Largest decimal step (ms); the clock ladder takes over above it. */
const MAX_DECIMAL_STEP_MS = 500;

/** Steps from one second to twelve hours, ms. */
const CLOCK_STEPS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000,
];

const DAY_MS = 86_400_000;

/** Options for {@link niceTicks}. */
export interface TickOptions {
  /** Closest two ticks may be placed, px. Default {@link MIN_TICK_SPACING_PX}. */
  readonly minSpacingPx?: number;
  /** Most ticks to return, at least 2. Default {@link MAX_TICKS}. */
  readonly maxTicks?: number;
}

/** One tick mark. */
export interface Tick {
  /** Position on the time axis, ms. An exact decimal multiple of the step. */
  readonly value: number;
  /** Text for the axis, e.g. `250ms` or `1.5s`. */
  readonly label: string;
}

/** Ticks for one window, with the step and label format they share. */
export interface TickSet {
  /** Distance between neighbouring ticks, ms; 0 when there are no ticks. */
  readonly step: number;
  /** Unit suffix used by every label: `µs`, `ms`, `s`, `min`, `h` or `d`. */
  readonly unit: string;
  /** Digits after the decimal point in every label. */
  readonly decimals: number;
  /** Ticks in ascending order, all inside the requested window. */
  readonly ticks: readonly Tick[];
}

/**
 * One rung of the ladder. Tick `i` sits at `i * num / den` ms: an integer
 * divided by a power of ten (or just an integer), which is the closest double
 * to the exact decimal, so ticks carry none of the noise of `i * 0.1`.
 */
interface Step {
  readonly num: number;
  readonly den: number;
  /** Step length in ms. */
  readonly ms: number;
  /** Decimal exponent of the 1-2-5 step; only meaningful below one second. */
  readonly exp: number;
}

/** A unit labels are written in. `exp` is the decimal exponent of `ms`. */
interface Unit {
  readonly suffix: string;
  readonly ms: number;
  readonly exp: number;
}

// Written as an escape so the source stays ASCII; U+00B5 is the micro sign.
const MICROSECOND: Unit = { suffix: 'µs', ms: 0.001, exp: -3 };
const MILLISECOND: Unit = { suffix: 'ms', ms: 1, exp: 0 };
const SECOND: Unit = { suffix: 's', ms: 1_000, exp: 3 };

/** Units for clock steps (one second and up), largest first. */
const CLOCK_UNITS: readonly Unit[] = [
  { suffix: 'd', ms: DAY_MS, exp: 0 },
  { suffix: 'h', ms: 3_600_000, exp: 0 },
  { suffix: 'min', ms: 60_000, exp: 0 },
  SECOND,
];

const NO_TICKS: TickSet = Object.freeze({
  step: 0,
  unit: MILLISECOND.suffix,
  decimals: 0,
  ticks: Object.freeze([]),
});

/**
 * Nice ticks for a time window.
 *
 * The step is the smallest rung of the ladder that keeps ticks at least
 * `minSpacingPx` apart (give or take 1e-5, so float noise in the ends of a
 * round window cannot bump it up a rung) and the count within `maxTicks`.
 * Rungs are at most 2.5x apart, so on a plot of 750 px or more the default
 * settings give 3 to 12 ticks; a narrower plot gets fewer, at least one. Tick
 * values are `i * step` computed exactly (no float noise), and every label
 * uses the same unit and decimals, so neighbouring labels differ at any zoom.
 *
 * A window that is empty, reversed, not finite or shorter than 1e-9 ms gets no ticks.
 *
 * @param t0 - Window start, ms.
 * @param t1 - Window end, ms.
 * @param widthPx - Plot width in px; anything that is not positive and finite is treated as 0.
 * @param options - Spacing and count limits.
 */
export function niceTicks(t0: number, t1: number, widthPx: number, options: TickOptions = {}): TickSet {
  const span = t1 - t0;
  if (!Number.isFinite(t0) || !(span >= MIN_SPAN_MS) || !(span < Infinity)) return NO_TICKS;

  const minSpacing = options.minSpacingPx !== undefined && options.minSpacingPx > 0
    ? options.minSpacingPx
    : MIN_TICK_SPACING_PX;
  const maxTicks = Math.min(Math.max(Math.floor(options.maxTicks ?? MAX_TICKS) || MAX_TICKS, 2), MAX_TICKS_LIMIT);
  const width = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 0;

  // At most this many step-intervals fit: `maxTicks` ticks bound `maxTicks - 1`
  // intervals, and a plot too narrow for three still gets three.
  const intervals = Math.min(Math.max(width / minSpacing, 3), maxTicks - 1);
  const step = stepAtLeast((span / intervals) * (1 - STEP_TOLERANCE));

  // `+ 0` turns -0 into 0.
  const at = (i: number): number => (i * step.num) / step.den + 0;

  // The estimates can be off by one in either direction; settle them against
  // the exact tick values so a tick exactly on a window edge is kept.
  let first = Math.ceil((t0 * step.den) / step.num);
  if (at(first - 1) >= t0) first--;
  else if (at(first) < t0) first++;

  let last = Math.floor((t1 * step.den) / step.num);
  if (at(last + 1) <= t1) last++;
  else if (at(last) > t1) last--;

  const largest = last >= first ? Math.max(Math.abs(at(first)), Math.abs(at(last))) : 0;
  const { unit, decimals } = labelFormat(step, largest);

  const ticks: Tick[] = [];
  for (let i = first; i <= last; i++) {
    const value = at(i);
    ticks.push({ value, label: `${(value / unit.ms).toFixed(decimals)}${unit.suffix}` });
  }
  return { step: step.ms, unit: unit.suffix, decimals, ticks };
}

/** The smallest rung of the ladder that is at least `minStep` ms. */
function stepAtLeast(minStep: number): Step {
  if (minStep <= MAX_DECIMAL_STEP_MS) {
    const { mantissa, exp } = decimalRung(minStep);
    return decimalStep(mantissa, exp);
  }
  for (const ms of CLOCK_STEPS_MS) {
    if (ms >= minStep) return clockStep(ms);
  }
  const days = decimalRung(minStep / DAY_MS);
  return clockStep(scaled(days.mantissa, days.exp) * DAY_MS);
}

/** The smallest `mantissa x 10^exp` (mantissa 1, 2 or 5) that is at least `min`. */
function decimalRung(min: number): { mantissa: number; exp: number } {
  // Start a decade below the estimate so a log10 that is off by one cannot skip the answer.
  let exp = Math.floor(Math.log10(min)) - 1;
  for (;;) {
    for (const mantissa of MANTISSAS) {
      if (scaled(mantissa, exp) >= min) return { mantissa, exp };
    }
    exp++;
  }
}

/** `mantissa x 10^exp` as the double closest to the exact decimal. */
function scaled(mantissa: number, exp: number): number {
  return exp >= 0 ? mantissa * pow10(exp) : mantissa / pow10(-exp);
}

/** `10^n` for a non-negative integer, exact up to 1e22. Parsed rather than computed, so it is never off by an ulp. */
function pow10(n: number): number {
  return Number(`1e${n}`);
}

function decimalStep(mantissa: number, exp: number): Step {
  return exp >= 0
    ? { num: scaled(mantissa, exp), den: 1, ms: scaled(mantissa, exp), exp }
    : { num: mantissa, den: pow10(-exp), ms: scaled(mantissa, exp), exp };
}

function clockStep(ms: number): Step {
  return { num: ms, den: 1, ms, exp: 0 };
}

/**
 * Unit and decimals for the labels of one tick set. Clock steps use the
 * largest unit that is not longer than the step, with whole numbers. Smaller
 * steps use the unit of the largest tick (`1.5s`, not `1500ms`), with exactly
 * the decimals the step needs in that unit.
 */
function labelFormat(step: Step, largestTick: number): { unit: Unit; decimals: number } {
  if (step.ms >= SECOND.ms) {
    const unit = CLOCK_UNITS.find(u => step.ms >= u.ms) ?? SECOND;
    return { unit, decimals: 0 };
  }
  const unit = largestTick >= SECOND.ms ? SECOND : largestTick >= MILLISECOND.ms ? MILLISECOND : MICROSECOND;
  return { unit, decimals: Math.max(0, unit.exp - step.exp) };
}
