/**
 * Internal types for log2trace library
 * These types are used internally and not part of the public API
 */

import { Span } from './opentelemetry/trace.js';

/**
 * Tree structure for organizing raw OTel Spans for visualization.
 * Spans are kept as-is; relationships and metadata are stored in lookup maps.
 */
export interface TraceTree {
  roots: Span[];
  childrenOf: Map<string, Span[]>;
  serviceNameOf: Map<string, string>;
}

export interface VisualizationConfig {
  width?: number;
  height?: number;
  backgroundColor?: string;
  spanHeight?: number;
  spanPadding?: number;
  showEvents?: boolean;
  showAttributes?: boolean;
  colorScheme?: Record<string, string>;
}
