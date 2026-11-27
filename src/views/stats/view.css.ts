/**
 * Styles for the Stats view outer scroller.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '../../kit/theme/tokens.css.ts';

/** Full-size 2D scrollable viewport for the statistics treegrid. */
export const scroller = style({
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'auto',
  outline: 'none',
  backgroundColor: vars.color.background,
  color: vars.color.text,
  fontFamily: vars.font.sans,
  fontSize: '12px',
});
