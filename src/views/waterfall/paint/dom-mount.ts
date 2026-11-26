/**
 * The DOM painter with its stylesheet: the factory the element mounts.
 *
 * Kept apart from `dom.ts` so that file never imports a `*.css.ts` module and can be tested in Node.
 */

import { createDomPainter, type DomClasses, type PainterContext, type PainterStats, type WaterfallPainter } from './dom.ts';
import * as styles from './dom.css.ts';

export { createDomPainter, type DomClasses, type PainterContext, type PainterStats, type WaterfallPainter };

/** Mount the DOM painter into `context.host`. */
export function mountDomPainter(context: PainterContext): WaterfallPainter {
  return createDomPainter(context, styles);
}
