/**
 * Shell: the toolbar
 *
 * A button per view command, plus the readouts commands carry (the zoom level). It knows
 * `ViewCommand` and nothing about which view the commands belong to.
 */

import type { ViewCommand } from '../kit/commands.ts';
import { h } from '../kit/dom.ts';
import * as styles from './shell.css.ts';

/** A toolbar and what it needs to be kept current. */
export interface Toolbar {
  readonly element: HTMLElement;
  /** Re-read the readouts and which buttons are enabled. */
  refresh(): void;
}

/**
 * Build a toolbar.
 *
 * @param commands - The commands of the view; a button is made for each.
 */
export function createToolbar(commands: readonly ViewCommand[]): Toolbar {
  const updaters: Array<() => void> = [];
  const nodes: HTMLElement[] = [];

  for (const command of commands) {
    const button = h('button', { class: styles.button, type: 'button', title: command.label, 'aria-label': command.label }, shortLabel(command));
    button.addEventListener('click', () => command.run());
    nodes.push(button);
    if (command.enabled !== undefined) {
      const enabled = command.enabled;
      updaters.push(() => {
        button.disabled = !enabled();
      });
    }
    if (command.readout !== undefined) {
      const readout = h('span', { class: styles.readout, 'aria-live': 'off' });
      const read = command.readout;
      updaters.push(() => {
        readout.textContent = read();
      });
      nodes.push(readout);
    }
  }

  const element = h('div', { class: styles.toolbar, role: 'toolbar', 'aria-label': 'Trace view controls' }, nodes);
  const refresh = (): void => {
    for (const update of updaters) update();
  };
  refresh();
  return { element, refresh };
}

/** The text of a button: the symbol for the well-known commands, else the label. */
function shortLabel(command: ViewCommand): string {
  switch (command.id) {
    case 'zoom-in': return '+';
    case 'zoom-out': return '−';
    case 'zoom-reset': return 'Reset';
    case 'pan-left': return '←';
    case 'pan-right': return '→';
    default: return command.label;
  }
}
