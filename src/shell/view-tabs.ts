/**
 * Shell: the view tabs
 *
 * A tab list for the views the element shows. It is hidden while there is only one view, follows
 * the WAI-ARIA tabs pattern (one tab in the tab order, arrows move between tabs and select them)
 * and reports a choice through a callback. It knows ids and labels, never a particular view.
 */

import { h } from '../kit/dom.ts';
import * as styles from './shell.css.ts';
import { tabAfterKey } from './view-tabs-model.ts';

/** One tab. */
export interface TabSpec {
  readonly id: string;
  readonly label: string;
}

/** The tab list and what it needs to be kept current. */
export interface ViewTabs {
  readonly element: HTMLElement;
  /** Show these tabs, with `active` selected. */
  set(tabs: readonly TabSpec[], active: string): void;
  /** Select another tab. */
  setActive(active: string): void;
}

/**
 * Build a tab list.
 *
 * @param onSelect - Called with the id of the tab the user chose.
 * @param panelId - Id of the element the tabs control, for `aria-controls`.
 */
export function createViewTabs(onSelect: (id: string) => void, panelId: string): ViewTabs {
  const element = h('div', { class: styles.tabs, role: 'tablist', 'aria-label': 'Views', part: 'tabs', hidden: true });
  let tabs: readonly TabSpec[] = [];
  let active = '';
  const buttons = new Map<string, HTMLElement>();

  const sync = (): void => {
    for (const [id, button] of buttons) {
      const on = id === active;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle(styles.tabActive, on);
    }
  };

  element.addEventListener('keydown', (event) => {
    const next = tabAfterKey(tabs.map((tab) => tab.id), active, event.key);
    if (next === null) return;
    event.preventDefault();
    buttons.get(next)?.focus();
    onSelect(next);
  });

  return {
    element,
    set(next, selected) {
      tabs = next;
      active = selected;
      buttons.clear();
      element.hidden = next.length < 2;
      element.replaceChildren(
        ...next.map((tab) => {
          const button = h('button', { class: styles.tab, type: 'button', role: 'tab', 'aria-controls': panelId, 'data-view': tab.id }, tab.label);
          button.addEventListener('click', () => onSelect(tab.id));
          buttons.set(tab.id, button);
          return button;
        }),
      );
      sync();
    },
    setActive(selected) {
      active = selected;
      sync();
    },
  };
}
