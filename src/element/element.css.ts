/**
 * Element styles: the layout of `<trace-visualizer>` itself.
 *
 * The rules for `:host` name the element (`:host(trace-visualizer)`) because every element of
 * the library adopts the same stylesheet.
 */

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../kit/theme/tokens.css.ts';

globalStyle(':host(trace-visualizer)', {
  display: 'block',
  height: 480,
  minHeight: 0,
  boxSizing: 'border-box',
  fontFamily: vars.font.sans,
  color: vars.color.text,
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  overflow: 'hidden',
});

export const root = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
});

export const body = style({
  display: 'flex',
  flex: 1,
  minHeight: 0,
});

/** The box the canvases fill and the plot scrolls in. */
export const stage = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  background: vars.color.background,
});

/** The native scroller over the canvases: it takes the wheel, the touch and the keys. */
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

export const spacer = style({
  width: 1,
  pointerEvents: 'none',
});

export const message = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  textAlign: 'center',
  color: vars.color.textMuted,
  background: vars.color.background,
  selectors: { '&[hidden]': { display: 'none' } },
});

export const messageError = style({ color: vars.color.error });

/** Present to assistive technology and invisible to everyone else. */
export const visuallyHidden = style({
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
});
