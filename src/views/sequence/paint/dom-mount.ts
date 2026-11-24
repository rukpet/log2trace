/**
 * The Sequence Diagram DOM painter with its stylesheet: the factory `SequenceView` mounts.
 *
 * Kept apart from `dom.ts` so `dom.ts` never imports a `*.css.ts` module and can be tested in Node.
 */

import {
  createSequenceDomPainter,
  type SequenceDomClasses,
  type SequenceDomPainter,
  type SequencePainterContext,
  type SequencePainterStats,
} from './dom.ts';
import * as styles from './dom.css.ts';

export {
  createSequenceDomPainter,
  type SequenceDomClasses,
  type SequenceDomPainter,
  type SequencePainterContext,
  type SequencePainterStats,
};

/** Mount the sequence DOM painter into `context.host`. */
export function mountSequenceDomPainter(context: SequencePainterContext): SequenceDomPainter {
  return createSequenceDomPainter(context, styles);
}
