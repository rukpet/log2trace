/**
 * Styles for the Service Graph view.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '../../kit/theme/tokens.css.ts';
import { NODE_HEIGHT, NODE_WIDTH } from './model.ts';

/** The scroller/stage container. */
export const root = style({
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: vars.color.background,
  color: vars.color.text,
  font: `12px ${vars.font.sans}`,
  outline: 'none',
  userSelect: 'none',
  touchAction: 'none',
  selectors: {
    '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
  },
});

/** Transformed world layer holding SVG edges and DOM nodes. */
export const world = style({
  position: 'absolute',
  top: 0,
  left: 0,
  transformOrigin: '0 0',
  willChange: 'transform',
});

/** SVG layer overlaying the world. */
export const edgesSvg = style({
  position: 'absolute',
  top: 0,
  left: 0,
  overflow: 'visible',
  pointerEvents: 'none',
});

export const edgeGroup = style({
  pointerEvents: 'auto',
  cursor: 'pointer',
});

export const edgeHit = style({
  fill: 'none',
  stroke: 'transparent',
  strokeWidth: 16,
  pointerEvents: 'stroke',
});

export const edgeLine = style({
  fill: 'none',
  stroke: vars.color.border,
  strokeWidth: 2,
  transition: 'stroke 0.15s, stroke-width 0.15s',
});

export const edgeLineAsync = style({
  strokeDasharray: '6 4',
});

export const edgeLineError = style({
  stroke: vars.color.error,
});

export const edgeLineHovered = style({
  stroke: vars.color.accent,
  strokeWidth: 3,
});

export const edgeLineSelected = style({
  stroke: vars.color.accent,
  strokeWidth: 3.5,
});

export const edgeLineDimmed = style({
  opacity: 0.25,
});

export const edgeLineContext = style({
  opacity: 0.4,
});

export const edgeLabel = style({
  position: 'absolute',
  transform: 'translate(-50%, -50%)',
  padding: '2px 6px',
  borderRadius: 10,
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  fontSize: 10,
  fontFamily: vars.font.mono,
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
  pointerEvents: 'auto',
  cursor: 'pointer',
  transition: 'all 0.15s',
  zIndex: 1,
});

export const edgeLabelHovered = style({
  borderColor: vars.color.accent,
  color: vars.color.accent,
  transform: 'translate(-50%, -50%) scale(1.06)',
});

export const edgeLabelSelected = style({
  borderColor: vars.color.accent,
  background: vars.color.selection,
  color: vars.color.accent,
  fontWeight: 600,
});

export const edgeLabelError = style({
  borderColor: vars.color.error,
  color: vars.color.error,
});

/** Container for node cards. */
export const nodes = style({
  position: 'absolute',
  top: 0,
  left: 0,
  pointerEvents: 'none',
});

export const node = style({
  position: 'absolute',
  boxSizing: 'border-box',
  width: NODE_WIDTH,
  height: NODE_HEIGHT,
  padding: '8px 10px',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: 6,
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)',
  cursor: 'pointer',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  transition: 'border-color 0.15s, box-shadow 0.15s, opacity 0.15s',
});

export const nodeInferred = style({
  borderStyle: 'dashed',
});

export const nodeHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
});

export const nodeTitle = style({
  fontWeight: 600,
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: vars.color.text,
});

export const nodeBadge = style({
  fontSize: 10,
  fontWeight: 500,
  padding: '1px 5px',
  borderRadius: 4,
  background: vars.color.hover,
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

export const nodeBadgeError = style({
  background: vars.color.error,
  color: '#ffffff',
});

export const nodeMetrics = style({
  fontSize: 10,
  color: vars.color.textMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const nodeSelfBar = style({
  height: 3,
  background: vars.color.grid,
  borderRadius: 2,
  overflow: 'hidden',
});

export const nodeSelfFill = style({
  height: '100%',
  background: vars.color.accent,
  borderRadius: 2,
  transition: 'width 0.2s',
});

export const nodeEntryBadge = style({
  position: 'absolute',
  left: -8,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: vars.color.accent,
  color: '#ffffff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
});

export const selected = style({
  borderColor: vars.color.accent,
  boxShadow: `0 0 0 2px ${vars.color.accent}`,
  zIndex: 3,
});

export const hovered = style({
  borderColor: vars.color.accent,
  filter: 'brightness(1.05)',
  zIndex: 2,
});

export const failed = style({
  borderColor: vars.color.error,
});

export const dimmed = style({
  opacity: 0.25,
});

export const context = style({
  opacity: 0.45,
});

export const outsideWindow = style({
  opacity: 0.35,
  borderStyle: 'dashed',
});

export const empty = style({
  padding: 16,
  color: vars.color.textMuted,
});
