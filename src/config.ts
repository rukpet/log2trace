/**
 * Single unified configuration for the <trace-visualizer> component.
 * Every field maps 1:1 to a kebab-case HTML attribute.
 * Covers both log-to-trace transformation and visual display.
 */

import { SpanKind } from './opentelemetry/trace.ts';

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

/** A rule mapping log field values to a SpanKind. */
export interface SpanKindRule {
  /** Dot-path → value pairs; all must match for the rule to apply. */
  match: Record<string, string>;
  /** SpanKind name: "Server", "Client", "Internal", "Producer", "Consumer", "Unspecified". */
  kind: string;
}

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

export type FilterFieldType = 'text' | 'dropdown' | 'datetime' | 'checkbox';
export type FilterSource = 'external' | 'local';
export type FilterTarget = 'span' | 'log';

/** Parsed representation of a <trace-filter> element's attributes. */
export interface FilterFieldConfig {
  field: string;
  label: string;
  type: FilterFieldType;
  source: FilterSource;
  target: FilterTarget;
  required: boolean;
  options: string[];
  placeholder: string;
  debounce: number;
  width?: number;
}

export type FilterValue = string | boolean | { from?: string; to?: string };

/** Runtime state of a single active local filter. */
export interface LocalFilter {
  config: FilterFieldConfig;
  value: FilterValue;
}

/** Runtime state of a single active external filter. */
export interface ExternalFilter {
  config: FilterFieldConfig;
  value: FilterValue;
}

/** Callback for custom data fetching with external filters. */
export type FetchCallback = (url: string | undefined, filters: Record<string, string>) => Promise<unknown>;

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
