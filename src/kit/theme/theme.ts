/**
 * Kit theme: token names and helpers
 *
 * The element's colours and fonts are CSS custom properties (`--l2t-*`, declared in
 * `tokens.css.ts`) so the host page can restyle the element from the outside, and
 * `light`/`dark`/`auto` come from the same declarations.
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
