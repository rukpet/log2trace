/**
 * Data flow step 3: TraceTree
 *
 * Converts flat OTel TraceData into a parent-child span tree.
 * build() indexes spans, resolves parent links, sorts by start time.
 * flatten() produces the ordered list that Template uses for rendering.
 * getTimeRange() computes the min/max timestamps for the timeline axis.
 */

import {
  TraceData,
  ResourceSpans,
  Span,
} from './opentelemetry/trace.ts';
import {
  extractString,
} from './opentelemetry/common.ts';
import { nanoToMilli } from './time.ts';

/**
 * A single span paired with its rendering metadata.
 *
 * Produced by {@link TraceTree.flatten}. `level` is the depth from the
 * root span (root = 0) and is used to indent the span label and bar.
 * `serviceName` is denormalized from the parent `ResourceSpans` so that
 * each row can be coloured/labelled without re-walking the tree.
 */
export interface FlatSpan {
  /** The original OTel span. */
  span: Span;
  /** Depth in the parent-child tree; root spans are at level 0. */
  level: number;
  /** Service name resolved from the owning `ResourceSpans` resource attributes. */
  serviceName: string;
}

/**
 * Tree structure for organizing raw OTel Spans for visualization.
 * Spans are kept as-is; relationships and metadata are stored in lookup maps.
 */
export class TraceTree {
  /**
   * Construct a tree directly from precomputed lookup maps.
   *
   * Most callers should use {@link TraceTree.build} instead. The public
   * constructor exists so trees can be assembled in tests or by callers
   * that already have the indexed structure.
   *
   * @param roots - Spans with no resolvable parent, sorted by start time.
   * @param childrenOf - `parentSpanId` → ordered list of child spans.
   * @param serviceNameOf - `spanId` → owning service name.
   */
  constructor(
    public readonly roots: Span[],
    public readonly childrenOf: Map<string, Span[]>,
    public readonly serviceNameOf: Map<string, string>,
  ) {}

  /**
   * Index a flat {@link TraceData} payload into a parent-child tree.
   *
   * Spans whose `parentSpanId` does not resolve to a known span in the
   * payload are treated as roots, so dangling references do not silently
   * disappear. Children at every level are sorted by `startTimeUnixNano`
   * to keep timeline ordering stable.
   *
   * @param traceData - OTel-shaped trace data, typically produced by
   *   `transformLogs` (from `transform.ts`) or fetched from a backend.
   * @returns A new `TraceTree`. Safe to call repeatedly on the same input.
   *
   * @example
   * ```ts
   * const tree = TraceTree.build(traceData);
   * for (const { span, level } of tree.flatten()) {
   *   console.log('  '.repeat(level) + span.name);
   * }
   * ```
   */
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

  /**
   * Walk the tree depth-first and return one {@link FlatSpan} per span.
   *
   * Order matches the visual top-to-bottom order of the waterfall: each
   * root is visited followed by all of its descendants (also depth-first)
   * before moving on to the next root.
   *
   * @returns The complete list of spans annotated with depth and service name.
   */
  flatten(): FlatSpan[] {
    const result: FlatSpan[] = [];

    const walk = (spans: Span[], level: number) => {
      for (const span of spans) {
        const serviceName = this.serviceNameOf.get(span.spanId) || 'unknown-service';
        result.push({ span, level, serviceName });
        const children = this.childrenOf.get(span.spanId);
        if (children && children.length > 0) {
          walk(children, level + 1);
        }
      }
    };

    walk(this.roots, 0);
    return result;
  }

  /**
   * Compute the bounding time range across every span in the tree.
   *
   * Both bounds are returned in milliseconds since the Unix epoch,
   * suitable for `Date` construction and pixel-offset math. An empty
   * tree returns `{ min: 0, max: 0 }`.
   *
   * @returns The earliest start and latest end timestamp in the tree.
   */
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
