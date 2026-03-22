/**
 * Single unified configuration for the <trace-visualizer> component.
 * Every field maps 1:1 to a kebab-case HTML attribute.
 * Covers both log-to-trace transformation and visual display.
 */

import { SpanKind } from './opentelemetry/trace.ts';

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

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
  [SpanKind.Internal]: '#4A90E2',
  [SpanKind.Server]: '#7ED321',
  [SpanKind.Client]: '#F5A623',
  [SpanKind.Producer]: '#BD10E0',
  [SpanKind.Consumer]: '#50E3C2',
  [SpanKind.Unspecified]: '#9013FE',
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
