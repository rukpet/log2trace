import {
  TraceData,
  ResourceSpans,
  Span,
  SpanKind
} from './types/opentelemetry/trace.js';
import {
  KeyValue,
  AnyValue
} from './types/opentelemetry/common.js';
import {
  ProcessedSpan,
  ProcessedEvent,
} from './types/internal.js';

/**
 * Parse and process OpenTelemetry trace data for visualization
 */
export class TraceParser {
  /**
   * Parse trace data and extract all spans with their relationships
   */
  static parse(traceData: TraceData): ProcessedSpan[] {
    const spanMap = new Map<string, ProcessedSpan>();
    const rootSpans: ProcessedSpan[] = [];

    // First pass: collect all spans
    for (const resourceSpan of traceData.resourceSpans) {
      const serviceName = this.extractServiceName(resourceSpan);

      for (const scopeSpan of resourceSpan.scopeSpans) {
        for (const span of scopeSpan.spans) {
          const processedSpan = this.processSpan(span, serviceName);
          spanMap.set(span.spanId, processedSpan);
        }
      }
    }

    // Second pass: build tree structure
    for (const span of spanMap.values()) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        const parent = spanMap.get(span.parentSpanId)!;
        parent.children.push(span);
      } else {
        rootSpans.push(span);
      }
    }

    // Calculate levels for each span
    this.calculateLevels(rootSpans, 0);

    // Sort children by start time
    this.sortSpansByStartTime(rootSpans);

    return rootSpans;
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
   * Process a single span
   */
  private static processSpan(span: Span, serviceName: string): ProcessedSpan {
    const startTime = this.nanoToMilli(span.startTimeUnixNano);
    const endTime = this.nanoToMilli(span.endTimeUnixNano);

    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      serviceName,
      kind: span.kind as SpanKind,
      startTime,
      endTime,
      duration: endTime - startTime,
      attributes: this.convertAttributes(span.attributes),
      events: this.processEvents(span.events || []),
      status: span.status || { code: 0 },
      level: 0,
      children: []
    };
  }

  /**
   * Process events in a span
   */
  private static processEvents(events: any[]): ProcessedEvent[] {
    return events.map(event => ({
      time: this.nanoToMilli(event.timeUnixNano),
      name: event.name,
      attributes: this.convertAttributes(event.attributes || [])
    }));
  }

  /**
   * Convert attributes array to key-value object
   */
  private static convertAttributes(attributes: KeyValue[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const attr of attributes) {
      result[attr.key] = this.extractAttributeValue(attr.value);
    }
    return result;
  }

  /**
   * Extract the actual value from an AnyValue
   */
  private static extractAttributeValue(value?: AnyValue): any {
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
   * Convert nanosecond timestamp to milliseconds
   */
  private static nanoToMilli(nano: string): number {
    return Math.floor(parseInt(nano) / 1000000);
  }

  /**
   * Calculate depth levels for spans in the tree
   */
  private static calculateLevels(spans: ProcessedSpan[], level: number): void {
    for (const span of spans) {
      span.level = level;
      if (span.children.length > 0) {
        this.calculateLevels(span.children, level + 1);
      }
    }
  }

  /**
   * Sort spans and their children by start time
   */
  private static sortSpansByStartTime(spans: ProcessedSpan[]): void {
    spans.sort((a, b) => a.startTime - b.startTime);
    for (const span of spans) {
      if (span.children.length > 0) {
        this.sortSpansByStartTime(span.children);
      }
    }
  }

  /**
   * Flatten the span tree into a list for rendering
   */
  static flattenSpans(spans: ProcessedSpan[]): ProcessedSpan[] {
    const result: ProcessedSpan[] = [];
    for (const span of spans) {
      result.push(span);
      if (span.children.length > 0) {
        result.push(...this.flattenSpans(span.children));
      }
    }
    return result;
  }

  /**
   * Get the time range of all spans
   */
  static getTimeRange(spans: ProcessedSpan[]): { min: number; max: number } {
    const flatSpans = this.flattenSpans(spans);
    if (flatSpans.length === 0) {
      return { min: 0, max: 0 };
    }

    const startTimes = flatSpans.map(s => s.startTime);
    const endTimes = flatSpans.map(s => s.endTime);

    return {
      min: Math.min(...startTimes),
      max: Math.max(...endTimes)
    };
  }
}
