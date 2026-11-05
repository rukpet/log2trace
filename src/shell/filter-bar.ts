/**
 * Shell: the filter bar
 *
 * Draws a `FilterModel` and writes what the user types back through handlers. The bar is built
 * once for a set of filter configs and then only has its values synchronised, so typing never
 * loses focus; it is rebuilt (keeping focus and an open multiselect) only when the configs or the
 * option lists change, for instance when `auto` dropdowns learn their options from new data.
 */

import type { FilterFieldConfig, FilterSource, FilterValue } from '../core/config.ts';
import type { FilterModel } from '../core/filter-model.ts';
import { h } from '../kit/dom.ts';
import * as styles from './filter-bar.css.ts';

/** What the bar tells its owner. */
export interface FilterBarHandlers {
  /** A value changed by the user (text after its debounce). */
  onChange(field: string, source: FilterSource, value: FilterValue): void;
  /** The Search button was pressed. */
  onSearch(): void;
  /** The Clear button was pressed. */
  onClear(): void;
}

/** One drawn control: how to put a model value into it. */
interface Control {
  sync(value: FilterValue | undefined): void;
  readonly field: string;
  readonly source: FilterSource;
}

/** The filter bar element and its behaviour. */
export class FilterBar {
  readonly element: HTMLElement;
  private readonly handlers: FilterBarHandlers;
  private controls: Control[] = [];
  private signature = '';
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private openField: string | null = null;

  constructor(handlers: FilterBarHandlers) {
    this.handlers = handlers;
    this.element = h('div', { class: styles.container, part: 'filter-bar', hidden: true });
  }

  /**
   * Bring the bar up to date with the model.
   *
   * @param model - The configured filters and their values.
   * @param autoFetch - Whether external filters fetch on change; when not, a Search button is shown.
   */
  update(model: FilterModel, autoFetch: boolean): void {
    const signature = JSON.stringify([model.configs, autoFetch]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild(model, autoFetch);
    }
    for (const control of this.controls) control.sync(model.get(control.field, control.source));
  }

  /**
   * Put the keyboard focus on the first control worth typing into: a local text filter, else the
   * first text filter, else the first control. False when the bar is hidden or has none.
   */
  focusFirst(): boolean {
    if (this.element.hidden) return false;
    const target = this.element.querySelector<HTMLElement>('input[data-filter-type="text"][data-filter-source="local"]')
      ?? this.element.querySelector<HTMLElement>('input[data-filter-type="text"]')
      ?? this.element.querySelector<HTMLElement>('input, select, button');
    if (target === null) return false;
    target.focus();
    if (target instanceof HTMLInputElement && target.type === 'text') target.select();
    return true;
  }

  /** Close an open multiselect panel. */
  closePanels(): void {
    this.openField = null;
    for (const panel of this.element.querySelectorAll<HTMLElement>('[data-open="true"]')) panel.dataset.open = 'false';
    for (const trigger of this.element.querySelectorAll<HTMLElement>('[aria-expanded="true"]')) trigger.setAttribute('aria-expanded', 'false');
  }

