/**
 * The DOM painter with its stylesheet: the factory the element mounts.
 *
 * Kept apart from `dom.ts` so that file never imports a `*.css.ts` module and can be tested in Node.
 */

import { createDomPainter } from './dom.ts';
import * as styles from './dom.css.ts';
import type { PainterContext, WaterfallPainter } from './painter.ts';

/** Mount the DOM painter into `context.host`. */
export function mountDomPainter(context: PainterContext): WaterfallPainter {
  return createDomPainter(context, styles);
}
