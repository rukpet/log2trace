import {
  TraceData,
  ResourceSpans,
  Span,
} from './types/opentelemetry/trace.js';
import {
  extractString,
} from './types/opentelemetry/common.js';
import { TraceTree } from './types/trace-tree.js';

/**
 * Parse OpenTelemetry trace data into a TraceTree
 */
export class TraceParser {
  static parse(traceData: TraceData): TraceTree {
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
    for (const children of childrenOf.values()) {
      children.sort((a, b) =>
        parseInt(a.startTimeUnixNano) - parseInt(b.startTimeUnixNano)
      );
    }
    roots.sort((a, b) =>
      parseInt(a.startTimeUnixNano) - parseInt(b.startTimeUnixNano)
    );

    return new TraceTree(roots, childrenOf, serviceNameOf);
  }

  private static extractServiceName(resourceSpan: ResourceSpans): string {
    const serviceNameAttr = resourceSpan.resource.attributes.find(
      attr => attr.key === 'service.name'
    );
    return extractString(serviceNameAttr?.value) ?? 'unknown-service';
  }
}
