/**
 * Styles of the DOM lanes painter.
 *
 * Everything dynamic (positions, widths, path data) is written from the painter through
 * `element.style` and attributes; these classes carry the rest. Colours come from the theme
 * tokens, so the painter follows light, dark, forced colours and the host page's overrides.
 *
 * A bar's colour is a custom property (`barColorVar`) that the kind class sets, so the variants
 * that need the colour twice (a ghost's outline and hatch, a merged bar's stripes) are one rule each
 * instead of one per kind.
 */

import { createVar, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../../kit/theme/tokens.css.ts';

/**
 * The sizes of the layout, set once on the layer: a resize rewrites a few custom properties
 * instead of the geometry of every lane and row element.
 */
export const rowHeightVar = createVar();
export const gutterWidthVar = createVar();
export const plotLeftVar = createVar();
export const plotWidthVar = createVar();
export const barHeightVar = createVar();
export const summaryHeightVar = createVar();

/** The colour of a bar, set by its kind class. */
const barColorVar = createVar();

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

/** The lanes: below the ruler, clipped, the part that scrolls. */
export const body = style({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  overflow: 'hidden',
  contain: 'layout paint',
});

/** The label column's background, behind the lane headers. */
export const gutterBackground = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: gutterWidthVar,
  background: vars.color.surface,
});

export const divider = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: vars.color.border,
});

/** The time plot: bars, summaries and grid lines, clipped to the axis. */
export const plot = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: plotLeftVar,
  width: `calc(${plotWidthVar} + 1px)`,
  overflow: 'hidden',
  contain: 'layout paint style',
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
  bottom: 0,
  height: 8,
  width: 1,
  background: vars.color.border,
});

export const rulerLabel = style({
  position: 'absolute',
  left: 0,
  bottom: 10,
  paddingLeft: 5,
  font: `11px ${vars.font.sans}`,
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

// -----------------------------------------------------------------------------
// Lane headers
// -----------------------------------------------------------------------------

/** One lane's slice of the gutter and the line above the lane; a `treeitem`. */
export const header = style({
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  contain: 'layout paint style',
});

/** The line between a lane and the one above it, across gutter and plot. */
export const laneLine = style({
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 1,
  background: vars.color.border,
});

export const gutter = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: gutterWidthVar,
  boxSizing: 'border-box',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});
export const headerHover = style({ background: vars.color.hover });

/** The height of the name's line: a row's, or less where a collapsed lane's summary row is lower than a row. */
const lineHeightVar = createVar();
const collapsedHeader = `${header}[aria-expanded="false"]`;

/** What the header says; it stays inside the lane while the lane scrolls under the ruler. */
export const headerContent = style({
  position: 'absolute',
  left: 4,
  right: 8,
  top: 1,
  display: 'flex',
  alignItems: 'flex-start',
  vars: { [lineHeightVar]: `calc(${rowHeightVar} - 1px)` },
  selectors: {
    // a collapsed lane is only a summary row tall, however tall the rows are: the line stays inside it, centred
    [`${collapsedHeader} &`]: { vars: { [lineHeightVar]: `calc(min(${rowHeightVar}, ${summaryHeightVar}) - 1px)` } },
  },
});

/** As tall as the name's line, so the triangle centred in it is centred on the text at any row height. */
export const chevron = style({
  flex: 'none',
  width: 16,
  height: lineHeightVar,
  position: 'relative',
});

const chevronBase = {
  position: 'absolute',
  left: 4,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 0,
  height: 0,
  content: '""',
} as const;

export const chevronState = styleVariants({
  expanded: {
    selectors: {
      '&::after': { ...chevronBase, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `5px solid ${vars.color.textMuted}` },
    },
  },
  collapsed: {
    selectors: {
      '&::after': { ...chevronBase, borderTop: '4px solid transparent', borderBottom: '4px solid transparent', borderLeft: `5px solid ${vars.color.textMuted}`, left: 5 },
    },
  },
});

export const headerText = style({
  flex: '1 1 0%',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
});

export const name = style({
  lineHeight: lineHeightVar,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontWeight: 600,
});
/** A peer lane: calls to something that is not instrumented. */
export const namePeer = style({ fontStyle: 'italic', fontWeight: 500 });

