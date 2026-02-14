/**
 * Internal types for log2trace library
 * These types are used internally and not part of the public API
 */

import { Span, SpanKind } from './opentelemetry/trace.js';

/**
 * Tree structure for organizing raw OTel Spans for visualization.
 * Spans are kept as-is; relationships and metadata are stored in lookup maps.
 */
export class TraceTree {
  constructor(
    public readonly roots: Span[],
    public readonly childrenOf: Map<string, Span[]>,
    public readonly serviceNameOf: Map<string, string>,
  ) {}

  static nanoToMilli(nano: string): number {
    return Math.floor(parseInt(nano) / 1000000);
  }

  flatten(): Array<{ span: Span; level: number }> {
    const result: Array<{ span: Span; level: number }> = [];

    const walk = (spans: Span[], level: number) => {
      for (const span of spans) {
        result.push({ span, level });
        const children = this.childrenOf.get(span.spanId);
        if (children && children.length > 0) {
          walk(children, level + 1);
        }
      }
    };

    walk(this.roots, 0);
    return result;
  }

  getTimeRange(): { min: number; max: number } {
    const flat = this.flatten();
    if (flat.length === 0) {
      return { min: 0, max: 0 };
    }

    let min = Infinity;
    let max = -Infinity;

    for (const { span } of flat) {
      const start = TraceTree.nanoToMilli(span.startTimeUnixNano);
      const end = TraceTree.nanoToMilli(span.endTimeUnixNano);
      if (start < min) min = start;
      if (end > max) max = end;
    }

    return { min, max };
  }
}

const DEFAULT_COLOR_SCHEME: Record<string, string> = {
  [SpanKind.Internal]: '#4A90E2',
  [SpanKind.Server]: '#7ED321',
  [SpanKind.Client]: '#F5A623',
  [SpanKind.Producer]: '#BD10E0',
  [SpanKind.Consumer]: '#50E3C2',
  [SpanKind.Unspecified]: '#9013FE',
};

export class VisualizationConfig {
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: string;
  readonly spanHeight: number;
  readonly spanPadding: number;
  readonly showEvents: boolean;
  readonly showAttributes: boolean;
  readonly colorScheme: Record<string, string>;

  constructor(overrides: Partial<VisualizationConfig> = {}) {
    this.width = overrides.width || 1200;
    this.height = overrides.height || 600;
    this.backgroundColor = overrides.backgroundColor || '#ffffff';
    this.spanHeight = overrides.spanHeight || 30;
    this.spanPadding = overrides.spanPadding || 5;
    this.showEvents = overrides.showEvents !== false;
    this.showAttributes = overrides.showAttributes !== false;
    this.colorScheme = overrides.colorScheme || DEFAULT_COLOR_SCHEME;
  }
}
