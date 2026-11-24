/**
 * Kit theme: the classes of the theme probe
 *
 * Each probe element takes one token through the stylesheet, so the browser resolves
 * whatever the host wrote into it. See `theme.ts`.
 */

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from './tokens.css.ts';

/** Hidden and out of the layout, but still styled: `display: none` would resolve nothing. */
export const container = style({
  position: 'absolute',
  width: 0,
  height: 0,
  overflow: 'hidden',
  visibility: 'hidden',
  pointerEvents: 'none',
});

/** One class per colour token, setting `background-color` to it. */
export const color = styleVariants(vars.color, (value) => ({ backgroundColor: value }));

/** One class per font token, setting `font-family` to it. */
export const font = styleVariants(vars.font, (value) => ({ fontFamily: value }));
