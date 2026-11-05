/**
 * The inspector as a view: the shared state of the store as a table, and the selected spans as a
 * list you can click and hover.
 *
 * It exists to show that the view contract does not depend on a time axis, rows or a painter. It
 * draws with plain DOM, keeps no state of its own, reads everything through one selector and
 * writes to the store with its own origin, so a selection made here shows in the waterfall and
 * the other way round. Only the active view is mounted, so while the waterfall is shown this one
 * costs nothing.
 */

import { Slice, touches, type ChangeSet, type SpanId } from '../../core.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import type { TraceView, ViewContext, ViewDefinition } from '../../kit/view.ts';
import { inspectorModel, type InspectorModel, type InspectorRow } from './model.ts';
import * as styles from './view.css.ts';

/** What the view keeps while it is mounted. */
interface Mounted {
  readonly ctx: ViewContext;
  readonly root: HTMLElement;
  readonly values: Map<InspectorRow['id'], HTMLElement>;
  readonly listHolder: HTMLElement;
  listKey: string;
}

/** The inspector view. */
export class InspectorView implements TraceView {
  private mounted: Mounted | null = null;

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;
    const values = new Map<InspectorRow['id'], HTMLElement>();
    const model = ctx.store.derive(inspectorModel);

    // one definition-list row per line of the table, built once and patched afterwards
    const rows = h('dl', { class: styles.rows }, model.rows.map((row) => {
      const value = h('dd', { class: styles.value }, row.value);
      values.set(row.id, value);
      return [h('dt', { class: styles.label }, row.label), value];
    }));
    const listHolder = h('div');
    const root = h(
      'div',
      { class: styles.root, part: 'inspector', tabindex: 0, role: 'region', 'aria-label': 'Store inspector' },
      rows,
      h('h3', { class: styles.heading }, 'Selected spans'),
      listHolder,
    );
    surface.append(root);
    this.mounted = { ctx, root, values, listHolder, listKey: '' };
    this.render(model);
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    m.root.remove();
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;
    if (touches(change, Slice.Data | Slice.Selection | Slice.Hover | Slice.Collapse | Slice.Filter | Slice.Window)) {
      this.render(m.ctx.store.derive(inspectorModel));
    }
  }

  settingsChanged(): void {
    // nothing to configure
  }

  themeChanged(): void {
    // the stylesheet follows the tokens by itself
  }

  commands(): readonly ViewCommand[] {
    const m = this.mounted;
    if (m === null) return [];
    const { store, origin } = m.ctx;
    return [
      { id: 'clear-selection', label: 'Clear selection', run: () => store.setSelection([], { origin }), enabled: () => store.state.selection.ids.size > 0 },
    ];
  }

  focus(): void {
    this.mounted?.root.focus({ preventScroll: true });
  }

  getState(): null {
    return null;
  }

  setState(): void {
    // the view has no state of its own
  }

  // ---------------------------------------------------------------------------

  private render(model: InspectorModel): void {
    const m = this.mounted;
    if (m === null) return;
    for (const row of model.rows) {
      const value = m.values.get(row.id);
      if (value !== undefined && value.textContent !== row.value) value.textContent = row.value;
    }
    // the list is rebuilt only when its content changes, so a hover never replaces the element under the pointer
    if (model.selectedKey === m.listKey) return;
    m.listKey = model.selectedKey;
    m.ctx.refreshCommands();

    if (model.selected.length === 0) {
      m.listHolder.replaceChildren(h('div', { class: styles.empty }, 'Nothing selected.'));
      return;
    }
    const items = model.selected.map((span) => {
      const button = h('button', { class: styles.item, type: 'button', title: span.label }, span.label);
      button.addEventListener('click', () => this.choose(span.id));
      button.addEventListener('pointerenter', () => m.ctx.store.setHover([span.id], { origin: m.ctx.origin }));
      button.addEventListener('pointerleave', () => m.ctx.store.setHover(null, { origin: m.ctx.origin }));
      return h('li', null, button);
    });
    const hidden = model.selectedTotal - model.selected.length;
    m.listHolder.replaceChildren(h('ul', { class: styles.list }, items, hidden > 0 && h('li', { class: styles.more }, `and ${hidden} more`)));
  }

  private choose(id: SpanId): void {
    const m = this.mounted;
    if (m === null) return;
    m.ctx.store.setSelection([id], { origin: m.ctx.origin, primary: id });
  }
}

/** The inspector, as the element lists it. */
export const inspectorDefinition: ViewDefinition = {
  id: 'inspector',
  label: 'Inspector',
  renderers: ['dom'],
  capabilities: {},
  create: () => new InspectorView(),
};
