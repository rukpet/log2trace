import {
  TraceData,
  ResourceSpans,
  Span,
} from './types/opentelemetry/trace.js';
import {
  KeyValue,
  AnyValue
} from './types/opentelemetry/common.js';
import { TraceTree } from './types/internal.js';

/**
 * Parse and process OpenTelemetry trace data for visualization
 */
export class TraceParser {
  /**
   * Parse trace data into a TraceTree of raw Spans with relationship maps
   */
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

    return { roots, childrenOf, serviceNameOf };
  }

  /**
   * Extract service name from resource attributes
   */
  private static extractServiceName(resourceSpan: ResourceSpans): string {
    const serviceNameAttr = resourceSpan.resource.attributes.find(
      attr => attr.key === 'service.name'
    );
    return this.extractAttributeValue(serviceNameAttr?.value) as string || 'unknown-service';
  }

  /**
   * Extract the actual value from an AnyValue
   */
  static extractAttributeValue(value?: AnyValue): any {
    if (!value) return undefined;
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.intValue !== undefined) return typeof value.intValue === 'string' ? parseInt(value.intValue) : value.intValue;
    if (value.doubleValue !== undefined) return value.doubleValue;
    if (value.boolValue !== undefined) return value.boolValue;
    if (value.arrayValue) {
      return value.arrayValue.values.map((v: AnyValue) => this.extractAttributeValue(v));
    }
    if (value.kvlistValue) {
      return this.convertAttributes(value.kvlistValue.values);
    }
    return undefined;
  }

  /**
   * Convert attributes array to key-value object
   */
  static convertAttributes(attributes: KeyValue[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const attr of attributes) {
      result[attr.key] = this.extractAttributeValue(attr.value);
    }
    return result;
  }

  /**
   * Convert nanosecond timestamp string to milliseconds
   */
  static nanoToMilli(nano: string): number {
    return Math.floor(parseInt(nano) / 1000000);
  }

  /**
   * Flatten the span tree into a list with computed levels, for rendering
   */
  static flattenSpans(tree: TraceTree): Array<{ span: Span; level: number }> {
    const result: Array<{ span: Span; level: number }> = [];

    const walk = (spans: Span[], level: number) => {
      for (const span of spans) {
        result.push({ span, level });
        const children = tree.childrenOf.get(span.spanId);
        if (children && children.length > 0) {
          walk(children, level + 1);
        }
      }
    };

    walk(tree.roots, 0);
    return result;
  }

  /**
   * Get the time range of all spans in milliseconds
   */
  static getTimeRange(tree: TraceTree): { min: number; max: number } {
    const flat = this.flattenSpans(tree);
    if (flat.length === 0) {
      return { min: 0, max: 0 };
    }

    let min = Infinity;
    let max = -Infinity;

    for (const { span } of flat) {
      const start = this.nanoToMilli(span.startTimeUnixNano);
      const end = this.nanoToMilli(span.endTimeUnixNano);
      if (start < min) min = start;
      if (end > max) max = end;
    }

    return { min, max };
  }
}
