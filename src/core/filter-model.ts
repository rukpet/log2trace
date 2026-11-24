/**
 * FilterModel: the values of the filter bar, without any UI.
 *
 * It keeps one value per configured filter field (external ones are sent to the data source,
 * local ones narrow the loaded spans), fills the options of `auto` dropdowns and the bounds of
 * `auto-range` date pickers from the loaded trace, and hands the filters to the engine in
 * `filter.ts`. The filter bar draws it and writes user input into it; nothing here knows how.
 *
 * Headless: no DOM, no browser globals.
 */

import type { Filter, FilterFieldConfig, FilterSource, FilterValue } from './config.ts';
import { areRequiredExternalFiltersFilled, buildQueryParams, matchSpans } from './filter.ts';
import type { SpanIndex, IndexedSpan } from './span-index.ts';
import type { SpanMask } from './span-set.ts';
import { getField } from './transform.ts';

/** The value of a filter nobody has touched. */
export function defaultFilterValue(config: FilterFieldConfig): FilterValue {
  switch (config.type) {
    case 'checkbox': return false;
    case 'datetime-range': return { from: '', to: '' };
    case 'multiselect': return [];
    default: return '';
  }
}

/** A date as `YYYY-MM-DDTHH:mm:ss.SSS` in local time, the value format of a `datetime-local` input. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

/** The value of a filter field in a span as text, or `undefined` when the span has none. */
function fieldValue(indexed: IndexedSpan, filter: FilterFieldConfig): string | undefined {
  const { span, serviceName } = indexed;
  switch (filter.field) {
    case 'spanName':
    case 'name':
      return span.name;
    case 'serviceName':
      return serviceName;
    case 'spanKind':
    case 'kind':
      return String(span.kind ?? '');
    default:
      break;
  }

  const fromAttributes = (attributes: ReadonlyArray<{ key: string; value: { stringValue?: string; intValue?: unknown; boolValue?: boolean } }> | undefined): string | undefined => {
    const attribute = attributes?.find((a) => a.key === filter.field);
    if (attribute === undefined) return undefined;
    if (attribute.value.stringValue !== undefined) return String(attribute.value.stringValue);
    if (attribute.value.intValue !== undefined) return String(attribute.value.intValue);
    if (attribute.value.boolValue !== undefined) return String(attribute.value.boolValue);
    return undefined;
  };

  const own = fromAttributes(span.attributes);
  if (own !== undefined) return own;
  if (filter.target === 'log' && span.events) {
    for (const event of span.events) {
      const found = fromAttributes(event.attributes);
      if (found !== undefined) return found;
    }
  }
  const raw = getField(span, filter.field);
  return raw !== undefined ? String(raw) : undefined;
}

/** What the filter bar shows and the data source needs, as values per field. */
export class FilterModel {
  private configList: FilterFieldConfig[] = [];
  private external = new Map<string, Filter>();
  private local = new Map<string, Filter>();
  private revision = 0;

  /** The configured filters. */
  get configs(): readonly FilterFieldConfig[] {
    return this.configList;
  }

  /** Counts every change of configs or values, for cheap "did anything change" checks. */
  get version(): number {
    return this.revision;
  }

  /**
   * Set the configured filters. Values of fields that stay are kept; new fields start empty.
   * The configs are used as given, so `auto` options written into them show up in the filter bar.
   */
  configure(configs: readonly FilterFieldConfig[]): void {
    this.configList = [...configs];
    const external = new Map<string, Filter>();
    const local = new Map<string, Filter>();
    for (const config of configs) {
      const target = config.source === 'external' ? external : local;
      const previous = (config.source === 'external' ? this.external : this.local).get(config.field);
      target.set(config.field, { config, value: previous?.value ?? defaultFilterValue(config) });
    }
    this.external = external;
    this.local = local;
    this.revision++;
  }

  hasFilters(): boolean {
    return this.configList.length > 0;
  }

  hasExternal(): boolean {
    return this.external.size > 0;
  }

  /** Whether some required external filter has no value yet, which holds the data back. */
  requiredUnfilled(): boolean {
    const filters = this.externalFilters();
    return filters.some((f) => f.config.required) && !areRequiredExternalFiltersFilled(filters);
  }

  externalFilters(): Filter[] {
    return [...this.external.values()];
  }

  localFilters(): Filter[] {
    return [...this.local.values()];
  }

  /** The value of a field, or `undefined` for a field that is not configured. */
  get(field: string, source: FilterSource): FilterValue | undefined {
    return (source === 'external' ? this.external : this.local).get(field)?.value;
  }

  /** Set the value of a field; unknown fields are ignored. */
  set(field: string, source: FilterSource, value: FilterValue): void {
    const filter = (source === 'external' ? this.external : this.local).get(field);
    if (filter === undefined) return;
    filter.value = value;
    this.revision++;
  }

  /** Every field's value by field name, as the `filter-changed` event reports it. */
  allValues(): Record<string, FilterValue> {
    const all: Record<string, FilterValue> = {};
    for (const [field, filter] of this.external) all[field] = filter.value;
    for (const [field, filter] of this.local) all[field] = filter.value;
    return all;
  }

  /** Reset every local filter to empty. */
  clearLocal(): void {
    for (const filter of this.local.values()) filter.value = defaultFilterValue(filter.config);
    this.revision++;
  }

  /** The external filters as query parameters. */
  queryParams(): Record<string, string | string[]> {
    return buildQueryParams(this.externalFilters());
  }

  /** The spans that pass the local filters, or `null` when none is active. */
  match(index: SpanIndex): SpanMask | null {
    return matchSpans(index, this.localFilters());
  }

  /**
   * Fill what comes from the data: the options of `auto` dropdowns and multiselects, and the
   * bounds of `auto-range` pickers that still have no value.
   *
   * @returns Whether any option list or value changed.
   */
  fillFromData(index: SpanIndex): boolean {
    if (index.size === 0) return false;
    let changed = false;

    for (const config of this.configList) {
      if ((config.type !== 'dropdown' && config.type !== 'multiselect') || config.optionsSource !== 'auto') continue;
      const unique = new Set<string>();
      for (const indexed of index.spans.values()) {
        const value = fieldValue(indexed, config);
        if (value !== undefined && value !== '') unique.add(value);
      }
      const options = [...unique].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
      if (options.length !== config.options.length || options.some((o, i) => o.value !== config.options[i].value)) {
        config.options = options;
        changed = true;
      }
    }

    const ranged = this.configList.filter((config) => config.type === 'datetime-range' && config.autoRange);
    if (ranged.length > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const indexed of index.spans.values()) {
        if (indexed.startMs < min) min = indexed.startMs;
        if (indexed.startMs > max) max = indexed.startMs;
      }
      for (const config of ranged) {
        const filter = (config.source === 'external' ? this.external : this.local).get(config.field);
        const value = filter?.value as { from?: string; to?: string } | undefined;
        if (filter !== undefined && value !== undefined && !value.from && !value.to) {
          filter.value = { from: toLocalInputValue(min), to: toLocalInputValue(max) };
          changed = true;
        }
      }
    }

    if (changed) this.revision++;
    return changed;
  }
}
