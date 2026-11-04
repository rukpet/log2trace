/**
 * Styles of the DOM waterfall painter.
 *
 * Everything dynamic (positions, widths) is written from the painter through `element.style`;
 * these classes carry the rest. Colours come from the theme tokens, so the DOM painter follows
 * light, dark, forced colours and the host page's overrides without a probe.
 */

import { createVar, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../../kit/theme/tokens.css.ts';

/**
 * The sizes of the layout, set once on the layer: a resize rewrites six custom properties instead
 * of the geometry of every row element, marker and label.
 */
export const rowHeightVar = createVar();
export const gutterWidthVar = createVar();
export const plotLeftVar = createVar();
export const plotWidthVar = createVar();
export const barInsetVar = createVar();
export const barHeightVar = createVar();

/** Fills the host and clips. The native scroller sits above it and takes the input. */
export const layer = style({
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: vars.color.background,
  color: vars.color.text,
  font: `12px ${vars.font.sans}`,
  pointerEvents: 'none',
  userSelect: 'none',
});

export const ruler = style({
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  background: vars.color.surface,
  borderBottom: `1px solid ${vars.color.border}`,
  boxSizing: 'border-box',
  overflow: 'hidden',
});

export const body = style({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  overflow: 'hidden',
  contain: 'layout paint',
});

export const divider = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: vars.color.border,
});

export const gridLine = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 1,
  background: vars.color.grid,
});

export const rulerLine = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 1,
  background: vars.color.border,
});

export const rulerLabel = style({
  position: 'absolute',
  left: 0,
  top: 5,
  paddingLeft: 5,
  font: `11px ${vars.font.sans}`,
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

export const row = style({
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  height: rowHeightVar,
  contain: 'layout paint style',
  willChange: 'transform',
});

export const rowHover = style({ background: vars.color.hover });
export const rowSelected = style({ background: vars.color.selection });
export const rowContext = style({ opacity: 0.5 });

export const gutter = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: gutterWidthVar,
  display: 'flex',
  alignItems: 'center',
  boxSizing: 'border-box',
  paddingRight: 8,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});

export const chevron = style({
  flex: 'none',
  width: 16,
  height: 16,
  position: 'relative',
});

const chevronBase = {
  position: 'absolute',
  left: 4,
  top: 5,
  width: 0,
  height: 0,
  content: '""',
} as const;

export const chevronState = styleVariants({
  expanded: {
    selectors: {
      '&::after': { ...chevronBase, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `5px solid ${vars.color.textMuted}`, top: 6 },
    },
  },
  collapsed: {
    selectors: {
      '&::after': { ...chevronBase, borderTop: '4px solid transparent', borderBottom: '4px solid transparent', borderLeft: `5px solid ${vars.color.textMuted}`, left: 5, top: 4 },
    },
  },
  none: {},
});

export const name = style({
  flex: '0 1 auto',
  minWidth: 0,
  marginLeft: 4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
export const nameError = style({ color: vars.color.error });

/** Takes only the room the name leaves: the name keeps its full width for as long as it fits. */
export const service = style({
  flex: '1 1 0%',
  minWidth: 0,
  marginLeft: 6,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  font: `11px ${vars.font.sans}`,
  color: vars.color.textMuted,
});

/** The cell the bar, its markers and its duration live in; it clips them to the plot. */
export const plotCell = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: plotLeftVar,
  width: `calc(${plotWidthVar} + 1px)`,
  overflow: 'hidden',
  contain: 'layout paint style',
});

export const bar = style({
  position: 'absolute',
  left: 0,
  top: barInsetVar,
  height: barHeightVar,
  borderRadius: 3,
  willChange: 'transform',
});

export const kind = styleVariants({
  unspecified: { background: vars.color.kindUnspecified },
  internal: { background: vars.color.kindInternal },
  server: { background: vars.color.kindServer },
  client: { background: vars.color.kindClient },
  producer: { background: vars.color.kindProducer },
  consumer: { background: vars.color.kindConsumer },
});

export const barError = style({ boxShadow: `inset 3px 0 0 ${vars.color.error}` });
export const barSelected = style({ outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 });

export const marker = style({
  position: 'absolute',
  left: 0,
  top: barInsetVar,
  height: barHeightVar,
  width: 2,
  background: 'rgba(255, 255, 255, 0.8)',
  willChange: 'transform',
});

export const duration = style({
  position: 'absolute',
  left: 0,
  top: 0,
  lineHeight: rowHeightVar,
  font: `11px ${vars.font.sans}`,
  whiteSpace: 'nowrap',
  willChange: 'transform',
});
export const durationOutside = style({ color: vars.color.textMuted });
/** Text on a bar takes the page background colour: white on a light page, dark on a dark one (as the canvas does). */
export const durationInside = style({ color: vars.color.background });

export const eventHover = style({
  position: 'absolute',
  left: 0,
  top: 0,
  boxSizing: 'border-box',
  border: `1px solid ${vars.color.accent}`,
  pointerEvents: 'none',
});

export const hidden = style({ display: 'none' });
