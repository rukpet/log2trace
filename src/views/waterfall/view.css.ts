/**
 * Waterfall view styles: the native scroller over the painter and its cursor.
 */

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../kit/theme/tokens.css.ts';

/** The native scroller over the painter's layers: it takes the wheel, the touch and the keys. */
export const plot = style({
  position: 'absolute',
  inset: 0,
  overflowX: 'hidden',
  overflowY: 'auto',
  touchAction: 'pan-y',
  userSelect: 'none',
  scrollbarWidth: 'thin',
  outline: 'none',
  selectors: {
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
  },
});

export const cursor = styleVariants({
  default: { cursor: 'default' },
  pointer: { cursor: 'pointer' },
  grab: { cursor: 'grab' },
});

/** Its height gives the scroller exactly the scroll range of the rows. */
export const spacer = style({
  width: 1,
  pointerEvents: 'none',
});
