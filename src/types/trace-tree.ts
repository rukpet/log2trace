import { Span } from './opentelemetry/trace.js';

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
    return Number(BigInt(nano) / 1_000_000n);
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
