/**
 * Flame graph view styles. Positions and widths of the boxes are written through `element.style`;
 * everything else, including the colours (the span-kind tokens), is here.
 */

import { createVar, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../kit/theme/tokens.css.ts';

/** Height of a row, set once on the stage. */
export const rowHeightVar = createVar();

/** The scroller: it takes the wheel, the touch and the keys. */
export const root = style({
  position: 'absolute',
  inset: 0,
  overflowX: 'hidden',
  overflowY: 'auto',
  background: vars.color.background,
  color: vars.color.text,
  font: `12px ${vars.font.sans}`,
  scrollbarWidth: 'thin',
  outline: 'none',
  userSelect: 'none',
  selectors: { '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 } },
});

/** Its height gives the scroller the scroll range of the rows. */
export const stage = style({ position: 'relative', width: '100%' });

export const empty = style({ padding: 12, color: vars.color.textMuted });

export const box = style({
  position: 'absolute',
  height: rowHeightVar,
  boxSizing: 'border-box',
  padding: '0 4px',
  lineHeight: `calc(${rowHeightVar} - 1px)`,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  color: '#fff',
  textShadow: '0 0 2px rgba(0, 0, 0, 0.55)',
  cursor: 'pointer',
  // a hairline of the background between neighbours, and a red foot for a box with a failed span
  boxShadow: `inset -1px -1px 0 ${vars.color.background}`,
});

export const kind = styleVariants({
  unspecified: { background: vars.color.kindUnspecified },
  internal: { background: vars.color.kindInternal },
  server: { background: vars.color.kindServer },
  client: { background: vars.color.kindClient },
  producer: { background: vars.color.kindProducer },
  consumer: { background: vars.color.kindConsumer },
});

export const failed = style({ boxShadow: `inset -1px -4px 0 ${vars.color.error}, inset -1px 0 0 ${vars.color.background}` });
export const hovered = style({ filter: 'brightness(1.15)' });
export const selected = style({ outline: `2px solid ${vars.color.accent}`, outlineOffset: -2, zIndex: 1 });
/** Did not pass the filter. */
export const dimmed = style({ opacity: 0.28 });
/** An ancestor of the focused box. */
export const context = style({ opacity: 0.6 });
