/**
 * Kit canvas: text cache
 *
 * Measuring text is the slow part of drawing labels: `measureText` is a call
 * into the browser's text shaper, and a frame needs a width for every label,
 * and a binary search of them for every label that does not fit. `TextMeter`
 * remembers the answers in two generations of Maps: new answers go into the
 * current one; when it holds a generation's worth, it becomes the previous one
 * and the old previous one is dropped, so an answer survives while it keeps
 * being used and goes after a whole generation without a hit. Memory stays
 * bounded without per-entry bookkeeping.
 *
 * The measuring function is injected (`measureWithContext` in the browser, a
 * fake in tests), and the module reads no browser global at import time.
 * Answers depend on the loaded fonts, so the cache must be cleared when they
 * change: `clearOnFontLoad` does it on `document.fonts`' `loadingdone`.
 */

/** Width in CSS px of `text` set in `font` (a CSS font shorthand, such as `12px "Segoe UI"`). */
export type MeasureText = (text: string, font: string) => number;

/** The part of a canvas 2D context {@link measureWithContext} uses. */
export interface MeasureContext {
  /** Setting it changes the font `measureText` uses. */
  font: string;
  /** The metrics of a text in the current font; only `width` is read. */
  measureText(text: string): { readonly width: number };
}

/** Entries per generation unless the options say otherwise. */
export const DEFAULT_GENERATION_SIZE = 2048;

/** The character `fit` puts after a cut label. */
export const DEFAULT_ELLIPSIS = '…';

/** Options for {@link createTextMeter}. */
export interface TextMeterOptions {
  /** Measures text; called only for answers the cache does not hold. */
  readonly measure: MeasureText;
  /** Entries per generation, for each of the two caches (measure and fit); an integer of at least 1, default {@link DEFAULT_GENERATION_SIZE}. */
  readonly generationSize?: number;
  /** Appended to a label that had to be cut; default {@link DEFAULT_ELLIPSIS}. */
  readonly ellipsis?: string;
}

/** Cached text measuring; create one with {@link createTextMeter}. */
export interface TextMeter {
  /**
   * Width of `text` set in `font`.
   *
   * @param text - The text, any length.
   * @param font - CSS font shorthand, resolved (no `var()`, no relative units).
   */
  measure(text: string, font: string): number;
  /**
   * `text` if it fits in `maxWidth`, otherwise the longest prefix that fits
   * together with the ellipsis, followed by it, or an empty string when not
   * even the ellipsis fits (also for an empty text and for a `maxWidth` that is
   * not above zero). It assumes a longer prefix is never narrower, as
   * is true for text in practice, and never cuts inside a surrogate pair. The
   * result depends only on the arguments and the measuring function, never on
   * what the cache holds.
   *
   * @param text - The label.
   * @param font - CSS font shorthand, as for {@link TextMeter.measure}.
   * @param maxWidth - Available width in CSS px.
   */
  fit(text: string, font: string, maxWidth: number): string;
  /** Forget every answer: after the fonts changed, or to release memory. */
  clear(): void;
  /** Answers held now, in both generations of both caches; at most four times the generation size. For diagnostics and tests. */
  readonly size: number;
}

/** Where fonts finishing loading is announced: `document.fonts`. */
export interface FontFaceSetLike {
  /** Be called when a batch of fonts has finished loading. */
  addEventListener(type: 'loadingdone', listener: () => void): void;
  /** Stop being called. */
  removeEventListener(type: 'loadingdone', listener: () => void): void;
}

/** Options for {@link clearOnFontLoad}. */
export interface ClearOnFontLoadOptions {
  /** Where `loadingdone` comes from; defaults to the page's `document.fonts`, and nothing is watched when the page has none. */
  readonly fonts?: FontFaceSetLike;
  /** Called after the cache was cleared: repaint, because every label's width may have changed. */
  readonly onCleared?: () => void;
}

/** The last `fit` for one text, kept up to date in place. */
interface FitEntry {
  maxWidth: number;
  result: string;
}

/**
 * Two generations of a font → text → value cache. Nested Maps rather than a
 * joined key: the lookup builds no string and reuses the hashes the strings
 * already carry.
 */
class Generations<V> {
  private current = new Map<string, Map<string, V>>();
  private previous = new Map<string, Map<string, V>>();
  private inCurrent = 0;
  private inPrevious = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Entries held across both generations. */
  get size(): number {
    return this.inCurrent + this.inPrevious;
  }

  /** The value for a key, moved into the current generation when it was in the previous one. */
  get(font: string, text: string): V | undefined {
    const fresh = this.current.get(font)?.get(text);
    if (fresh !== undefined) return fresh;

    const stale = this.previous.get(font)?.get(text);
    if (stale !== undefined) this.set(font, text, stale);
    return stale;
  }

