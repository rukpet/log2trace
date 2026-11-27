/**
 * The DOM painter with its stylesheet: the factory the element mounts.
 *
 * Kept apart from `dom.ts` so that file never imports a `*.css.ts` module and can be tested in Node.
 */

import { createDomPainter, type DomClasses, type LanesPainter, type PainterContext, type PainterStats } from './dom.ts';
import * as styles from './dom.css.ts';

export { createDomPainter, type DomClasses, type LanesPainter, type PainterContext, type PainterStats };

/** Mount the DOM painter into `context.host`. */
export function mountDomPainter(context: PainterContext): LanesPainter {
  return createDomPainter(context, styles);
}
