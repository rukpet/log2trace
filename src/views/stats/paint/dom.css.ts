/**
 * Styles for the pooled virtualized Stats treegrid DOM painter.
 */

import { style, styleVariants } from '@vanilla-extract/css';
import { KIND_TOKENS } from '../../../kit/theme/theme.ts';
import { vars } from '../../../kit/theme/tokens.css.ts';

export const canvas = style({
  position: 'relative',
  minWidth: '100%',
});

export const header = style({
  position: 'sticky',
  top: 0,
  zIndex: 3,
  display: 'grid',
  alignItems: 'stretch',
  height: '32px',
  backgroundColor: vars.color.surface,
  borderBottom: `1px solid ${vars.color.border}`,
  boxSizing: 'border-box',
});

export const headerGridGrouped = style({
  gridTemplateColumns: 'minmax(220px, 1fr) 64px 76px 132px 96px 72px 72px 72px 72px 72px',
  minWidth: '948px',
});

export const headerGridFlat = style({
  gridTemplateColumns: 'minmax(220px, 1fr) 84px 68px 132px 104px 80px 64px',
  minWidth: '752px',
});

export const headerCell = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '0 8px',
  border: 'none',
  borderRight: `1px solid ${vars.color.grid}`,
  backgroundColor: 'transparent',
  color: vars.color.textMuted,
  fontFamily: vars.font.sans,
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  userSelect: 'none',
  boxSizing: 'border-box',
  ':hover': {
    color: vars.color.text,
    backgroundColor: vars.color.hover,
  },
  ':focus-visible': {
    outline: `2px solid ${vars.color.accent}`,
    outlineOffset: '-2px',
  },
});

export const headerCellSticky = style({
  position: 'sticky',
  left: 0,
  zIndex: 4,
  backgroundColor: vars.color.surface,
  borderRight: `1px solid ${vars.color.border}`,
});

export const headerCellRight = style({
  justifyContent: 'flex-end',
  textAlign: 'right',
});

export const headerCellSorted = style({
  color: vars.color.text,
});

export const sortIndicator = style({
  fontSize: '10px',
  color: vars.color.accent,
  lineHeight: 1,
});

export const body = style({
  position: 'relative',
  width: '100%',
});

export const row = style({
  position: 'absolute',
  left: 0,
  right: 0,
  display: 'grid',
  alignItems: 'center',
  borderBottom: `1px solid ${vars.color.grid}`,
  backgroundColor: vars.color.background,
  cursor: 'pointer',
  boxSizing: 'border-box',
  selectors: {
    '&[hidden]': {
      display: 'none',
    },
  },
});

export const rowChild = style({
  backgroundColor: vars.color.surface,
});

export const rowHovered = style({
  backgroundColor: vars.color.hover,
});

export const rowSelected = style({
  backgroundColor: vars.color.selection,
});

export const rowDimmed = style({
  opacity: 0.35,
});

export const cell = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  height: '100%',
  padding: '0 8px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  boxSizing: 'border-box',
  borderRight: `1px solid ${vars.color.grid}`,
  selectors: {
    '&[hidden]': {
      display: 'none',
    },
  },
});

export const cellIdentity = style({
  position: 'sticky',
  left: 0,
  zIndex: 2,
  gap: '6px',
  backgroundColor: vars.color.background,
  borderRight: `1px solid ${vars.color.border}`,
  selectors: {
    [`${rowChild} &`]: {
      backgroundColor: vars.color.surface,
    },
    [`${rowHovered} &`]: {
      backgroundImage: `linear-gradient(0deg, ${vars.color.hover}, ${vars.color.hover})`,
    },
    [`${rowSelected} &`]: {
      backgroundImage: `linear-gradient(0deg, ${vars.color.selection}, ${vars.color.selection})`,
    },
  },
});

export const cellIdentityChild = style({
  paddingLeft: '26px',
});

export const cellMetric = style({
  justifyContent: 'flex-end',
  fontFamily: vars.font.mono,
  fontVariantNumeric: 'tabular-nums',
  fontSize: '11.5px',
});

export const cellText = style({
  justifyContent: 'flex-start',
  fontSize: '11.5px',
  color: vars.color.textMuted,
});

export const chevron = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '16px',
  height: '16px',
  padding: 0,
  border: 'none',
  borderRadius: '3px',
  backgroundColor: 'transparent',
  color: vars.color.textMuted,
  fontSize: '11px',
  lineHeight: 1,
  flexShrink: 0,
  cursor: 'pointer',
  selectors: {
    '&[hidden]': {
      display: 'none',
    },
  },
  ':hover': {
    color: vars.color.text,
    backgroundColor: vars.color.hover,
  },
});

export const kindDot = style({
  width: '7px',
  height: '7px',
  borderRadius: '50%',
  flexShrink: 0,
});

export const kindColor = styleVariants(
  Object.fromEntries(KIND_TOKENS.map((token, i) => [String(i), { backgroundColor: vars.color[token] }])) as Record<
    string,
    { backgroundColor: string }
  >,
);

export const primaryLabel = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  color: vars.color.text,
});

export const secondaryLabel = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '11px',
  color: vars.color.textMuted,
  flexShrink: 1,
});

export const metricValue = style({
  position: 'relative',
  zIndex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const mutedValue = style({
  color: vars.color.textMuted,
});

export const errorValue = style({
  color: vars.color.error,
  fontWeight: 600,
});

export const barTrack = style({
  position: 'absolute',
  left: '4px',
  right: '4px',
  bottom: '2px',
  height: '3px',
  borderRadius: '2px',
  backgroundColor: vars.color.grid,
  overflow: 'hidden',
  pointerEvents: 'none',
});

export const barFillSelf = style({
  height: '100%',
  borderRadius: '2px',
  backgroundColor: vars.color.accent,
});

export const barFillTotal = style({
  height: '100%',
  borderRadius: '2px',
  backgroundColor: vars.color.textMuted,
  opacity: 0.45,
});

export const emptyNotice = style({
  padding: '24px 16px',
  textAlign: 'center',
  color: vars.color.textMuted,
  fontSize: '12.5px',
});
