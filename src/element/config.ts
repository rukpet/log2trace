/**
 * Element configuration: what `<trace-visualizer>` is told through attributes, child
 * elements and the `config` property.
 *
 * Every field maps to a kebab-case attribute. The transform fields say how raw logs become
 * spans (the headless `TransformConfig`), the rest is display and data-source behaviour. The
 * programmatic `config` property wins over attributes, field by field, as it always did.
 *
 * Nothing here touches the DOM beyond reading attributes from what it is given, so it is tested
 * in Node with plain objects.
 */

import type { FilterFieldConfig, FilterFieldType, FilterOption, FilterSource, FilterTarget, OptionsSource, SpanKindRule, TransformConfig } from '../core/config.ts';
import { normalizeOptions } from '../core/config.ts';
import { SpanKind } from '../core/otel/trace.ts';
import { KIND_TOKENS, type ColorToken } from '../kit/theme/theme.ts';

/** Everything configurable, all optional: one type for the attributes and the resolved result. */
export interface TraceVisualizerConfig extends Partial<TransformConfig> {
  /** URL to fetch trace or log data from. */
  dataUrl?: string;
  /** Height of the element in px. */
  height?: number;
  /** Height of a span bar in px. */
  spanHeight?: number;
  /** Space between span rows in px. */
  spanPadding?: number;
  /** Width of the label column in px. */
  gutterWidth?: number;
  /** Show the span-kind colour legend. */
  showLegend?: boolean;
  /** Stretch to the width of the parent. */
  fullWidth?: boolean;
  /** CSS width of the detail panel. */
  detailPanelWidth?: string;
  /** Colour by span kind (a kind number or name to a CSS colour). */
  kindColors?: Record<string, string>;
  /** Whether a change of an external filter fetches at once (default) or waits for the Search button. */
  autoFetch?: boolean;
  /** The filter fields. */
  filterConfigs?: FilterFieldConfig[];
  /** The declared child views. */
  viewConfigs?: TraceViewConfig[];
}

/** One declared view child element (`<trace-view>`). */
export interface TraceViewConfig {
  /** The registered view type/id (e.g. 'waterfall', 'flame', 'service', 'sequence'). */
  type: string;
  /** Optional custom tab label. */
  label?: string;
  /** Whether this view is initially active. */
  active?: boolean;
}

/** What can be read from: an element, or anything shaped like one. */
export interface AttributeSource {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly children: ArrayLike<AttributeSource & { readonly tagName: string }>;
}

/** The part of the config the transform needs to be present. */
export function isTransformReady(config: TraceVisualizerConfig): config is TraceVisualizerConfig & TransformConfig {
  return [config.traceIdField, config.spanNameField, config.serviceNameField, config.timestampField].every(Boolean);
}

function parseSpanKindRule(el: AttributeSource): SpanKindRule | null {
  const kind = el.getAttribute('kind');
  if (!kind) return null;
  const matchField = el.getAttribute('match-field');
  const matchValue = el.getAttribute('match-value');
  if (matchField && matchValue) return { match: { [matchField]: matchValue }, kind };
  const matchAttr = el.getAttribute('match');
  if (matchAttr) {
    try {
      const match: unknown = JSON.parse(matchAttr);
      if (typeof match === 'object' && match !== null) return { match: match as Record<string, string>, kind };
    } catch {
      console.warn('Invalid JSON in span-kind-rule match attribute:', matchAttr);
    }
  }
  return null;
}

function parseFilter(el: AttributeSource): FilterFieldConfig | null {
  const field = el.getAttribute('field');
  const label = el.getAttribute('label');
  const type = el.getAttribute('type') as FilterFieldType | null;
  const source = el.getAttribute('source') as FilterSource | null;
  if (!field || !label || !type || !source) return null;

  let options: Array<string | FilterOption> = [];
  const optionsAttr = el.getAttribute('options');
  if (optionsAttr) {
    try {
      options = JSON.parse(optionsAttr) as Array<string | FilterOption>;
    } catch {
      // an unreadable list is an empty one
    }
  }
  return {
    field, label, type, source,
    target: (el.getAttribute('target') as FilterTarget | null) || 'span',
    required: el.hasAttribute('required'),
    options: normalizeOptions(options),
    optionsSource: (el.getAttribute('options-source') as OptionsSource | null) || 'static',
    placeholder: el.getAttribute('placeholder') || '',
    debounce: parseInt(el.getAttribute('debounce') || '400', 10),
    width: parseInt(el.getAttribute('width') || '300', 10),
    autoRange: el.hasAttribute('auto-range'),
  };
}

function parseTraceView(el: AttributeSource): TraceViewConfig | null {
  const type = el.getAttribute('type') || el.getAttribute('id');
  if (!type) return null;
  const label = el.getAttribute('label') || undefined;
  const active = el.hasAttribute('active');
  return {
    type,
    ...(label ? { label } : {}),
    ...(active ? { active: true } : {}),
  };
}

/** Warning issued when deprecated `views` attribute is used. */
export const DEPRECATED_VIEWS_WARNING =
  '<trace-visualizer>: The "views" attribute is deprecated and ignored. Declare child <trace-view> elements instead.';

