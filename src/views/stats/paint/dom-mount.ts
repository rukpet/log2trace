/**
 * The Stats DOM painter with its stylesheet: the factory `StatsView` mounts.
 *
 * Kept apart from `dom.ts` so `dom.ts` never imports a `*.css.ts` module and can be tested in Node.
 */

import {
  createStatsDomPainter,
  type StatsDomClasses,
  type StatsDomPainter,
  type StatsPaintInput,
  type StatsPainterContext,
  type StatsPainterStats,
} from './dom.ts';
import * as styles from './dom.css.ts';

export {
  createStatsDomPainter,
  type StatsDomClasses,
  type StatsDomPainter,
  type StatsPaintInput,
  type StatsPainterContext,
  type StatsPainterStats,
};

/** Mount the stats DOM painter into `context.host`. */
export function mountStatsDomPainter(context: StatsPainterContext): StatsDomPainter {
  return createStatsDomPainter(context, styles);
}
