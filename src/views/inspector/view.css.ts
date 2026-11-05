/**
 * Inspector view styles.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '../../kit/theme/tokens.css.ts';

export const root = style({
  position: 'absolute',
  inset: 0,
  overflowY: 'auto',
  padding: 12,
  boxSizing: 'border-box',
  color: vars.color.text,
  background: vars.color.background,
  fontFamily: vars.font.sans,
  fontSize: 13,
  outline: 'none',
  selectors: { '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 } },
});

export const rows = style({
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  gap: '4px 16px',
  margin: 0,
});

export const label = style({ color: vars.color.textMuted, margin: 0 });
export const value = style({ margin: 0, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' });

export const heading = style({
  margin: '16px 0 6px',
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: vars.color.textMuted,
});

export const list = style({ listStyle: 'none', margin: 0, padding: 0 });

export const item = style({
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  font: 'inherit',
  textAlign: 'left',
  color: vars.color.text,
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 4,
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': { background: vars.color.hover },
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
  },
});

export const more = style({ padding: '4px 8px', color: vars.color.textMuted });
export const empty = style({ color: vars.color.textMuted });
