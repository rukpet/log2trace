/**
 * Shell: the tooltip
 *
 * A small box that describes the element under the pointer. It is told what to show (an
 * `InfoModel`) and where (the box of the element, in the coordinates of its container) and keeps
 * itself inside the container.
 */

import type { InfoModel } from '../core.ts';
import { h } from '../kit/dom.ts';
import { renderBrief } from './info.ts';
import * as styles from './shell.css.ts';

/** Where the tooltip points, in the coordinates of its container. */
export interface TooltipAnchor {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Gap between the anchor and the tooltip, px. */
const GAP = 8;

/** The tooltip element and its behaviour. */
export class Tooltip {
  readonly element: HTMLElement;
  private shownKey: string | null = null;

  constructor() {
    this.element = h('div', { class: styles.tooltip, role: 'tooltip', hidden: true });
  }

  /**
   * Show a description next to an anchor.
   *
   * @param key - Identifies what is shown; the content is rebuilt only when it changes.
   * @param model - What to describe.
   * @param anchor - The element's box.
   * @param container - Size of the container the tooltip must stay inside.
   */
  show(key: string, model: InfoModel, anchor: TooltipAnchor, container: { readonly width: number; readonly height: number }): void {
    if (key !== this.shownKey) {
      this.element.replaceChildren(...renderBrief(model));
      this.shownKey = key;
    }
    this.element.hidden = false;

    const width = this.element.offsetWidth;
    const height = this.element.offsetHeight;
    let x = anchor.x + anchor.w + GAP;
    if (x + width > container.width) x = Math.max(0, anchor.x - width - GAP);
    let y = anchor.y + anchor.h + GAP;
    if (y + height > container.height) y = Math.max(0, anchor.y - height - GAP);
    this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** Hide it. */
  hide(): void {
    if (this.shownKey === null && this.element.hidden) return;
    this.shownKey = null;
    this.element.hidden = true;
  }
}