/** Read the attributes and the `<trace-view>`, `<trace-filter>` and `<span-kind-rule>` children of an element. */
export function readConfig(source: AttributeSource): TraceVisualizerConfig {
  if (source.hasAttribute('views') || source.getAttribute('views') !== null) {
    console.warn(DEPRECATED_VIEWS_WARNING);
  }
  const config: TraceVisualizerConfig = {};
  const str = (name: string): string | undefined => source.getAttribute(name) ?? undefined;
  const csv = (name: string): string[] | undefined => {
    const value = source.getAttribute(name);
    return value ? value.split(',').map((part) => part.trim()) : undefined;
  };
  const num = (name: string): number | undefined => {
    const value = source.getAttribute(name);
    const parsed = value ? parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const bool = (name: string): boolean | undefined => {
    const value = source.getAttribute(name);
    return value !== null ? value !== 'false' : undefined;
  };
  const json = (name: string): Record<string, string> | undefined => {
    const value = source.getAttribute(name);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return undefined;
    }
  };
  const set = <K extends keyof TraceVisualizerConfig>(key: K, value: TraceVisualizerConfig[K]): void => {
    if (value !== undefined) config[key] = value;
  };

  set('dataUrl', str('data-url'));
  set('traceIdField', str('trace-id-field'));
  set('spanGroupFields', csv('span-group-fields'));
  set('spanNameField', str('span-name-field'));
  set('serviceNameField', str('service-name-field'));
  set('timestampField', str('timestamp-field'));
  set('endTimeField', str('end-time-field'));
  set('parentSpanIdField', str('parent-span-id-field'));
  set('parentSpanLookupFields', csv('parent-span-lookup-fields'));
  set('spanIdField', str('span-id-field'));
  set('statusCodeField', str('status-code-field'));
  set('defaultSpanKind', str('default-span-kind'));

  const spanKindRules: SpanKindRule[] = [];
  const filterConfigs: FilterFieldConfig[] = [];
  const viewConfigs: TraceViewConfig[] = [];
  for (let i = 0; i < source.children.length; i++) {
    const child = source.children[i];
    const tag = child.tagName.toLowerCase();
    if (tag === 'span-kind-rule') {
      const rule = parseSpanKindRule(child);
      if (rule) spanKindRules.push(rule);
    } else if (tag === 'trace-filter') {
      const filter = parseFilter(child);
      if (filter) filterConfigs.push(filter);
    } else if (tag === 'trace-view') {
      const view = parseTraceView(child);
      if (view) viewConfigs.push(view);
    }
  }
  if (spanKindRules.length > 0) set('spanKindRules', spanKindRules);
  if (filterConfigs.length > 0) set('filterConfigs', filterConfigs);
  if (viewConfigs.length > 0) set('viewConfigs', viewConfigs);

  set('height', num('height'));
  set('spanHeight', num('span-height'));
  set('spanPadding', num('span-padding'));
  set('gutterWidth', num('gutter-width'));
  set('showLegend', bool('show-legend'));
  set('fullWidth', bool('full-width'));
  set('detailPanelWidth', str('detail-panel-width'));
  set('kindColors', json('kind-colors') ?? json('color-scheme'));
  set('autoFetch', bool('auto-fetch'));
  return config;
}

/**
 * Layer the programmatic config over the one read from attributes. A single `spanGroupFields`
 * string becomes a list.
 */
export function mergeConfig(fromAttributes: TraceVisualizerConfig, programmatic: TraceVisualizerConfig): TraceVisualizerConfig {
  const config = { ...fromAttributes, ...programmatic };
  if (typeof config.spanGroupFields === 'string') config.spanGroupFields = [config.spanGroupFields];
  return config;
}

/**
 * Colour overrides for span kinds as `[token, colour]` pairs. Keys are the kind number (`"2"`) or
 * its name (`"Server"`, any case); anything else is skipped.
 */
export function kindColorOverrides(colors: Record<string, string> | undefined): Array<[ColorToken, string]> {
  const result: Array<[ColorToken, string]> = [];
  if (colors === undefined) return result;
  for (const [key, color] of Object.entries(colors)) {
    let kind: number | undefined;
    if (/^\d+$/.test(key)) kind = Number(key);
    else {
      const named = Object.entries(SpanKind).find(([name, value]) => typeof value === 'number' && name.toLowerCase() === key.toLowerCase());
      kind = named === undefined ? undefined : Number(named[1]);
    }
    if (kind === undefined || kind < 0 || kind >= KIND_TOKENS.length || typeof color !== 'string') continue;
    result.push([KIND_TOKENS[kind], color]);
  }
  return result;
}

/**
 * Filter and deduplicate declared view configurations against registered/known views.
 * An empty or unusable list falls back to the default waterfall view.
 */
export function resolveDeclaredViews(
  viewConfigs: readonly TraceViewConfig[] | undefined,
  isKnown: (type: string) => boolean = () => true,
): TraceViewConfig[] {
  if (!viewConfigs || viewConfigs.length === 0) {
    return [{ type: 'waterfall' }];
  }
  const seen = new Set<string>();
  const valid: TraceViewConfig[] = [];
  for (const config of viewConfigs) {
    if (!seen.has(config.type) && isKnown(config.type)) {
      seen.add(config.type);
      valid.push(config);
    }
  }
  return valid.length > 0 ? valid : [{ type: 'waterfall' }];
}

/**
 * Determine which view should be active:
 * 1. `requested` view if it is among the available types.
 * 2. The view marked `active` in `viewConfigs` if it is among the available types.
 * 3. The first available view type (defaults to 'waterfall' if available is empty).
 */
export function resolveActiveView(
  availableTypes: readonly string[],
  requested: string | null | undefined,
  viewConfigs?: readonly TraceViewConfig[],
): string {
  const fallback = availableTypes[0] ?? 'waterfall';
  if (requested && availableTypes.includes(requested)) {
    return requested;
  }
  if (viewConfigs) {
    const activeConf = viewConfigs.find((c) => c.active && availableTypes.includes(c.type));
    if (activeConf) {
      return activeConf.type;
    }
  }
  return fallback;
}

