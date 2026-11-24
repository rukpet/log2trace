/**
 * Shell: the span-kind legend
 *
 * A swatch and a name per kind, in the colours of the theme (the swatches take the same tokens
 * as the bars, so the legend follows light, dark and overrides).
 */

import { h } from '../kit/dom.ts';
import type { ColorToken } from '../kit/theme/theme.ts';
import * as styles from './shell.css.ts';

/** One legend entry. */
export interface LegendItem {
  readonly label: string;
  /** The kind token whose colour the swatch shows. */
  readonly token: ColorToken;
}

/** Build the legend element. */
export function createLegend(items: readonly LegendItem[]): HTMLElement {
  return h(
    'div',
    { class: styles.legend, part: 'legend' },
    items.map((item) => h('span', { class: styles.legendItem }, h('span', { class: styles.swatch[item.token] }), item.label)),
  );
}
