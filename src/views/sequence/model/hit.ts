/**
 * Hit testing: what is under a pointer coordinate in the sequence diagram.
 *
 * Headless: no DOM, no browser globals.
 */

import { columnAtContentX, stepAtBodyY } from './layout.ts';
import type { SequencePlan } from './plan.ts';
import { StepKind } from './steps.ts';

/** Kind of element hit in the sequence diagram. */
export const enum HitKind {
  None = 0,
  /** Lifeline participant header card (`index` = participant id). */
  Participant = 1,
  /** Message arrow or label on a step row (`index` = step index). */
  Step = 2,
  /** Folded loop badge (`index` = step index). */
  Fold = 3,
  /** Activation bar on a lifeline (`index` = activation index in `steps.act`). */
  Activation = 4,
  /** Span event tick on an activation (`index` = tick slot in `plan`, `row` = span row, `eventIdx` = table event index). */
  EventTick = 5,
}

/** Result of a geometric hit test in the sequence diagram. */
export interface SequenceHit {
  readonly kind: HitKind;
  /** Participant id (`Participant`), step index (`Step` / `Fold`), activation index (`Activation`), or tick slot (`EventTick`). */
  readonly index: number;
  /** `SpanTable` row associated with the hit, or `-1`. */
  readonly row: number;
  /** Event index in `table.evT` / `table.evSrc` when `kind === HitKind.EventTick`, else `-1`. */
  readonly eventIdx: number;
  /** Bounding box of the hit target in surface viewport coordinates (`0, 0` is top-left of the view surface), for positioning the tooltip. */
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

export const NO_SEQUENCE_HIT: SequenceHit = Object.freeze({
  kind: HitKind.None,
  index: -1,
  row: -1,
  eventIdx: -1,
  anchor: Object.freeze({ x: 0, y: 0, w: 0, h: 0 }),
});

/**
 * Hit test a point `(viewX, viewY)` in view surface coordinates (`0, 0` at top-left of surface)
 * against the current `SequencePlan`.
 */
export function hitTestSequence(
  plan: SequencePlan,
  viewX: number,
  viewY: number,
): SequenceHit {
  const { layout, steps } = plan;
  if (!layout || !steps || !Number.isFinite(viewX) || !Number.isFinite(viewY)) {
    return NO_SEQUENCE_HIT;
  }

  if (viewX < 0 || viewY < 0) {
    return NO_SEQUENCE_HIT;
  }

  // 1. Header region (0 <= viewY < layout.headerHeight).
  if (viewY < layout.headerHeight) {
    const contentX = viewX + plan.scrollLeft;
    const col = columnAtContentX(layout, contentX);
    if (col >= 0 && col < plan.columnCount) {
      const cardW = layout.columnWidth - 12;
      const centerX = plan.colCenterX[col];
      if (Math.abs(contentX - centerX) <= cardW / 2) {
        return {
          kind: HitKind.Participant,
          index: plan.colParticipant[col],
          row: -1,
          eventIdx: -1,
          anchor: {
            x: centerX - cardW / 2 - plan.scrollLeft,
            y: 4,
            w: cardW,
            h: layout.headerHeight - 8,
          },
        };
      }
    }
    return NO_SEQUENCE_HIT;
  }

  // 2. Body region (viewY >= layout.headerHeight).
  const bodyY = viewY - layout.headerHeight + plan.scrollTop;

  // Sticky left time-gutter hit test.
  if (viewX < layout.gutterWidth) {
    const s = stepAtBodyY(layout, bodyY);
    if (s >= plan.firstStep && s < plan.lastStep) {
      const slot = s - plan.firstStep;
      return {
        kind: steps.kind[s] === StepKind.Fold ? HitKind.Fold : HitKind.Step,
        index: s,
        row: steps.row[s],
        eventIdx: -1,
        anchor: {
          x: 0,
          y: plan.stepTopY[slot] - plan.scrollTop + layout.headerHeight,
          w: layout.gutterWidth,
          h: layout.rowHeight,
        },
      };
    }
    return NO_SEQUENCE_HIT;
  }

  const contentX = viewX + plan.scrollLeft;

  // Priority 1: Span Event Ticks (within 6 px radius of (tickX[t], tickY[t])).
  for (let t = 0; t < plan.tickCount; t++) {
    const dx = contentX - plan.tickX[t];
    const dy = bodyY - plan.tickY[t];
    if (dx * dx + dy * dy <= 36) {
      return {
        kind: HitKind.EventTick,
        index: t,
        row: plan.tickRow[t],
        eventIdx: plan.tickEventIdx[t],
        anchor: {
          x: plan.tickX[t] - 6 - plan.scrollLeft,
          y: plan.tickY[t] - 6 - plan.scrollTop + layout.headerHeight,
          w: 12,
          h: 12,
        },
      };
    }
  }

  // Priority 2: Visible Step Arrow / Self-Loop / Fold.
  const s = stepAtBodyY(layout, bodyY);
  if (s >= plan.firstStep && s < plan.lastStep) {
    const slot = s - plan.firstStep;
    const x0 = plan.arrowX0[slot];
    const x1 = plan.arrowX1[slot];
    const minX = Math.min(x0, x1) - 8;
    const maxX = Math.max(x0, x1) + 8;
    if (
      contentX >= minX &&
      contentX <= maxX &&
      Math.abs(bodyY - plan.stepCenterY[slot]) <= layout.rowHeight / 2
    ) {
      return {
        kind: steps.kind[s] === StepKind.Fold ? HitKind.Fold : HitKind.Step,
        index: s,
        row: steps.row[s],
        eventIdx: -1,
        anchor: {
          x: Math.min(x0, x1) - plan.scrollLeft,
          y: plan.stepTopY[slot] - plan.scrollTop + layout.headerHeight,
          w: Math.max(24, Math.abs(x1 - x0)),
          h: layout.rowHeight,
        },
      };
    }
  }

  // Priority 3: Activation Boxes (reverse order so deeper nested activations win over outer ones).
  for (let a = plan.actCount - 1; a >= 0; a--) {
    const ax = plan.actX[a];
    const ay = plan.actY[a];
    const aw = plan.actW[a];
    const ah = plan.actH[a];
    if (contentX >= ax - 3 && contentX <= ax + aw + 3 && bodyY >= ay && bodyY <= ay + ah) {
      const actIdx = plan.actIndex[a];
      return {
        kind: HitKind.Activation,
        index: actIdx,
        row: steps.act.row[actIdx],
        eventIdx: -1,
        anchor: {
          x: ax - plan.scrollLeft,
          y: ay - plan.scrollTop + layout.headerHeight,
          w: aw,
          h: ah,
        },
      };
    }
  }

  return NO_SEQUENCE_HIT;
}
