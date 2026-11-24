/**
 * Shell styles: the filter bar.
 *
 * External filters (sent to the data source) and local filters (applied to the loaded spans) sit in
 * two rows, tinted with the accent and the "ok" colour of the theme.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '../kit/theme/tokens.css.ts';

/** Never takes more than half of the element: on a narrow one the bar scrolls and the chart stays in view. */
export const container = style({
  flex: 'none',
  maxHeight: '50%',
  overflowY: 'auto',
  borderBottom: `1px solid ${vars.color.border}`,
  color: vars.color.text,
  background: vars.color.background,
  selectors: { '&[hidden]': { display: 'none' } },
});

export const row = style({
  display: 'flex',
  alignItems: 'flex-end',
  flexWrap: 'wrap',
  gap: 14,
  padding: '10px 14px',
  fontSize: 13,
});

export const rowExternal = style({
  background: `color-mix(in srgb, ${vars.color.accent} 8%, ${vars.color.background})`,
  borderBottom: `1px solid color-mix(in srgb, ${vars.color.accent} 25%, ${vars.color.background})`,
});

export const rowLocal = style({
  background: `color-mix(in srgb, ${vars.color.kindServer} 8%, ${vars.color.background})`,
});

export const rowLabel = style({
  alignSelf: 'center',
  width: 70,
  flex: 'none',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.5px',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
});
export const rowLabelExternal = style({ color: vars.color.accent });
export const rowLabelLocal = style({ color: vars.color.kindServer });

export const field = style({ display: 'flex', flexDirection: 'column', gap: 4 });

export const label = style({ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', color: vars.color.textMuted });
export const requiredMarker = style({ marginLeft: 2, color: vars.color.error });

export const input = style({
  boxSizing: 'border-box',
  height: 29,
  minWidth: 160,
  padding: '4px 10px',
  font: 'inherit',
  color: vars.color.text,
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  selectors: {
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -1 },
  },
});

export const select = style({ cursor: 'pointer' });

export const checkboxField = style({ display: 'flex', alignItems: 'center', gap: 6, height: 29 });
export const checkbox = style({ width: 16, height: 16, cursor: 'pointer', accentColor: vars.color.kindServer });
export const checkboxLabel = style({ cursor: 'pointer', userSelect: 'none', fontWeight: 500 });

export const datetimeGroup = style({ display: 'flex', alignItems: 'center', gap: 6 });
export const datetimeSeparator = style({ color: vars.color.textMuted, fontSize: 12 });

export const button = style({
  height: 29,
  padding: '0 14px',
  font: 'inherit',
  cursor: 'pointer',
  color: vars.color.text,
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  selectors: {
    '&:hover': { background: vars.color.hover },
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
  },
});

export const searchButton = style({
  fontWeight: 600,
  color: vars.color.background,
  background: vars.color.accent,
  borderColor: vars.color.accent,
  selectors: { '&:hover': { background: vars.color.accent, filter: 'brightness(0.92)' } },
});

export const multiselect = style({ position: 'relative', display: 'inline-block' });

export const multiselectTrigger = style({
  boxSizing: 'border-box',
  height: 29,
  minWidth: 160,
  padding: '4px 28px 4px 10px',
  position: 'relative',
  font: 'inherit',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'pointer',
  color: vars.color.text,
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  selectors: {
    '&::after': { content: '"\\25BC"', position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: vars.color.textMuted },
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -1 },
  },
});

export const multiselectPanel = style({
  display: 'none',
  position: 'absolute',
  top: '100%',
  left: 0,
  zIndex: 200,
  minWidth: '100%',
  maxHeight: 220,
  overflowY: 'auto',
  marginTop: 2,
  padding: '4px 0',
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)',
  selectors: { '&[data-open="true"]': { display: 'block' } },
});

export const multiselectItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 12px',
  cursor: 'pointer',
  userSelect: 'none',
  selectors: { '&:hover': { background: vars.color.hover } },
});

export const multiselectCheckbox = style({ width: 14, height: 14, flex: 'none', cursor: 'pointer', accentColor: vars.color.accent });
