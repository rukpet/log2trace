/**
 * Data flow step 3a: SpanIndex
 *
 * Immutable index of spans built from OTel TraceData. Pre-computes
 * millisecond timestamps and parent-child relationships once, so
 * downstream consumers (TraceViewModel, Template) never need BigInt
 * parsing or repeated tree walks.
 *
 * Replaces the old TraceTree.build() with a pure function buildSpanIndex().
 */

import {
  TraceData,
  ResourceSpans,
  Span,
} from './opentelemetry/trace.ts';
import { extractString } from './opentelemetry/common.ts';
import { nanoToMilli } from './time.ts';

/**
 * A span with pre-computed derived values for fast access.
 *
 * Wraps the original OTel {@link Span} and adds millisecond timestamps,
 * duration, and denormalized service name — values that would otherwise
 * be recomputed on every render/filter pass.
 */
export interface IndexedSpan {
  /** The original OTel span (unchanged). */
  readonly span: Span;
  /** Shortcut: span.spanId */
  readonly spanId: string;
  /** Shortcut: span.parentSpanId (undefined for roots). */
  readonly parentId: string | undefined;
  /** Service name from the owning ResourceSpans resource attributes. */
  readonly serviceName: string;
  /** Start time in milliseconds since Unix epoch. */
  readonly startMs: number;
  /** End time in milliseconds since Unix epoch. */
  readonly endMs: number;
  /** Duration in milliseconds (endMs - startMs). */
  readonly durationMs: number;
}

/**
 * Immutable index over a set of spans.
 *
 * All fields are pre-computed at construction time by {@link buildSpanIndex}.
 * The index is read-only; creating a filtered or modified view is the
 * responsibility of `TraceViewModel`.
 */
export interface SpanIndex {
  /** All indexed spans keyed by spanId for O(1) lookup. */
  readonly spans: ReadonlyMap<string, IndexedSpan>;
  /** Span IDs of root spans (no resolvable parent), sorted by startMs. */
  readonly roots: readonly string[];
  /** Parent spanId → ordered child spanIds. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Pre-computed bounding time range in milliseconds. */
  readonly timeRange: Readonly<{ min: number; max: number }>;
  /** Trace ID from the first root span (for display). */
  readonly traceId: string;
  /** Total number of spans. */
  readonly size: number;
}

/**
 * Build an immutable span index from OTel TraceData.
 *
 * Performs a single pass to collect spans, resolve parent-child links,
 * sort by start time, and compute the bounding time range. The result
 * is a frozen data structure suitable for repeated read access.
 *
 * @param traceData - OTel-shaped trace data from `transformLogs` or a backend.
 * @returns A new {@link SpanIndex}. Safe to call repeatedly on the same input.
 */
export function buildSpanIndex(traceData: TraceData): SpanIndex {
  const spans = new Map<string, IndexedSpan>();
  const childrenOf = new Map<string, string[]>();
  const rootIds: string[] = [];

  // Pass 1: Index all spans with pre-computed values
  for (const resourceSpan of traceData.resourceSpans) {
    const serviceName = extractServiceName(resourceSpan);

    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        const startMs = nanoToMilli(span.startTimeUnixNano);
        const endMs = nanoToMilli(span.endTimeUnixNano);

        spans.set(span.spanId, {
          span,
          spanId: span.spanId,
          parentId: span.parentSpanId || undefined,
          serviceName,
          startMs,
          endMs,
          durationMs: endMs - startMs,
        });
      }
    }
  }

  // Pass 2: Resolve parent-child links
  for (const indexed of spans.values()) {
    if (indexed.parentId && spans.has(indexed.parentId)) {
      const siblings = childrenOf.get(indexed.parentId);
      if (siblings) {
        siblings.push(indexed.spanId);
      } else {
        childrenOf.set(indexed.parentId, [indexed.spanId]);
      }
    } else {
      rootIds.push(indexed.spanId);
    }
  }

  // Sort children and roots by startMs
  const compareByStartMs = (a: string, b: string) => {
    return (spans.get(a)?.startMs ?? 0) - (spans.get(b)?.startMs ?? 0);
  };
  for (const children of childrenOf.values()) {
    children.sort(compareByStartMs);
  }
  rootIds.sort(compareByStartMs);

  // Compute time range
  const timeRange = computeTimeRange(spans);

  // Trace ID from first root
  const firstRoot = rootIds.length > 0 ? spans.get(rootIds[0]) : undefined;
  const traceId = firstRoot?.span.traceId ?? '';

  return {
    spans,
    roots: rootIds,
    childrenOf,
    timeRange,
    traceId,
    size: spans.size,
  };
}

function extractServiceName(resourceSpan: ResourceSpans): string {
  const attr = resourceSpan.resource.attributes.find(
    a => a.key === 'service.name'
  );
  return extractString(attr?.value) ?? 'unknown-service';
}

function computeTimeRange(spans: ReadonlyMap<string, IndexedSpan>): { min: number; max: number } {
  if (spans.size === 0) return { min: 0, max: 0 };

  let min = Infinity;
  let max = -Infinity;

  for (const indexed of spans.values()) {
    if (indexed.startMs < min) min = indexed.startMs;
    if (indexed.endMs > max) max = indexed.endMs;
  }

  return { min, max };
}
