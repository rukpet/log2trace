/**
 * Configuration shared by the headless core: how raw log records become spans
 * ({@link TransformConfig}) and how spans are filtered ({@link FilterFieldConfig},
 * {@link Filter}). Nothing here knows about rendering; the options of the element
 * itself (colours, sizes, the data URL) live next to the element.
 */

import type { TraceData } from './otel/trace.ts';

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

// ---------------------------------------------------------------------------
// Log → trace transform
// ---------------------------------------------------------------------------

/**
 * Field mappings that tell `transformLogs` how to turn raw log records into
 * OTel spans. Every value is a dot-path into the log record (e.g. `"text.BTMID"`).
 *
 * The four required fields are the minimum for a trace; the optional ones add
 * grouping, hierarchy, status and span-kind classification. The same names, in
 * kebab-case, are the HTML attributes of `<trace-visualizer>`.
 */
export interface TransformConfig {
  /** Dot-path to the field that groups logs into traces (e.g. "text.BTMID") */
  traceIdField: string;

  /** Dot-path to the field used as the span name/label (e.g. "text.Action") */
  spanNameField: string;

  /** Dot-path to the field that determines the service/resource row (e.g. "text.MachineName") */
  serviceNameField: string;

  /** Dot-path to the timestamp field (ISO 8601 or epoch-ms) */
  timestampField: string;

  /** Dot-path(s) that group logs into spans within a trace.
   *  If omitted, each log becomes its own span. */
  spanGroupFields?: string | string[];

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
 * - `local` — applied client-side by `filterSpanIds` / `matchSpans` (from `filter.ts`)
 *   against the already-loaded spans.
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
 * supplied programmatically through its `filterConfigs` option.
 *
 * The config drives both the rendered control (via {@link FilterFieldType})
 * and the matching logic in `filterSpanIds` / `matchSpans` / `buildQueryParams`
 * (from `filter.ts`).
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
