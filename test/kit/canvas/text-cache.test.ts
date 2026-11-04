/**
 * The text meter: what the two-generation cache keeps and drops, `fit` against
 * a brute-force reference (including surrogate pairs and heavy eviction), that
 * `fit` never depends on the cache state, the font-load hook, and the context
 * adapter. Measuring is a fake that counts its calls, so a cache hit is visible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ELLIPSIS,
  clearOnFontLoad,
  createTextMeter,
  measureWithContext,
  type FontFaceSetLike,
  type MeasureText,
} from '../../../src/kit/canvas/text-cache.ts';

const FONT = '10px Test';
const BIG = '20px Test';

/** Every code point is 10 px wide at `10px`, scaled by the font size: simple to reason about. */
function monospace(text: string, font: string): number {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 10);
  return Array.from(text).length * size;
}

/** A proportional fake: glyph widths vary with the character, so prefixes differ in width in an irregular but fixed way. */
function proportional(text: string, font: string): number {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 10);
  let width = 0;
  for (const ch of text) width += (((ch.codePointAt(0) ?? 0) % 7) + 3) * (size / 10);
  return width;
}

/** Wraps a measuring function and records every call. */
function counted(inner: MeasureText): { measure: MeasureText; readonly calls: number; readonly log: string[] } {
  const log: string[] = [];
  return {
    measure(text, font) {
      log.push(`${font}|${text}`);
      return inner(text, font);
    },
    get calls() {
      return log.length;
    },
    log,
  };
}

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

/** The label by brute force: try every code point prefix from the longest down. */
function referenceFit(text: string, font: string, maxWidth: number, measure: MeasureText, ellipsis = DEFAULT_ELLIPSIS): string {
  if (text === '' || !(maxWidth > 0)) return '';
  if (measure(text, font) <= maxWidth) return text;
  const points = Array.from(text);
  for (let count = points.length - 1; count >= 0; count--) {
    const candidate = points.slice(0, count).join('') + ellipsis;
    if (measure(candidate, font) <= maxWidth) return candidate;
  }
  return '';
}

test('measure returns what the measuring function says and asks it once per text and font', () => {
  const fake = counted(proportional);
  const meter = createTextMeter({ measure: fake.measure });

  const width = meter.measure('hello', FONT);
  assert.equal(width, proportional('hello', FONT));
  assert.equal(meter.measure('hello', FONT), width);
  assert.equal(fake.calls, 1, 'the second answer came from the cache');

  meter.measure('hello', BIG);
  assert.equal(fake.calls, 2, 'another font is another answer');
  assert.equal(meter.measure('hello', BIG), proportional('hello', BIG));
  meter.measure('world', FONT);
  assert.equal(fake.calls, 3, 'another text is another answer');

  assert.equal(meter.measure('', FONT), 0);
  assert.equal(meter.measure('', FONT), 0);
  assert.equal(fake.calls, 4, 'an empty text is cached too');
});

test('texts and fonts that would collide if joined into one key stay apart', () => {
  const fake = counted((text, font) => text.length * 100 + font.length);
  const meter = createTextMeter({ measure: fake.measure });

  assert.equal(meter.measure('b', 'a|'), 102);
  assert.equal(meter.measure('|b', 'a'), 201);
  assert.equal(meter.measure('b', 'a|'), 102);
  assert.equal(meter.measure('|b', 'a'), 201);
  assert.equal(fake.calls, 2);
});

