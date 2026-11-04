/**
 * Shell: render an InfoModel
 *
 * One description of a span (`describeSpan`) is shown twice, small in the tooltip and in full in
 * the detail panel. These functions turn the model into DOM nodes without ever parsing markup,
 * so a value from a log record can only become text.
 */

import type { InfoGroup, InfoModel, InfoRow, InfoSection } from '../core.ts';
import { h } from '../kit/dom.ts';
import * as styles from './shell.css.ts';

/** The heading of a model: title, subtitle and status. */
export function renderInfoHeader(model: InfoModel): HTMLElement[] {
  const nodes: HTMLElement[] = [h('div', { class: styles.infoTitle }, model.title)];
  if (model.subtitle !== undefined) nodes.push(h('div', { class: styles.infoSubtitle }, model.subtitle));
  if (model.status !== undefined) nodes.push(h('div', { class: styles.status[model.status] }, statusText(model.status)));
  return nodes;
}

function statusText(status: 'ok' | 'error' | 'unset'): string {
  return status === 'ok' ? 'OK' : status === 'error' ? 'Error' : 'Unset';
}

/** Rows as a definition list. */
export function renderRows(rows: readonly InfoRow[]): HTMLElement {
  return h('dl', { class: styles.infoRows }, rows.map(([label, value]) => [h('dt', null, label), h('dd', null, value)]));
}

function renderGroup(group: InfoGroup): HTMLElement {
  return h(
    'div',
    { class: styles.group },
    h('div', { class: styles.groupTitle }, group.aside === undefined ? group.title : `${group.title} · ${group.aside}`),
    renderRows(group.rows),
  );
}

/** Groups (the events of a span) drawn at first, and added with each press of "Show more". */
const GROUP_PAGE = 100;

/**
 * The groups of a section. A span can carry thousands of events; drawing them all at once costs
 * hundreds of milliseconds and tens of thousands of nodes, so they come a page at a time.
 */
function renderGroups(groups: readonly InfoGroup[]): HTMLElement[] {
  if (groups.length <= GROUP_PAGE) return groups.map(renderGroup);
  const holder = h('div', null, groups.slice(0, GROUP_PAGE).map(renderGroup));
  let shown = GROUP_PAGE;
  const label = (): string => `Show ${Math.min(GROUP_PAGE, groups.length - shown)} more (${groups.length - shown} left)`;
  const more = h('button', { class: styles.button, type: 'button' }, label());
  more.addEventListener('click', () => {
    const next = groups.slice(shown, shown + GROUP_PAGE).map(renderGroup);
    holder.append(...next);
    shown += next.length;
    if (shown >= groups.length) more.remove();
    else more.textContent = label();
  });
  return [holder, more];
}

function renderSection(section: InfoSection, open: boolean): HTMLElement {
  return h(
    'details',
    { class: styles.section, open },
    h('summary', null, section.title, section.badge !== undefined && h('span', { class: styles.badge }, section.badge)),
    section.rows !== undefined && renderRows(section.rows),
    section.groups !== undefined && renderGroups(section.groups),
  );
}

/** The sections of a model, each in a native `<details>`. */
export function renderSections(model: InfoModel): HTMLElement[] {
  return model.sections.map((section, i) => renderSection(section, i === 0 || section.title !== 'Events'));
}

/** The rows of the brief model: the first section only, no groups. */
export function renderBrief(model: InfoModel): HTMLElement[] {
  const first = model.sections[0];
  return [...renderInfoHeader(model), ...(first?.rows !== undefined ? [renderRows(first.rows)] : [])];
}
