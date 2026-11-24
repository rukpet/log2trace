/**
 * Styles for the Sequence Diagram DOM painter.
 */

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../../kit/theme/tokens.css.ts';

/** Relative container holding the sticky header, lifelines, activations, and step rows. */
export const stage = style({
  position: 'relative',
  boxSizing: 'border-box',
});

/** Sticky top header band holding the corner cell and participant track. */
export const headerBand = style({
  position: 'sticky',
  top: 0,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  boxSizing: 'border-box',
  backgroundColor: vars.color.surface,
  borderBottom: `1px solid ${vars.color.border}`,
});

/** Sticky top-left corner cell above the time gutter. */
export const headerCorner = style({
  position: 'sticky',
  left: 0,
  zIndex: 6,
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  padding: '0 8px',
  boxSizing: 'border-box',
  flexShrink: 0,
  backgroundColor: vars.color.surface,
  borderRight: `1px solid ${vars.color.border}`,
  fontFamily: vars.font.mono,
  fontSize: '11px',
  color: vars.color.textMuted,
});

/** Relative container for participant column header cards. */
export const headerTrack = style({
  position: 'relative',
  height: '100%',
  flex: '1 0 auto',
});

/** Participant lifeline header card. */
export const headerCard = style({
  position: 'absolute',
  top: '4px',
  bottom: '4px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  padding: '0 8px',
  boxSizing: 'border-box',
  borderRadius: '6px',
  border: `1px solid ${vars.color.border}`,
  backgroundColor: vars.color.background,
  cursor: 'pointer',
  userSelect: 'none',
  overflow: 'hidden',
});

/** Variant modifier for ParticipantKind.Gate. */
export const headerCardGate = style({
  borderRadius: '999px',
  borderColor: vars.color.accent,
});

/** Variant modifier for ParticipantKind.Inferred. */
export const headerCardInferred = style({
  borderStyle: 'dashed',
});

/** Selected participant header card state. */
export const headerCardSelected = style({
  borderColor: vars.color.accent,
  boxShadow: `0 0 0 2px ${vars.color.accent}`,
});

/** Hovered participant header card state. */
export const headerCardHover = style({
  backgroundColor: vars.color.hover,
});

/** Dimmed participant header card state. */
export const headerCardDimmed = style({
  opacity: 0.4,
});

/** Error participant header card state. */
export const headerCardError = style({
  borderColor: vars.color.error,
});

/** Participant name text inside header card. */
export const headerTitle = style({
  fontWeight: 600,
  fontSize: '12px',
  color: vars.color.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
});

/** Participant kind badge text inside header card. */
export const headerSubtitle = style({
  fontSize: '10px',
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

/** Relative container below the header for lifelines, activations, and step rows. */
export const bodyLayer = style({
  position: 'relative',
  width: '100%',
});

/** Vertical dashed lifeline guide. */
export const lifeline = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: '0px',
  borderLeft: `1px dashed ${vars.color.border}`,
  pointerEvents: 'none',
});

/** Dimmed lifeline guide. */
export const lifelineDimmed = style({
  opacity: 0.3,
});

/** Activation bar on a lifeline. */
export const activation = style({
  position: 'absolute',
  top: 0,
  left: 0,
  borderRadius: '3px',
  border: `1px solid ${vars.color.border}`,
  boxSizing: 'border-box',
  cursor: 'pointer',
});

/** Activation bar fill color by SpanKind. */
export const activationKind = styleVariants({
  unspecified: { backgroundColor: vars.color.kindUnspecified },
  internal: { backgroundColor: vars.color.kindInternal },
  server: { backgroundColor: vars.color.kindServer },
  client: { backgroundColor: vars.color.kindClient },
  producer: { backgroundColor: vars.color.kindProducer },
  consumer: { backgroundColor: vars.color.kindConsumer },
});

/** Selected activation bar outline. */
export const activationSelected = style({
  outline: `2px solid ${vars.color.accent}`,
  zIndex: 2,
});

/** Hovered activation bar state. */
export const activationHover = style({
  filter: 'brightness(1.08)',
  zIndex: 2,
});

/** Dimmed activation bar state. */
export const activationDimmed = style({
  opacity: 0.3,
});

/** Error activation bar state. */
export const activationError = style({
  borderColor: vars.color.error,
});

/** Badge on activation for collapsed count or deep nesting. */
export const activationBadge = style({
  position: 'absolute',
  left: '100%',
  top: '2px',
  marginLeft: '4px',
  padding: '0 4px',
  borderRadius: '3px',
  fontSize: '10px',
  fontFamily: vars.font.mono,
  backgroundColor: vars.color.surface,
  color: vars.color.text,
  border: `1px solid ${vars.color.border}`,
  whiteSpace: 'nowrap',
});

