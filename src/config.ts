/**
 * Configuration of the `<trace-visualizer>` element: the headless transform
 * mappings plus the options that only matter for display. Every field maps 1:1
 * to a kebab-case HTML attribute.
 *
 * Transitional: this file belongs to the legacy element and moves to `element/`
 * together with it. The transform and filter types it builds on live in the
 * headless core (`core/config.ts`).
 */

import { SpanKind } from './core/otel/trace.ts';
import type { FilterFieldConfig, TransformConfig } from './core/config.ts';

/**
 * Unified runtime configuration for the `<trace-visualizer>` Web Component.
 *
 * Every field maps 1:1 to a kebab-case HTML attribute on the custom
 * element, so the same options can be set declaratively from markup or
 * imperatively via the `config` setter. The interface deliberately
 * mixes two concerns:
 *
 * - **Transform fields** (`traceIdField`, `spanGroupFields`,
 *   `spanNameField`, `serviceNameField`, `timestampField`, etc.), inherited
 *   from {@link TransformConfig}, tell the component how to map raw log
 *   records onto the OTel span model. They are required only when feeding
 *   the component logs rather than pre-built trace data.
 * - **Display fields** (`width`, `height`, `colorScheme`, `showLegend`,
 *   `detailPanelWidth`, etc.) control rendering. Defaults are applied
 *   by {@link resolveDisplayDefaults}.
 *
 * All fields are optional so a single shared type can describe both the
 * declarative attribute surface and the resolved runtime config.
 */
export interface TraceVisualizerConfig extends Partial<TransformConfig> {
  /** URL to fetch trace/log data from */
  dataUrl?: string;

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
