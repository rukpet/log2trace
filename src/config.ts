/**
 * Single unified configuration for the <trace-visualizer> component.
 * Every field maps 1:1 to a kebab-case HTML attribute.
 * Covers both log-to-trace transformation and visual display.
 */

import { SpanKind, type TraceData } from './opentelemetry/trace.ts';

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

/** A single arbitrary log record whose shape is defined by the user's data. */
export type LogEntry = Record<string, unknown>;

/** A value extracted from a log/span field via dot-path traversal. */
export type FieldValue = string | number | boolean | undefined;

/** A rule mapping log field values to a SpanKind. */
export interface SpanKindRule {
  /** Dot-path → value pairs; all must match for the rule to apply. */
  match: Record<string, string>;
  /** SpanKind name: "Server", "Client", "Internal", "Producer", "Consumer", "Unspecified". */
  kind: string;
}

/**
 * Unified runtime configuration for the `<trace-visualizer>` Web Component.
 *
 * Every field maps 1:1 to a kebab-case HTML attribute on the custom
 * element, so the same options can be set declaratively from markup or
 * imperatively via the `config` setter. The interface deliberately
 * mixes two concerns:
 *
 * - **Transform fields** (`traceIdField`, `spanGroupFields`,
 *   `spanNameField`, `serviceNameField`, `timestampField`, etc.) tell
 *   the component how to map raw log records onto the OTel span model.
 *   They are required only when feeding the component logs rather than
 *   pre-built {@link TraceData}.
 * - **Display fields** (`width`, `height`, `colorScheme`, `showLegend`,
 *   `detailPanelWidth`, etc.) control rendering. Defaults are applied
 *   by {@link resolveDisplayDefaults}.
 *
 * All fields are optional so a single shared type can describe both the
 * declarative attribute surface and the resolved runtime config.
 * {@link TransformConfig} narrows it to the transform-required subset.
 */
export interface TraceVisualizerConfig {
  /** URL to fetch trace/log data from */
  dataUrl?: string;

  // -- Transform (log → trace) fields ------------------------------------

  /** Dot-path to the field that groups logs into traces (e.g. "text.BTMID") */
  traceIdField?: string;

  /** Dot-path(s) that group logs into spans within a trace.
   *  If omitted, each log becomes its own span. */
  spanGroupFields?: string | string[];

  /** Dot-path to the field used as the span name/label (e.g. "text.Action") */
  spanNameField?: string;

  /** Dot-path to the field that determines the service/resource row (e.g. "text.MachineName") */
  serviceNameField?: string;

  /** Dot-path to the timestamp field (ISO 8601 or epoch-ms) */
  timestampField?: string;

  /** Dot-path to an explicit end-time field, if available */
  endTimeField?: string;

  /** Dot-path to a field providing parent-child hierarchy between spans */
  parentSpanIdField?: string;

  /** Dot-path(s) whose values identify the parent span's group fields (partial match).
   *  Positionally corresponds to spanGroupFields — e.g. ["text.InitiatingApplication"]
   *  matches the first component of spanGroupFields.
   *  Resolved after all spans are built: first tries encompassing span, then latest-before. */
  parentSpanLookupFields?: string | string[];

  /** Dot-path to a unique log identifier (used in one-log-per-span mode) */
  spanIdField?: string;

  /** Dot-path to an error-code field (e.g. "text.Code").
   *  If any log in a span has a non-zero / truthy value, the span status is Error. */
  statusCodeField?: string;

  /** Rules for determining SpanKind from log field values.
   *  Each rule has `match` (dot-path→value pairs, all must match) and `kind` (SpanKind name).
   *  First matching rule wins; default is `defaultSpanKind` or Unspecified. */
  spanKindRules?: SpanKindRule[];

  /** Default SpanKind when no rule matches or no rules are configured.
   *  Accepts a SpanKind name (e.g. "Internal", "Server") or numeric value (0-5).
   *  Defaults to "Unspecified". */
  defaultSpanKind?: string;

  // -- Display fields -----------------------------------------------------

  /** Container width in pixels (0 = fit container) */
  width?: number;

  /** Minimum container height in pixels (0 = fit content) */
  height?: number;

  /** Container background color (CSS value, default "#ffffff") */
  backgroundColor?: string;

  /** Pixel height of each span bar (default 30) */
  spanHeight?: number;

