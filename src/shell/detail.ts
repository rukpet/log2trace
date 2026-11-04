/**
 * Shell: the detail panel
 *
 * Shows the full description of the selected span beside the view and hides itself when nothing is
 * selected. It re-renders only when what it shows changes.
 */

import type { InfoModel } from '../core.ts';
import { h } from '../kit/dom.ts';
import { renderInfoHeader, renderSections } from './info.ts';
import * as styles from './shell.css.ts';

/** The panel and its behaviour. */
export class DetailPanel {
  readonly element: HTMLElement;
  private shownKey: string | null = null;
  private readonly onClose: () => void;

  /**
   * @param onClose - Called when the user presses the close button; the owner clears the selection.
   */
  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.element = h('aside', { class: styles.detail, 'aria-label': 'Span details', hidden: true });
  }

  /** Set the width of the panel; `undefined` goes back to the stylesheet's. */
  setWidth(width: string | undefined): void {
    this.element.style.width = width ?? '';
    this.element.style.maxWidth = width === undefined ? '' : 'none';
  }

  /**
   * Show a model, or hide the panel.
   *
   * @param key - Identifies what is shown; nothing is rebuilt while it stays the same.
   * @param model - The description, or `null` for nothing selected.
   */
  show(key: string | null, model: InfoModel | null): void {
    if (key === null || model === null) {
      this.shownKey = null;
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    if (key === this.shownKey) return;
    this.shownKey = key;

    const close = h('button', { class: [styles.button, styles.detailClose], type: 'button', 'aria-label': 'Close details' }, '×');
    close.addEventListener('click', this.onClose);
    this.element.replaceChildren(close, ...renderInfoHeader(model), ...renderSections(model));
  }
}
