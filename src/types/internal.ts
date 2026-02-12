/**
 * Internal types for log2trace library
 * These types are used internally and not part of the public API
 */

import { Status, SpanKind } from './opentelemetry/trace.js';

/**
 * Processed span for visualization
 */
export interface ProcessedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  kind: SpanKind;
  startTime: number; // milliseconds
  endTime: number; // milliseconds
  duration: number; // milliseconds
  attributes: Record<string, any>;
  events: ProcessedEvent[];
  status: Status;
  level: number; // depth in the trace tree
  children: ProcessedSpan[];
}

export interface ProcessedEvent {
  time: number; // milliseconds
  name: string;
  attributes: Record<string, any>;
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