  /** Stop the pending debounced changes. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------

  private rebuild(model: FilterModel, autoFetch: boolean): void {
    const root = this.element.getRootNode() as Document | ShadowRoot;
    const focused = root.activeElement instanceof HTMLElement && this.element.contains(root.activeElement) ? root.activeElement : null;
    const refocus = focused === null ? null : {
      field: focused.dataset.filterField, source: focused.dataset.filterSource, range: focused.dataset.filterRange,
      caret: focused instanceof HTMLInputElement ? focused.selectionStart : null,
    };

    this.dispose();
    this.controls = [];
    const configs = model.configs;
    const external = configs.filter((c) => c.source === 'external');
    const local = configs.filter((c) => c.source === 'local');
    this.element.hidden = configs.length === 0;
    const rows: HTMLElement[] = [];
    if (external.length > 0) rows.push(this.row(external, 'external', !autoFetch));
    if (local.length > 0) rows.push(this.row(local, 'local', false));
    this.element.replaceChildren(...rows);

    if (refocus?.field !== undefined) {
      const selector = `[data-filter-field="${CSS.escape(refocus.field)}"][data-filter-source="${refocus.source ?? ''}"]${refocus.range ? `[data-filter-range="${refocus.range}"]` : ''}`;
      const target = this.element.querySelector<HTMLInputElement>(selector);
      target?.focus();
      if (refocus.caret !== null && target?.setSelectionRange !== undefined) {
        try {
          target.setSelectionRange(refocus.caret, refocus.caret);
        } catch {
          // inputs such as datetime-local have no caret
        }
      }
    }
  }

  private row(filters: FilterFieldConfig[], source: FilterSource, withSearch: boolean): HTMLElement {
    const external = source === 'external';
    const search = withSearch && h('button', { class: [styles.button, styles.searchButton], type: 'button', 'data-filter-action': 'search' }, 'Search');
    const clear = !external && h('button', { class: styles.button, type: 'button', 'data-filter-action': 'clear-local' }, 'Clear');
    if (search) search.addEventListener('click', () => this.handlers.onSearch());
    if (clear) clear.addEventListener('click', () => this.handlers.onClear());
    return h(
      'div',
      { class: [styles.row, external ? styles.rowExternal : styles.rowLocal] },
      h('span', { class: [styles.rowLabel, external ? styles.rowLabelExternal : styles.rowLabelLocal] }, external ? 'Search' : 'Filter'),
      filters.map((filter) => this.field(filter, source)),
      search,
      clear,
    );
  }

  private field(filter: FilterFieldConfig, source: FilterSource): HTMLElement {
    switch (filter.type) {
      case 'dropdown': return this.dropdown(filter, source);
      case 'checkbox': return this.checkbox(filter, source);
      case 'datetime-range': return this.datetime(filter, source);
      case 'multiselect': return this.multiselect(filter, source);
      default: return this.text(filter, source);
    }
  }

  private label(filter: FilterFieldConfig): HTMLElement {
    return h('label', { class: styles.label }, filter.label, filter.required && h('span', { class: styles.requiredMarker }, '*'));
  }

  private data(filter: FilterFieldConfig, source: FilterSource, type: string): Record<string, string> {
    return { 'data-filter-field': filter.field, 'data-filter-source': source, 'data-filter-type': type };
  }

  private register(filter: FilterFieldConfig, source: FilterSource, sync: (value: FilterValue | undefined) => void): void {
    this.controls.push({ field: filter.field, source, sync });
  }

  private text(filter: FilterFieldConfig, source: FilterSource): HTMLElement {
    const input = h('input', { class: styles.input, type: 'text', placeholder: filter.placeholder || `${filter.label}...`, ...this.data(filter, source, 'text') });
    if (filter.width > 0) input.style.width = `${filter.width}px`;
    const key = `${source}:${filter.field}`;
    input.addEventListener('input', () => {
      clearTimeout(this.timers.get(key));
      this.timers.set(key, setTimeout(() => {
        this.timers.delete(key);
        this.handlers.onChange(filter.field, source, input.value);
      }, filter.debounce));
    });
    this.register(filter, source, (value) => {
      // do not overwrite what is being typed while its change is still waiting
      if (typeof value === 'string' && !this.timers.has(key) && input.value !== value) input.value = value;
    });
    return h('div', { class: styles.field }, this.label(filter), input);
  }

  private dropdown(filter: FilterFieldConfig, source: FilterSource): HTMLElement {
    const select = h(
      'select',
      { class: [styles.input, styles.select], ...this.data(filter, source, 'dropdown') },
      h('option', { value: '' }, filter.placeholder || `All ${filter.label.toLowerCase()}`),
      filter.options.map((option) => h('option', { value: option.value }, option.label)),
    );
    if (filter.width > 0) select.style.width = `${filter.width}px`;
    select.addEventListener('change', () => this.handlers.onChange(filter.field, source, select.value));
    this.register(filter, source, (value) => {
      if (typeof value === 'string' && select.value !== value) select.value = value;
    });
    return h('div', { class: styles.field }, this.label(filter), select);
  }

  private checkbox(filter: FilterFieldConfig, source: FilterSource): HTMLElement {
    const id = `filter-${source}-${filter.field}`;
    const input = h('input', { class: styles.checkbox, type: 'checkbox', id, ...this.data(filter, source, 'checkbox') });
    input.addEventListener('change', () => this.handlers.onChange(filter.field, source, input.checked));
    this.register(filter, source, (value) => {
      input.checked = value === true;
    });
    return h('div', { class: styles.checkboxField }, input, h('label', { class: styles.checkboxLabel, for: id }, filter.label));
  }

  private datetime(filter: FilterFieldConfig, source: FilterSource): HTMLElement {
    const make = (range: 'from' | 'to'): HTMLInputElement => {
      const input = h('input', { class: styles.input, type: 'datetime-local', step: '0.001', 'data-filter-range': range, ...this.data(filter, source, 'datetime-range') });
      if (filter.width > 0) input.style.width = `${filter.width}px`;
      return input;
    };
    const from = make('from');
    const to = make('to');
    const read = (): { from: string; to: string } => ({ from: from.value, to: to.value });
    from.addEventListener('change', () => this.handlers.onChange(filter.field, source, read()));
    to.addEventListener('change', () => this.handlers.onChange(filter.field, source, read()));
    this.register(filter, source, (value) => {
      const range = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { from: '', to: '' };
      if (from.value !== (range.from ?? '')) from.value = range.from ?? '';
      if (to.value !== (range.to ?? '')) to.value = range.to ?? '';
    });
    return h('div', { class: styles.field }, this.label(filter), h('div', { class: styles.datetimeGroup }, from, h('span', { class: styles.datetimeSeparator }, 'to'), to));
  }

  private multiselect(filter: FilterFieldConfig, source: FilterSource): HTMLElement {
    const trigger = h('button', { class: styles.multiselectTrigger, type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': this.openField === filter.field }, 'All');
    const boxes = filter.options.map((option) => h('input', { class: styles.multiselectCheckbox, type: 'checkbox', value: option.value }));
    const panel = h(
      'div',
      { class: styles.multiselectPanel, role: 'listbox', 'data-open': this.openField === filter.field },
      filter.options.map((option, i) => h('label', { class: styles.multiselectItem }, boxes[i], option.label)),
    );
    const wrapper = h('div', { class: styles.multiselect, ...this.data(filter, source, 'multiselect') }, trigger, panel);
    if (filter.width > 0) wrapper.style.width = `${filter.width}px`;

    const setOpen = (open: boolean): void => {
      this.closePanels();
      if (!open) return;
      this.openField = filter.field;
      panel.dataset.open = 'true';
      trigger.setAttribute('aria-expanded', 'true');
    };
    trigger.addEventListener('click', () => setOpen(panel.dataset.open !== 'true'));
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.focus();
      }
    });
    for (const box of boxes) {
      box.addEventListener('change', () => {
        const selected = boxes.filter((b) => b.checked).map((b) => b.value);
        trigger.textContent = selected.length === 0 ? 'All' : `${selected.length} selected`;
        this.handlers.onChange(filter.field, source, selected);
      });
    }
    this.register(filter, source, (value) => {
      const selected = Array.isArray(value) ? value : [];
      for (const box of boxes) box.checked = selected.includes(box.value);
      trigger.textContent = selected.length === 0 ? 'All' : `${selected.length} selected`;
    });
    return h('div', { class: styles.field }, this.label(filter), wrapper);
  }
}