test('two generations: an answer that keeps being used survives, one left alone is dropped after a generation', () => {
  const fake = counted(monospace);
  const meter = createTextMeter({ measure: fake.measure, generationSize: 4 });

  for (const text of ['a', 'b', 'c', 'd']) meter.measure(text, FONT);
  assert.equal(fake.calls, 4);

  meter.measure('e', FONT); // the generation was full: it becomes the previous one
  assert.equal(fake.calls, 5);
  meter.measure('a', FONT); // found in the previous generation, moved to the current one
  assert.equal(fake.calls, 5, 'a was still held');

  meter.measure('f', FONT);
  meter.measure('g', FONT);
  assert.equal(fake.calls, 7);
  meter.measure('h', FONT); // full again: {e, a, f, g} become the previous generation, {a, b, c, d} are gone
  assert.equal(fake.calls, 8);

  meter.measure('a', FONT);
  assert.equal(fake.calls, 8, 'a was used in the last generation, so it survived');
  meter.measure('b', FONT);
  assert.equal(fake.calls, 9, 'b was not, so it had to be measured again');
});

test('memory stays bounded however many different texts come through', () => {
  const fake = counted(monospace);
  const meter = createTextMeter({ measure: fake.measure, generationSize: 16 });
  const limit = 4 * 16;

  for (let i = 0; i < 5000; i++) {
    meter.measure(`text ${i}`, i % 2 === 0 ? FONT : BIG);
    meter.fit(`some longer label ${i}`, FONT, 55);
    assert.ok(meter.size <= limit, `held ${meter.size} answers after ${i + 1} rounds`);
  }
  assert.ok(meter.size > 16, 'but it does hold a good number of them');
});

test('clear drops everything', () => {
  const fake = counted(monospace);
  const meter = createTextMeter({ measure: fake.measure });
  meter.measure('hello', FONT);
  meter.fit('hello world', FONT, 55);
  assert.ok(meter.size > 0);

  const before = fake.calls;
  meter.clear();
  assert.equal(meter.size, 0);
  meter.measure('hello', FONT);
  assert.equal(fake.calls, before + 1, 'measured again');
});

test('invalid generation sizes fall back to the default instead of breaking the cache', () => {
  for (const generationSize of [0, -1, 1.5, NaN, Infinity]) {
    const fake = counted(monospace);
    const meter = createTextMeter({ measure: fake.measure, generationSize });
    for (let i = 0; i < 100; i++) meter.measure(`t${i}`, FONT);
    for (let i = 0; i < 100; i++) meter.measure(`t${i}`, FONT);
    assert.equal(fake.calls, 100, `generationSize ${generationSize}: the default holds all 100`);
  }
});

test('fit returns the text when it fits, a cut label with an ellipsis when it does not, and nothing when even the ellipsis will not fit', () => {
  const meter = createTextMeter({ measure: monospace });

  assert.equal(meter.fit('hello', FONT, 50), 'hello', 'exactly as wide as the space');
  assert.equal(meter.fit('hello', FONT, 1000), 'hello');
  assert.equal(meter.fit('hello world', FONT, 80), 'hello w…', 'seven characters and the ellipsis make 80');
  assert.equal(meter.fit('hello world', FONT, 79), 'hello …');
  assert.equal(meter.fit('hello world', FONT, 20), 'h…');
  assert.equal(meter.fit('hello', FONT, 10), '…', 'only the ellipsis fits');
  assert.equal(meter.fit('hello', FONT, 9), '', 'not even that');
  assert.equal(meter.fit('hello', BIG, 60), 'he…', 'the font scales the widths');
});

test('fit copes with an empty text and with widths that are zero, negative, NaN or infinite', () => {
  const meter = createTextMeter({ measure: monospace });
  assert.equal(meter.fit('', FONT, 100), '');
  assert.equal(meter.fit('hello', FONT, 0), '');
  assert.equal(meter.fit('hello', FONT, -5), '');
  assert.equal(meter.fit('hello', FONT, NaN), '');
  assert.equal(meter.fit('hello', FONT, Infinity), 'hello');
  assert.equal(meter.fit('a', FONT, 5), '', 'a one-character text that does not fit leaves only the ellipsis, and that does not fit either');
  assert.equal(meter.fit('a', FONT, 12), 'a');
});

