/**
 * Shell: the tooltip
 *
 * A small box that describes the element under the pointer. It is told what to show (an
 * `InfoModel`) and where (the box of the element, in the coordinates of its container) and keeps
 * itself inside the container.
 *
 * It never asks the browser for its size while the page is being changed: reading `offsetWidth`
 * right after the DOM was written forces a style and layout pass on every hover, which on a view
 * with hundreds of boxes cost about 3 ms. Instead a `ResizeObserver` reports the size once the
 * browser has laid the box out in the normal rendering step, and the tooltip is placed with the
 * last known size at once and again, before painting, if the size turns out to have changed.
 */

import type { InfoModel } from '../core.ts';
import { h } from '../kit/dom.ts';
import { renderBrief } from './info.ts';
import * as styles from './shell.css.ts';
import { placeTooltip, type TooltipAnchor } from './tooltip-model.ts';

export type { TooltipAnchor } from './tooltip-model.ts';

/** What the last `show` asked for, to place the box again when its size changes. */
interface Request {
  readonly anchor: TooltipAnchor;
  readonly container: { readonly width: number; readonly height: number };
}

/** The tooltip element and its behaviour. */
export class Tooltip {
  readonly element: HTMLElement;
  private shownKey: string | null = null;
  private request: Request | null = null;
  private width = 0;
  private height = 0;
  private readonly observer: ResizeObserver | null;

  constructor() {
    this.element = h('div', { class: styles.tooltip, role: 'tooltip', hidden: true });
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      // a hidden box reports no size: keep the last real one as the guess for the next show
      if (this.element.hidden) return;
      const size = entries[entries.length - 1].borderBoxSize?.[0];
      if (size === undefined) return;
      this.width = size.inlineSize;
      this.height = size.blockSize;
      this.place();
    });
    this.observer?.observe(this.element);
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
    this.request = { anchor, container };
    if (this.observer === null) {
      this.width = this.element.offsetWidth;
      this.height = this.element.offsetHeight;
    }
    this.place();
  }

  /** Hide it. */
  hide(): void {
    if (this.shownKey === null && this.element.hidden) return;
    this.shownKey = null;
    this.request = null;
    this.element.hidden = true;
  }

  private place(): void {
    if (this.request === null) return;
    const { x, y } = placeTooltip(this.request.anchor, { width: this.width, height: this.height }, this.request.container);
    this.element.style.transform = `translate(${x}px, ${y}px)`;
  }
}
