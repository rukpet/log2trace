import {
  TraceData,
  ResourceSpans,
  Span,
} from './opentelemetry/trace.js';
import {
  extractString,
} from './opentelemetry/common.js';
import { nanoToMilli } from './time.js';

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

  static build(traceData: TraceData): TraceTree {
    const spanMap = new Map<string, Span>();
    const childrenOf = new Map<string, Span[]>();
    const serviceNameOf = new Map<string, string>();
    const roots: Span[] = [];

    // Collect all spans and build service name map
    for (const resourceSpan of traceData.resourceSpans) {
      const serviceName = this.extractServiceName(resourceSpan);

      for (const scopeSpan of resourceSpan.scopeSpans) {
        for (const span of scopeSpan.spans) {
          spanMap.set(span.spanId, span);
          serviceNameOf.set(span.spanId, serviceName);
        }
      }
    }

    // Build tree structure
    for (const span of spanMap.values()) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        const siblings = childrenOf.get(span.parentSpanId) || [];
        siblings.push(span);
        childrenOf.set(span.parentSpanId, siblings);
      } else {
        roots.push(span);
      }
    }

    // Sort children by start time
    const compareByStartTime = (a: Span, b: Span) => {
      const diff = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    };
    for (const children of childrenOf.values()) {
      children.sort(compareByStartTime);
    }
    roots.sort(compareByStartTime);

    return new TraceTree(roots, childrenOf, serviceNameOf);
  }

  private static extractServiceName(resourceSpan: ResourceSpans): string {
    const serviceNameAttr = resourceSpan.resource.attributes.find(
      attr => attr.key === 'service.name'
    );
    return extractString(serviceNameAttr?.value) ?? 'unknown-service';
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
      const start = nanoToMilli(span.startTimeUnixNano);
      const end = nanoToMilli(span.endTimeUnixNano);
      if (start < min) min = start;
      if (end > max) max = end;
    }

    return { min, max };
  }
}