export const stats = style({
  fontSize: 11,
  lineHeight: '14px',
  color: vars.color.textMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
/** Too short a lane for a second line: the text stays for screen readers and find-in-page, out of sight. */
export const statsHidden = style({
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
});

// -----------------------------------------------------------------------------
// Bars
// -----------------------------------------------------------------------------

export const bar = style({
  position: 'absolute',
  left: 0,
  top: 0,
  height: barHeightVar,
  boxSizing: 'border-box',
  borderRadius: 3,
  background: barColorVar,
  color: '#fff',
  textShadow: '0 0 2px rgba(0, 0, 0, 0.55)',
  font: `11px ${vars.font.sans}`,
  lineHeight: barHeightVar,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
});
export const barSharp = style({ borderRadius: 0 });

export const kind = styleVariants({
  unspecified: { vars: { [barColorVar]: vars.color.kindUnspecified } },
  internal: { vars: { [barColorVar]: vars.color.kindInternal } },
  server: { vars: { [barColorVar]: vars.color.kindServer } },
  client: { vars: { [barColorVar]: vars.color.kindClient } },
  producer: { vars: { [barColorVar]: vars.color.kindProducer } },
  consumer: { vars: { [barColorVar]: vars.color.kindConsumer } },
});

/** Several spans merged into one bar: diagonal stripes over the colour. */
export const barMerged = style({
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0, rgba(255, 255, 255, 0.4) 1px, transparent 1px, transparent 3px)',
});

const ghostColor = `color-mix(in srgb, ${barColorVar} 60%, transparent)`;
const ghostHatch = (angle: number): string => `repeating-linear-gradient(${angle}deg, ${ghostColor} 0, ${ghostColor} 1px, transparent 1px, transparent 4px)`;

/**
 * A call seen from the caller on a peer lane: outlined and hatched in the colour, not filled. The
 * hatch is softened so the label reads over it, and the label gets a halo in the background colour.
 */
export const barGhost = style({
  background: 'transparent',
  backgroundImage: ghostHatch(135),
  boxShadow: `inset 0 0 0 1px ${barColorVar}`,
  color: vars.color.text,
  textShadow: `0 0 3px ${vars.color.background}, 0 0 2px ${vars.color.background}, 0 0 1px ${vars.color.background}`,
  selectors: {
    // several ghost calls in one run: crossed hatch on a tinted fill, so it differs from a single call
    [`${barMerged}&`]: {
      backgroundColor: `color-mix(in srgb, ${barColorVar} 22%, transparent)`,
      backgroundImage: `${ghostHatch(135)}, ${ghostHatch(45)}`,
    },
  },
});

/** A span of the run failed: a red edge on the left. */
export const barError = style({
  boxShadow: `inset 3px 0 0 ${vars.color.error}`,
  selectors: {
    [`${barGhost}&`]: { boxShadow: `inset 0 0 0 1px ${barColorVar}, inset 3px 0 0 ${vars.color.error}` },
  },
});

/** A span of the run is the ancestor or a descendant of the selection: it keeps its full colour while the rest fades. */
export const barRelated = style({ opacity: 1 });
/** Did not pass the filter. */
export const barDimmed = style({ opacity: 0.28 });
/** A span is selected and this bar is not part of its tree. */
export const barFaded = style({
  opacity: 0.4,
  selectors: { [`${barDimmed}&`]: { opacity: 0.15 } },
});
export const barSelected = style({ outline: `2px solid ${vars.color.accent}`, outlineOffset: 0, zIndex: 2 });
export const barHovered = style({ filter: 'brightness(1.15)', zIndex: 1 });

// -----------------------------------------------------------------------------
// Summaries
// -----------------------------------------------------------------------------

/** The row of a collapsed lane, or the overflow row under a capped one. */
export const summary = style({
  position: 'absolute',
  left: 0,
  top: 0,
  height: summaryHeightVar,
  width: plotWidthVar,
});

export const summarySvg = style({
  position: 'absolute',
  left: 0,
  top: 0,
  display: 'block',
  overflow: 'hidden',
});

export const summaryArea = style({
  fill: vars.color.accent,
  fillOpacity: 0.3,
  stroke: vars.color.accent,
  strokeWidth: 1,
});
export const summaryOverflowArea = style({ fillOpacity: 0.18, strokeOpacity: 0.7 });
export const summaryErrors = style({
  fill: 'none',
  stroke: vars.color.error,
  strokeWidth: 1,
  shapeRendering: 'crispEdges',
});

/** The "+N rows" button of an overflow row. */
export const overflowButton = style({
  position: 'absolute',
  left: 4,
  top: 3,
  width: 88,
  height: `calc(${summaryHeightVar} - 6px)`,
  boxSizing: 'border-box',
  border: `1px solid ${vars.color.border}`,
  borderRadius: 4,
  background: vars.color.surface,
  color: vars.color.text,
  font: `11px ${vars.font.sans}`,
  lineHeight: `calc(${summaryHeightVar} - 8px)`,
  textAlign: 'center',
  whiteSpace: 'nowrap',
});
export const overflowButtonHover = style({ borderColor: vars.color.accent, background: vars.color.hover });

/** The pointer is over a summary, an overflow row or an idle stretch. */
export const hoverBox = style({
  position: 'absolute',
  left: 0,
  top: 0,
  boxSizing: 'border-box',
  border: `1px solid ${vars.color.accent}`,
  pointerEvents: 'none',
  zIndex: 3,
});

/** Declared last: it wins over the `display` of the rules above. */
export const hidden = style({ display: 'none' });