/** Span event dot on an activation. */
export const eventTick = style({
  position: 'absolute',
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  backgroundColor: vars.color.text,
  border: `1px solid ${vars.color.background}`,
  transform: 'translate(-50%, -50%)',
  cursor: 'pointer',
  zIndex: 3,
});

/** Exception event tick on an activation. */
export const eventTickException = style({
  backgroundColor: vars.color.error,
  width: '8px',
  height: '8px',
});

/** Pooled step row. */
export const row = style({
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  boxSizing: 'border-box',
  cursor: 'pointer',
  userSelect: 'none',
});

/** Row hover background. */
export const rowHover = style({
  backgroundColor: vars.color.hover,
});

/** Row selected background. */
export const rowSelected = style({
  backgroundColor: vars.color.selection,
});

/** Dimmed row state. */
export const rowDimmed = style({
  opacity: 0.35,
});

/** Error row modifier. */
export const rowError = style({
  color: vars.color.error,
});

/** Sticky left time gutter cell on a row. */
export const gutterCell = style({
  position: 'sticky',
  left: 0,
  zIndex: 3,
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  padding: '0 8px',
  boxSizing: 'border-box',
  backgroundColor: vars.color.background,
  borderRight: `1px solid ${vars.color.border}`,
  fontFamily: vars.font.mono,
  fontSize: '11px',
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

/** Horizontal message arrow line. */
export const arrowLine = style({
  position: 'absolute',
  height: '0px',
  borderTop: `2px solid ${vars.color.text}`,
  pointerEvents: 'none',
});

/** Dashed return arrow line. */
export const arrowLineDashed = style({
  borderTopStyle: 'dashed',
  borderTopWidth: '1.5px',
  borderTopColor: vars.color.textMuted,
});

/** Error arrow line. */
export const arrowLineError = style({
  borderTopColor: vars.color.error,
});

/** 3-sided self-call loop box. */
export const arrowSelfLoop = style({
  position: 'absolute',
  height: '12px',
  borderTop: `1.5px solid ${vars.color.text}`,
  borderRight: `1.5px solid ${vars.color.text}`,
  borderBottom: `1.5px solid ${vars.color.text}`,
  borderRadius: '0 4px 4px 0',
  pointerEvents: 'none',
});

/** Filled triangle arrowhead pointing right. */
export const arrowHeadFilledRight = style({
  position: 'absolute',
  width: 0,
  height: 0,
  borderTop: '4px solid transparent',
  borderBottom: '4px solid transparent',
  borderLeft: '6px solid currentColor',
  color: vars.color.text,
  transform: 'translate(-100%, -50%)',
  pointerEvents: 'none',
});

/** Filled triangle arrowhead pointing left. */
export const arrowHeadFilledLeft = style({
  position: 'absolute',
  width: 0,
  height: 0,
  borderTop: '4px solid transparent',
  borderBottom: '4px solid transparent',
  borderRight: '6px solid currentColor',
  color: vars.color.text,
  transform: 'translate(0, -50%)',
  pointerEvents: 'none',
});

/** Open chevron arrowhead pointing right. */
export const arrowHeadOpenRight = style({
  position: 'absolute',
  width: '6px',
  height: '6px',
  borderTop: '1.5px solid currentColor',
  borderRight: '1.5px solid currentColor',
  color: vars.color.text,
  transform: 'translate(-100%, -50%) rotate(45deg)',
  pointerEvents: 'none',
});

/** Open chevron arrowhead pointing left. */
export const arrowHeadOpenLeft = style({
  position: 'absolute',
  width: '6px',
  height: '6px',
  borderBottom: '1.5px solid currentColor',
  borderLeft: '1.5px solid currentColor',
  color: vars.color.text,
  transform: 'translate(0, -50%) rotate(45deg)',
  pointerEvents: 'none',
});

/** Error arrowhead color modifier. */
export const arrowHeadError = style({
  color: vars.color.error,
});

/** Message label pill above the arrow line. */
export const arrowLabel = style({
  position: 'absolute',
  transform: 'translateY(-100%)',
  padding: '0 4px',
  borderRadius: '3px',
  backgroundColor: vars.color.background,
  fontFamily: vars.font.sans,
  fontSize: '11px',
  color: vars.color.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  pointerEvents: 'none',
});

/** Secondary badge pill next to label (e.g. ×12, error, skew). */
export const arrowBadge = style({
  marginLeft: '4px',
  padding: '0 4px',
  borderRadius: '3px',
  fontFamily: vars.font.mono,
  fontSize: '10px',
  backgroundColor: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  color: vars.color.textMuted,
});

/** Error badge modifier. */
export const arrowBadgeError = style({
  color: vars.color.error,
  borderColor: vars.color.error,
});

/** Idle time gap banner across lifelines. */
export const gapBanner = style({
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: '14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '10px',
  fontFamily: vars.font.mono,
  color: vars.color.textMuted,
  borderTop: `1px dotted ${vars.color.border}`,
  pointerEvents: 'none',
});
