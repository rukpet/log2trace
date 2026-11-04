/**
 * Shell styles: the chrome around a view (toolbar, tooltip, detail panel).
 *
 * Colours and fonts come from the theme tokens only, so the whole shell follows light, dark and
 * the host page's overrides without a rule of its own.
 */

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../kit/theme/tokens.css.ts';

// ---- Toolbar ----
export const toolbar = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  boxSizing: 'border-box',
  background: vars.color.surface,
  color: vars.color.text,
  borderBottom: `1px solid ${vars.color.border}`,
  fontSize: 12,
  flex: 'none',
});

export const toolbarSpacer = style({ flex: 1 });

export const button = style({
  font: 'inherit',
  color: vars.color.text,
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  padding: '3px 9px',
  cursor: 'pointer',
  selectors: {
    '&:hover:not(:disabled)': { background: vars.color.hover },
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
    '&:disabled': { opacity: 0.5, cursor: 'default' },
  },
});

export const readout = style({
  minWidth: 44,
  textAlign: 'center',
  color: vars.color.textMuted,
  fontVariantNumeric: 'tabular-nums',
});

// ---- Tooltip ----
export const tooltip = style({
  position: 'absolute',
  left: 0,
  top: 0,
  zIndex: 20,
  maxWidth: 320,
  boxSizing: 'border-box',
  padding: '8px 10px',
  background: vars.color.background,
  color: vars.color.text,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 6,
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)',
  fontSize: 12,
  lineHeight: 1.4,
  pointerEvents: 'none',
  selectors: { '&[hidden]': { display: 'none' } },
});

// ---- Info (shared by the tooltip and the detail panel) ----
export const infoTitle = style({ fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' });
export const infoSubtitle = style({ color: vars.color.textMuted, overflowWrap: 'anywhere' });

export const status = styleVariants({
  ok: { color: vars.color.kindServer },
  error: { color: vars.color.error },
  unset: { color: vars.color.textMuted },
});

export const infoRows = style({
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  gap: '2px 10px',
  margin: '6px 0 0',
});
globalStyle(`${infoRows} dt`, { color: vars.color.textMuted, margin: 0 });
globalStyle(`${infoRows} dd`, { margin: 0, overflowWrap: 'anywhere', fontFamily: vars.font.mono, fontSize: 11 });

// ---- Detail panel ----
export const detail = style({
  flex: 'none',
  width: 340,
  maxWidth: '45%',
  boxSizing: 'border-box',
  overflow: 'auto',
  padding: '12px 14px',
  background: vars.color.background,
  color: vars.color.text,
  borderLeft: `1px solid ${vars.color.border}`,
  fontSize: 12,
  selectors: { '&[hidden]': { display: 'none' } },
});

export const detailClose = style({ float: 'right' });

export const section = style({
  marginTop: 12,
  borderTop: `1px solid ${vars.color.border}`,
  paddingTop: 6,
});
globalStyle(`${section} > summary`, { cursor: 'pointer', fontWeight: 600, padding: '2px 0' });

export const badge = style({
  display: 'inline-block',
  marginLeft: 6,
  padding: '0 6px',
  borderRadius: 8,
  background: vars.color.surface,
  color: vars.color.textMuted,
  fontWeight: 400,
});

export const group = style({
  marginTop: 8,
  paddingLeft: 8,
  borderLeft: `2px solid ${vars.color.border}`,
});
export const groupTitle = style({ fontWeight: 600 });