  /** Store a value in the current generation, starting a new one first when it is full. */
  set(font: string, text: string, value: V): void {
    if (this.inCurrent >= this.limit) {
      this.previous = this.current;
      this.inPrevious = this.inCurrent;
      this.current = new Map();
      this.inCurrent = 0;
    }

    let byText = this.current.get(font);
    if (byText === undefined) {
      byText = new Map();
      this.current.set(font, byText);
    }
    const before = byText.size;
    byText.set(text, value);
    if (byText.size > before) this.inCurrent++;
  }

  clear(): void {
    this.current = new Map();
    this.previous = new Map();
    this.inCurrent = 0;
    this.inPrevious = 0;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `count` rounded down so that the first `count` UTF-16 units of `text` do not end inside a surrogate pair. */
function codePointBoundary(text: string, count: number): number {
  const split = count > 0 && count < text.length && isLowSurrogate(text.charCodeAt(count)) && isHighSurrogate(text.charCodeAt(count - 1));
  return split ? count - 1 : count;
}

/**
 * Adapt a canvas context to {@link MeasureText}. The adapter sets the context's
 * font (only when it changes), so give it a context of its own, such as a
 * detached `document.createElement('canvas').getContext('2d')`, never the one a
 * painter draws with.
 *
 * @param ctx - A context dedicated to measuring.
 */
export function measureWithContext(ctx: MeasureContext): MeasureText {
  let current: string | undefined;
  return (text, font) => {
    if (font !== current) {
      ctx.font = font;
      current = font;
    }
    return ctx.measureText(text).width;
  };
}

/**
 * Create a text meter around a measuring function.
 *
 * @param options - The measuring function and the cache tuning.
 */
export function createTextMeter(options: TextMeterOptions): TextMeter {
  const rawMeasure = options.measure;
  const ellipsis = options.ellipsis ?? DEFAULT_ELLIPSIS;
  const wanted = options.generationSize;
  const limit = wanted !== undefined && Number.isInteger(wanted) && wanted >= 1 ? wanted : DEFAULT_GENERATION_SIZE;
  const widths = new Generations<number>(limit);
  const fits = new Generations<FitEntry>(limit);

  function measure(text: string, font: string): number {
    let width = widths.get(font, text);
    if (width === undefined) {
      width = rawMeasure(text, font);
      widths.set(font, text, width);
    }
    return width;
  }

  /** Whether the first `count` UTF-16 units of `text` (rounded down to a code point boundary) and the ellipsis fit. */
  function prefixFits(text: string, font: string, maxWidth: number, count: number): boolean {
    return measure(text.slice(0, codePointBoundary(text, count)) + ellipsis, font) <= maxWidth;
  }

  function cut(text: string, font: string, maxWidth: number): string {
    if (measure(text, font) <= maxWidth) return text;
    if (!prefixFits(text, font, maxWidth, 0)) return '';

    // Invariant: a prefix of `low` units fits and one of `high` units does not (the whole
    // text did not fit, so neither does the whole text plus the ellipsis).
    let low = 0;
    let high = text.length;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (prefixFits(text, font, maxWidth, middle)) low = middle;
      else high = middle;
    }

    return text.slice(0, codePointBoundary(text, low)) + ellipsis;
  }

  return {
    measure,

    fit(text, font, maxWidth) {
      if (text.length === 0 || !(maxWidth > 0)) return '';

      const entry = fits.get(font, text);
      if (entry !== undefined && entry.maxWidth === maxWidth) return entry.result;

      const result = cut(text, font, maxWidth);
      if (entry !== undefined) {
        entry.maxWidth = maxWidth;
        entry.result = result;
      } else {
        fits.set(font, text, { maxWidth, result });
      }
      return result;
    },

    clear() {
      widths.clear();
      fits.clear();
    },

    get size() {
      return widths.size + fits.size;
    },
  };
}

/**
 * Clear a meter whenever fonts finish loading, because text measured in a
 * fallback font while the real one was loading has the wrong width. Fonts
 * declared in the page are announced by `document.fonts`; the document's
 * `@font-face` rules apply inside shadow roots too, so one subscription per
 * meter is enough.
 *
 * @param meter - The meter to clear.
 * @param options - Where to listen, and what to do afterwards.
 * @returns A function that stops listening.
 */
export function clearOnFontLoad(meter: TextMeter, options: ClearOnFontLoadOptions = {}): () => void {
  const fonts: FontFaceSetLike | undefined = options.fonts ?? globalThis.document?.fonts;
  if (fonts === undefined) return () => undefined;

  const onCleared = options.onCleared;
  const listener = (): void => {
    meter.clear();
    onCleared?.();
  };
  fonts.addEventListener('loadingdone', listener);
  return () => fonts.removeEventListener('loadingdone', listener);
}
