/**
 * Kit theme: token names and the probe that resolves them
 *
 * The element's colours and fonts are CSS custom properties (`--l2t-*`, declared in
 * `tokens.css.ts`) so the host page can restyle the element from the outside, and
 * `light`/`dark`/`auto` come from the same declarations. A canvas cannot read a custom
 * property: `fillStyle = 'var(--l2t-text)'` is ignored. {@link ThemeProbe} bridges the two.
 * It keeps one hidden element per token, each styled by the real stylesheet, and reads the
 * browser's resolved value back (`rgb(...)`, whatever the host wrote: a hex, `light-dark()`,
 * `color-mix()`). A view paints with the {@link ResolvedTheme} and asks for a fresh one when
 * the theme may have changed.
 *
 * The class names are passed in (they come from `probe.css.ts`, which Node cannot import),
 * so this module has no stylesheet dependency and runs against fakes under `node:test`.
 */

/** Every colour token. */
export const COLOR_TOKENS = [
  'background',
  'surface',
  'border',
  'grid',
  'text',
  'textMuted',
  'accent',
  'hover',
  'selection',
  'error',
  'kindUnspecified',
  'kindInternal',
  'kindServer',
  'kindClient',
  'kindProducer',
  'kindConsumer',
] as const;

/** The name of a colour token. */
export type ColorToken = (typeof COLOR_TOKENS)[number];

/** The kind tokens in `SpanKind` order, so `KIND_TOKENS[kind]` is the colour of a span. */
export const KIND_TOKENS: readonly ColorToken[] = [
  'kindUnspecified',
  'kindInternal',
  'kindServer',
  'kindClient',
  'kindProducer',
  'kindConsumer',
];

/** The font tokens. */
export const FONT_TOKENS = ['sans', 'mono'] as const;

/** The name of a font token. */
export type FontToken = (typeof FONT_TOKENS)[number];

/** The custom property name inside a `var(--name)` reference, as `createVar()` and the theme contract produce them. */
export function cssVariableName(reference: string): string {
  const match = /^var\((--[^),\s]+)/.exec(reference);
  if (match === null) throw new Error(`not a CSS variable reference: ${reference}`);
  return match[1];
}

/** A record with one entry per key, for typing the token tables. */
export function tokenRecord<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
  const record = {} as Record<K, V>;
  for (const key of keys) record[key] = value(key);
  return record;
}

/** The tokens as the browser resolved them: strings a canvas accepts. */
export interface ResolvedTheme {
  readonly colors: Readonly<Record<ColorToken, string>>;
  readonly fonts: Readonly<Record<FontToken, string>>;
  /** Colours of the span kinds, indexed by `SpanKind`. */
  readonly kindColors: readonly string[];
  /** Whether the background is dark, to pick between the light and dark variant of what a view draws itself. */
  readonly dark: boolean;
}

/** The class names `probe.css.ts` exports. */
export interface ProbeClasses {
  /** The container: hidden, takes no room. */
  readonly container: string;
  /** One class per colour token that sets `background-color` to it. */
  readonly color: Readonly<Record<ColorToken, string>>;
  /** One class per font token that sets `font-family` to it. */
  readonly font: Readonly<Record<FontToken, string>>;
}

/** The part of `getComputedStyle` the probe reads. */
export interface ComputedValues {
  readonly backgroundColor: string;
  readonly fontFamily: string;
}

/** What the probe needs of its page; defaults to the real one. */
export interface ProbeEnv {
  createElement(tag: 'div'): HTMLElement;
  computedStyle(element: Element): ComputedValues;
}

/** Where the probe's elements go. */
export interface ProbeRoot {
  append(...nodes: Node[]): void;
}

const defaultEnv: ProbeEnv = {
  createElement: (tag) => globalThis.document.createElement(tag),
  computedStyle: (element) => globalThis.getComputedStyle(element),
};

/**
 * Relative luminance (0 to 1) of a computed colour, or `undefined` when it cannot be read.
 * Understands the forms `getComputedStyle` returns for sRGB colours: `rgb()` and `rgba()`
 * (comma or space separated, with a `/` alpha).
 */
export function luminanceOf(color: string): number | undefined {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color.trim());
  if (match === null) return undefined;
  const channel = (value: string): number => {
    const c = Number(value) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
}

/** Resolves the theme tokens through the real stylesheet. Create one per element and call {@link ThemeProbe.resolve} when the theme may have changed. */
export class ThemeProbe {
  private readonly env: ProbeEnv;
  private readonly container: HTMLElement;
  private readonly colorElements: Record<ColorToken, HTMLElement>;
  private readonly fontElements: Record<FontToken, HTMLElement>;

  /**
   * @param root - Where to put the hidden elements: the element's shadow root, so the same custom properties apply.
   * @param classes - The class names from `probe.css.ts`.
   * @param env - Replacements for the page features used, for tests.
   */
  constructor(root: ProbeRoot, classes: ProbeClasses, env: Partial<ProbeEnv> = {}) {
    this.env = { ...defaultEnv, ...env };
    const make = (className: string): HTMLElement => {
      const element = this.env.createElement('div');
      element.className = className;
      return element;
    };
    this.container = make(classes.container);
    this.colorElements = tokenRecord(COLOR_TOKENS, (token) => make(classes.color[token]));
    this.fontElements = tokenRecord(FONT_TOKENS, (token) => make(classes.font[token]));
    this.container.append(...Object.values(this.colorElements), ...Object.values(this.fontElements));
    this.container.setAttribute('aria-hidden', 'true');
    root.append(this.container);
  }

  /** Read every token as the browser resolves it now. */
  resolve(): ResolvedTheme {
    const colors = tokenRecord(COLOR_TOKENS, (token) => this.env.computedStyle(this.colorElements[token]).backgroundColor);
    const fonts = tokenRecord(FONT_TOKENS, (token) => this.env.computedStyle(this.fontElements[token]).fontFamily);
    const luminance = luminanceOf(colors.background);
    return {
      colors,
      fonts,
      kindColors: KIND_TOKENS.map((token) => colors[token]),
      dark: luminance !== undefined && luminance < 0.4,
    };
  }

  /** Remove the hidden elements. */
  dispose(): void {
    this.container.remove();
  }
}
