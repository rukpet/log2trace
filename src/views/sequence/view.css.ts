/**
 * Styles for the Sequence Diagram view outer scroller and banner.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '../../kit/theme/tokens.css.ts';

/** Full-size scrollable viewport. */
export const scroller = style({
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'auto',
  outline: 'none',
  backgroundColor: vars.color.background,
  color: vars.color.text,
  fontFamily: vars.font.sans,
});

/** Grabbing cursor when dragging. */
export const panning = style({
  cursor: 'grabbing',
});

/** Subtle info banner for single-participant traces. */
export const noticeBanner = style({
  padding: '4px 12px',
  fontSize: '11px',
  color: vars.color.textMuted,
  backgroundColor: vars.color.surface,
  borderBottom: `1px solid ${vars.color.border}`,
});