  /** Pixel spacing between span rows (default 5) */
  spanPadding?: number;

  /** Show the span-kind color legend (default false) */
  showLegend?: boolean;

  /** Stretch to fill parent width (default false) */
  fullWidth?: boolean;

  /** CSS width of the detail side-panel (default "40%") */
  detailPanelWidth?: string;

  /** SpanKind → color map for span bars and legend */
  colorScheme?: Record<string, string>;

  /** Whether external filter changes auto-trigger fetch (default true).
   *  When false, a "Search" button is rendered. */
  autoFetch?: boolean;

  /** Filter field definitions. Can be set programmatically or via <trace-filter> child elements. */
  filterConfigs?: FilterFieldConfig[];
}

// ---------------------------------------------------------------------------
// Required transform fields (narrowed for transformLogs)
// ---------------------------------------------------------------------------

/** Config with the four required transform fields present. */
export type TransformConfig = TraceVisualizerConfig &
  Required<Pick<TraceVisualizerConfig, 'traceIdField' | 'spanNameField' | 'serviceNameField' | 'timestampField'>>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_COLOR_SCHEME: Record<string, string> = {
  [SpanKind.Internal]: '#4A90E2',    // blue — neutral, most common
  [SpanKind.Server]: '#2ECC71',      // green — incoming request
  [SpanKind.Client]: '#F39C12',      // amber — outgoing request
  [SpanKind.Producer]: '#9B59B6',    // purple — async send
  [SpanKind.Consumer]: '#E74C3C',    // red — async receive
  [SpanKind.Unspecified]: '#95A5A6', // grey — unknown/default
};