test('a width that is not above zero gets no label, even for a text that measures nothing', () => {
  const meter = createTextMeter({ measure: () => 0 });
  for (const maxWidth of [0, -1, NaN]) assert.equal(meter.fit('abc', FONT, maxWidth), '', String(maxWidth));
  assert.equal(meter.fit('abc', FONT, 1), 'abc', 'while any positive width takes it');
});

test('fit uses the ellipsis it was given', () => {
  const meter = createTextMeter({ measure: monospace, ellipsis: '...' });
  assert.equal(meter.fit('hello world', FONT, 80), 'hello...');
  assert.equal(meter.fit('hello world', FONT, 29), '', 'the ellipsis alone takes 30');
  assert.equal(meter.fit('hello world', FONT, 30), '...');
});

test('fit never cuts a surrogate pair in half', () => {
  const meter = createTextMeter({ measure: monospace });
  const text = 'ab\u{1F600}cd'; // five code points, six UTF-16 units

  assert.equal(meter.fit(text, FONT, 50), text);
  assert.equal(meter.fit(text, FONT, 40), 'ab\u{1F600}…');
  assert.equal(meter.fit(text, FONT, 30), 'ab…', 'the cut would land inside the emoji, so it backs off to before it');
  assert.equal(meter.fit(text, FONT, 20), 'a…');
  assert.equal(meter.fit('\u{1F600}\u{1F600}\u{1F600}', FONT, 20), '\u{1F600}…');
  assert.equal(meter.fit('\u{1F600}\u{1F600}', FONT, 10), '…');
});

test('fit remembers the last answer for a text and asks the measuring function again only for a new width', () => {
  const fake = counted(proportional);
  const meter = createTextMeter({ measure: fake.measure });
  const label = 'validate_inventory_level';

  const first = meter.fit(label, FONT, 90);
  const calls = fake.calls;
  assert.ok(calls > 1, 'a cut label takes a search');

  assert.equal(meter.fit(label, FONT, 90), first);
  assert.equal(fake.calls, calls, 'the same width again costs nothing');

  const second = meter.fit(label, FONT, 70);
  assert.notEqual(second, first);
  assert.equal(second, referenceFit(label, FONT, 70, proportional));
  assert.ok(fake.calls > calls, 'a new width searches again');
  assert.equal(meter.fit(label, FONT, 90), first, 'and going back to the old width still gives the old answer');
});

test('fit matches a brute-force reference on random labels and widths, whatever the cache holds', () => {
  const alphabet = ['a', 'b', 'c', 'x', 'W', ' ', '_', '/', 'é', '…', '\u{1F600}', '\u{1F9D1}', 'i', 'm'];
  const fonts = [FONT, BIG, '14px Test'];
  const random = mulberry32(20261104);

  const meters = [
    { name: 'tiny generations', meter: createTextMeter({ measure: proportional, generationSize: 2 }) },
    { name: 'small generations', meter: createTextMeter({ measure: proportional, generationSize: 7 }) },
    { name: 'default generations', meter: createTextMeter({ measure: proportional }) },
  ];

  const cases: Array<{ text: string; font: string; width: number }> = [];
  for (let i = 0; i < 400; i++) {
    let text = '';
    const length = Math.floor(random() * 15);
    for (let j = 0; j < length; j++) text += alphabet[Math.floor(random() * alphabet.length)];
    cases.push({ text, font: fonts[Math.floor(random() * fonts.length)], width: random() * 140 });
  }

  // Three passes: cold, warm, and shuffled with clears in between.
  const order = cases.map((_, i) => i);
  for (let pass = 0; pass < 3; pass++) {
    if (pass === 2) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    for (const [step, index] of order.entries()) {
      const { text, font, width } = cases[index];
      const expected = referenceFit(text, font, width, proportional);
      for (const { name, meter } of meters) {
        assert.equal(
          meter.fit(text, font, width),
          expected,
          `${name}, pass ${pass}: fit(${JSON.stringify(text)}, ${font}, ${width})`,
        );
      }
      if (pass === 2 && step % 37 === 0) for (const { meter } of meters) meter.clear();
    }
  }
});

