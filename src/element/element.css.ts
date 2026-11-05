/**
 * Element styles: the layout of `<trace-visualizer>` itself.
 *
 * The rules for `:host` name the element (`:host(trace-visualizer)`) because every element of
 * the library adopts the same stylesheet.
 */

import { globalStyle, style } from '@vanilla-extract/css';
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

/** The box the active view fills; the status message and the tooltip sit above it. */
export const stage = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  background: vars.color.background,
});

/** What the active view fills: the whole stage. */
export const surface = style({
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
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

/** Holds the active view's toolbar; the toolbar is built again when the view changes. */
export const toolbarSlot = style({ flex: 'none' });