/** Resolved config with all display defaults applied. */
export interface DisplayConfig {
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: string;
  readonly spanHeight: number;
  readonly spanPadding: number;
  readonly showLegend: boolean;
  readonly fullWidth: boolean;
  readonly detailPanelWidth: string;
  readonly colorScheme: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/**
 * UI control rendered for a filter.
 *
 * - `text` — free-text substring search.
 * - `dropdown` — single-select from `options`.
 * - `datetime-range` — paired `from` / `to` inputs.
 * - `checkbox` — boolean toggle.
 * - `multiselect` — multi-value select from `options`.
 */
export type FilterFieldType = 'text' | 'dropdown' | 'datetime-range' | 'checkbox' | 'multiselect';

/**
 * Where a filter is applied.
 *
 * - `local` — applied client-side via `filterSpans` (from `filter.ts`) against the
 *   already-loaded span list.
 * - `external` — sent to the data source (URL query params or a
 *   {@link FetchCallback}); the server returns a filtered payload.
 */
export type FilterSource = 'external' | 'local';

/**
 * Which level a local filter matches against.
 *
 * - `span` — match span-level fields (name, attributes, kind, etc.).
 * - `log` — match against any source log/event under the span; the span
 *   passes when at least one of its events matches.
 */
export type FilterTarget = 'span' | 'log';

/**
 * Where dropdown / multiselect options come from.
 *
 * - `static` — declared up-front via the `options` attribute / array.
 * - `auto` — derived at load time from the unique values present in the
 *   loaded data.
 */
export type OptionsSource = 'static' | 'auto';

/** A dropdown / multiselect option pairing a stored value with a human-readable label. */
export interface FilterOption {
  /** Value sent in filter state and query params. */
  value: string;
  /** Text shown to the user in the dropdown. */
  label: string;
}

/**
 * Parsed representation of a `<trace-filter>` child element's attributes.
 *
 * One config per filter field. `<trace-visualizer>` collects these from
 * any `<trace-filter>` children at connect time, but they can also be
 * supplied programmatically via `TraceVisualizerConfig.filterConfigs`.
 *
 * The config drives both the rendered control (via {@link FilterFieldType})
 * and the matching logic in `filterSpans` (from `filter.ts`) / `buildQueryParams` (from `filter.ts`).
 */
export interface FilterFieldConfig {
  /** Dot-path or special key (e.g. `'spanName'`, `'serviceName'`, `'hasError'`, `'*'`) the filter matches on. */
  field: string;
  /** Human-readable label rendered next to the control. */
  label: string;
  /** Which UI control to render. */
  type: FilterFieldType;
  /** Whether the filter runs client-side or is pushed to the data source. */
  source: FilterSource;
  /** Whether the filter matches span-level fields or per-log event attributes. */
  target: FilterTarget;
  /** When `true`, fetch is gated until the user supplies a value. */
  required: boolean;
  /** Dropdown options. Use string[] for simple values or FilterOption[] for value/label pairs. */
  options: FilterOption[];
  /** How to populate dropdown options: 'static' (from attribute) or 'auto' (from data). */
  optionsSource: OptionsSource;
  /** Placeholder text for `text` and `datetime-range` inputs. Empty string when not set. */
  placeholder: string;
  /** Debounce delay in milliseconds applied to `text` filters. `0` disables debouncing. */
  debounce: number;
  /** Pixel width of the rendered control. `0` falls back to the default per type. */
  width: number;
  /** When true, the from/to values are auto-computed from data min/max span timestamps on load. */
  autoRange: boolean;
}

/**
 * Coerce a heterogeneous list of dropdown options into {@link FilterOption}s.
 *
 * Bare strings become an option whose `value` and `label` are both the
 * string. Objects missing a `label` fall back to using `value` as the
 * displayed label. Useful when the `<trace-filter options="...">`
 * attribute contains JSON that may have been authored either way.
 *
 * @param raw - Mixed array of strings and {@link FilterOption} objects.
 * @returns A new array of fully-formed {@link FilterOption}s.
 */
export function normalizeOptions(raw: (string | FilterOption)[]): FilterOption[] {
  return raw.map(item => {
    if (typeof item === 'string') {
      return { value: item, label: item };
    }
    return {
      value: String(item.value),
      label: String(item.label ?? item.value),
    };
  });
}

/**
 * Current value of a filter, shape determined by {@link FilterFieldType}.
 *
 * - `text`, `dropdown` → `string`
 * - `checkbox` → `boolean`
 * - `datetime-range` → `{ from?, to? }` ISO strings
 * - `multiselect` → `string[]`
 *
 * Empty values (empty string, empty array, `false`, range with neither
 * bound) mean the filter is inactive.
 */
export type FilterValue = string | boolean | { from?: string; to?: string } | string[];

/** Runtime pairing of a filter's static config and its current value. */
export interface Filter {
  /** Static definition of the filter (field, type, source, etc.). */
  config: FilterFieldConfig;
  /** Current value supplied by the user; shape matches `config.type`. */
  value: FilterValue;
}

/**
 * Callback that supplies trace data on behalf of `<trace-visualizer>`.
 *
 * Set via the `fetchCallback` setter. The component invokes the callback
 * whenever a refetch is needed: on connect, when the `data-url` attribute
 * changes, and whenever an external filter value changes (subject to
 * `autoFetch`).
 *
 * The callback may return either pre-built {@link TraceData} or a raw
 * `LogEntry[]`; in the latter case the component runs `transformLogs` (from `transform.ts`)
 * with the configured field mappings before rendering.
 *
 * @param url - The current `dataUrl` (may be `undefined` if not configured).
 * @param filters - Active external filters encoded by `buildQueryParams` (from `filter.ts`).
 * @returns A promise resolving to the data to render.
 */
export type FetchCallback = (url: string | undefined, filters: Record<string, string | string[]>) => Promise<TraceData | LogEntry[]>;

/**
 * Apply the built-in display defaults to a {@link TraceVisualizerConfig}.
 *
 * Falsy values in the input are replaced with the canonical defaults
 * (white background, 30 px span height, 5 px padding, 40% detail panel,
 * the built-in {@link SpanKind} colour scheme, etc.). Boolean fields use
 * strict `=== true` so that `undefined` falls back to `false`.
 *
 * @param config - The user-supplied config; any field may be omitted.
 * @returns A frozen-shape {@link DisplayConfig} safe to read in templates.
 */
export function resolveDisplayDefaults(config: TraceVisualizerConfig): DisplayConfig {
  return {
    width: config.width || 0,
    height: config.height || 0,
    backgroundColor: config.backgroundColor || '#ffffff',
    spanHeight: config.spanHeight || 30,
    spanPadding: config.spanPadding || 5,
    showLegend: config.showLegend === true,
    fullWidth: config.fullWidth === true,
    detailPanelWidth: config.detailPanelWidth || '40%',
    colorScheme: config.colorScheme || DEFAULT_COLOR_SCHEME,
  };
}