test('fit gives the same answer cold, warm, after eviction and after clear', () => {
  const fake = counted(proportional);
  const meter = createTextMeter({ measure: fake.measure, generationSize: 3 });
  const label = 'GET /api/orders/{orderId}/items';
  const expected = referenceFit(label, FONT, 123, proportional);

  const cold = meter.fit(label, FONT, 123);
  const warm = meter.fit(label, FONT, 123);
  for (let i = 0; i < 50; i++) meter.fit(`filler label number ${i}`, FONT, 77 + i); // pushes everything out of both generations
  const evicted = meter.fit(label, FONT, 123);
  meter.clear();
  const cleared = meter.fit(label, FONT, 123);

  for (const [what, got] of Object.entries({ cold, warm, evicted, cleared })) assert.equal(got, expected, what);
});

test('measureWithContext sets the font only when it changes and reads the width', () => {
  const sets: string[] = [];
  let font = '';
  const measured: string[] = [];
  const measure = measureWithContext({
    get font() {
      return font;
    },
    set font(value: string) {
      sets.push(value);
      font = value;
    },
    measureText(text: string) {
      measured.push(`${font}|${text}`);
      return { width: text.length * 7 };
    },
  });

  assert.equal(measure('abc', FONT), 21);
  assert.equal(measure('abcd', FONT), 28);
  assert.deepEqual(sets, [FONT], 'the same font is not set twice');
  assert.equal(measure('ab', BIG), 14);
  assert.equal(measure('ab', FONT), 14);
  assert.deepEqual(sets, [FONT, BIG, FONT]);
  assert.deepEqual(measured, [`${FONT}|abc`, `${FONT}|abcd`, `${BIG}|ab`, `${FONT}|ab`], 'every text was measured in its own font');
});

/** A `document.fonts` stand-in that keeps its listeners and can announce `loadingdone`. */
function fakeFonts(): FontFaceSetLike & { readonly listeners: number; fire(): void } {
  const listeners = new Set<() => void>();
  return {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    get listeners() {
      return listeners.size;
    },
    fire() {
      for (const listener of [...listeners]) listener();
    },
  };
}

test('clearOnFontLoad empties the cache when fonts finish loading, and stops when told to', () => {
  const fake = counted(monospace);
  const meter = createTextMeter({ measure: fake.measure });
  const fonts = fakeFonts();
  let cleared = 0;

  const stop = clearOnFontLoad(meter, { fonts, onCleared: () => cleared++ });
  assert.equal(fonts.listeners, 1);

  meter.measure('hello', FONT);
  meter.measure('hello', FONT);
  assert.equal(fake.calls, 1);

  fonts.fire();
  assert.equal(cleared, 1);
  assert.equal(meter.size, 0);
  meter.measure('hello', FONT);
  assert.equal(fake.calls, 2, 'measured again with the font that has just loaded');

  stop();
  assert.equal(fonts.listeners, 0);
  fonts.fire();
  assert.equal(cleared, 1);
  assert.ok(meter.size > 0, 'a stopped hook leaves the cache alone');
});

test('clearOnFontLoad does nothing, without failing, where the page has no font set', () => {
  assert.equal(Reflect.get(globalThis, 'document'), undefined, 'this test needs a page without a document');
  const meter = createTextMeter({ measure: monospace });
  const stop = clearOnFontLoad(meter);
  stop();
});

test('clearOnFontLoad watches the page\'s document.fonts by default', () => {
  const fonts = fakeFonts();
  Reflect.set(globalThis, 'document', { fonts });
  try {
    const meter = createTextMeter({ measure: monospace });
    meter.measure('hello', FONT);
    const stop = clearOnFontLoad(meter);
    assert.equal(fonts.listeners, 1);
    fonts.fire();
    assert.equal(meter.size, 0);
    stop();
    assert.equal(fonts.listeners, 0);
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
});
