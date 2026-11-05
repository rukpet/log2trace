/**
 * Shell: the detail panel
 *
 * Shows the full description of the selected span beside the view and hides itself when nothing is
 * selected. It re-renders only when what it shows changes.
 *
 * Opening it never takes the focus: arrow keys in the view select spans, and the panel would steal
 * the next key. The owner moves the focus in on an explicit request (Enter on a selected span) with
 * {@link DetailPanel.focus}. Escape inside the panel, and hiding the panel while it holds the focus,
 * hand the focus back through `onReturn`, so the keyboard never lands on a hidden element.
 */

import type { InfoModel } from '../core.ts';
import { h } from '../kit/dom.ts';
import { renderInfoHeader, renderSections } from './info.ts';
import * as styles from './shell.css.ts';

/** What the panel tells its owner. */
export interface DetailPanelHandlers {
  /** The close button was pressed; the owner clears the selection. */
  onClose(): void;
  /** The panel is done with the keyboard focus (Escape, or it hid while holding it). */
  onReturn(): void;
}

/** The panel and its behaviour. */
export class DetailPanel {
  readonly element: HTMLElement;
  private shownKey: string | null = null;
  private readonly handlers: DetailPanelHandlers;

  constructor(handlers: DetailPanelHandlers) {
    this.handlers = handlers;
    this.element = h('aside', { class: styles.detail, 'aria-label': 'Span details', tabindex: -1, hidden: true });
    this.element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      this.handlers.onReturn();
    });
  }

  /** Set the width of the panel; `undefined` goes back to the stylesheet's. */
  setWidth(width: string | undefined): void {
    this.element.style.width = width ?? '';
    this.element.style.maxWidth = width === undefined ? '' : 'none';
  }

  /** Whether the keyboard focus is inside the panel. */
  hasFocus(): boolean {
    const root = this.element.getRootNode() as Document | ShadowRoot;
    return root.activeElement !== null && this.element.contains(root.activeElement);
  }

  /** Move the keyboard focus into the panel; false when it is hidden. */
  focus(): boolean {
    if (this.element.hidden) return false;
    this.element.focus({ preventScroll: true });
    return true;
  }

  /**
   * Show a model, or hide the panel.
   *
   * @param key - Identifies what is shown; nothing is rebuilt while it stays the same.
   * @param model - The description, or `null` for nothing selected.
   */
  show(key: string | null, model: InfoModel | null): void {
    if (key === null || model === null) {
      const hadFocus = this.hasFocus();
      this.shownKey = null;
      this.element.hidden = true;
      if (hadFocus) this.handlers.onReturn();
      return;
    }
    this.element.hidden = false;
    if (key === this.shownKey) return;
    this.shownKey = key;

    const hadFocus = this.hasFocus();
    const close = h('button', { class: [styles.button, styles.detailClose], type: 'button', 'aria-label': 'Close details' }, '×');
    close.addEventListener('click', () => this.handlers.onClose());
    this.element.replaceChildren(close, ...renderInfoHeader(model), ...renderSections(model));
    // rebuilding drops the focused child, so the panel itself keeps the focus
    if (hadFocus) this.element.focus({ preventScroll: true });
  }
}
