/**
 * Data flow step 3a: SpanIndex
 *
 * Immutable index of spans built from OTel TraceData. Pre-computes
 * millisecond timestamps and parent-child relationships once, so
 * downstream consumers never need BigInt parsing or repeated tree walks.
 *
 * Two views of the same data: the object form (`spans`, `roots`, `childrenOf`),
 * convenient for lookups by span id, and the columnar {@link SpanTable}
 * (`table`, `ordered`), which per-row loops should use.
 *
 * Replaces the old TraceTree.build() with a pure function buildSpanIndex().
 */

import type { TraceData, ResourceSpans, Span } from './otel/trace.ts';
import { extractString } from './otel/common.ts';
import { bigNanoToMilli, parseNano } from './time.ts';
import { buildSpanTable, type SpanTable } from './span-table.ts';

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
  /** Start time in whole milliseconds since Unix epoch (sub-millisecond part dropped). */
  readonly startMs: number;
  /** End time in whole milliseconds since Unix epoch (sub-millisecond part dropped). */
  readonly endMs: number;
  /** Duration in milliseconds (endMs - startMs). */
  readonly durationMs: number;
  /** Row of this span in {@link SpanIndex.table} and {@link SpanIndex.ordered}. */
  readonly idx: number;
}

/**
 * Immutable index over a set of spans.
 *
 * All fields are pre-computed at construction time by {@link buildSpanIndex}.
 * The index is read-only; per-view state (what is collapsed, selected or
 * filtered) lives in the trace store, not here.
 */
export interface SpanIndex {
  /** All indexed spans keyed by spanId for O(1) lookup. */
  readonly spans: ReadonlyMap<string, IndexedSpan>;
  /** Span IDs of root spans (no resolvable parent), sorted by start time. */
  readonly roots: readonly string[];
  /** Parent spanId → child spanIds, sorted by start time. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Pre-computed bounding time range in whole milliseconds since the Unix epoch. */
  readonly timeRange: Readonly<{ min: number; max: number }>;
  /** Trace ID from the first root span (for display). */
  readonly traceId: string;
  /** Total number of spans. */
  readonly size: number;
  /** All spans in depth-first pre-order, so `ordered[i].idx === i`. */
  readonly ordered: readonly IndexedSpan[];
  /** The same spans as parallel typed arrays, with exact sub-millisecond times and the tree as row arithmetic. */
  readonly table: SpanTable;
}

/**
 * Build an immutable span index from OTel TraceData.
 *
 * Performs a single pass to collect spans, resolve parent-child links,
 * order them depth-first by start time, and compute the bounding time range.
 * The result is a frozen data structure suitable for repeated read access.
 *
 * A span id that occurs twice keeps the later span. A span whose parent is not
 * in the data is a root, and so is the earliest member of a parent cycle.
 *
 * @param traceData - OTel-shaped trace data from `transformLogs` or a backend.
 * @returns A new {@link SpanIndex}. Safe to call repeatedly on the same input.
 * @throws Error when a span or event time is not a nanosecond timestamp.
 */
export function buildSpanIndex(traceData: TraceData): SpanIndex {
  // Pass 1: collect spans in input order. A repeated id replaces the earlier span but keeps its slot.
  const slotOf = new Map<string, number>();
  const found: Span[] = [];
  const serviceNames: string[] = [];
  for (const resourceSpan of traceData.resourceSpans) {
    const serviceName = extractServiceName(resourceSpan);
    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        const slot = slotOf.get(span.spanId);
        if (slot === undefined) {
          slotOf.set(span.spanId, found.length);
          found.push(span);
          serviceNames.push(serviceName);
        } else {
          found[slot] = span;
          serviceNames[slot] = serviceName;
        }
      }
    }
  }

  // Pass 2: parse times once and resolve parents to slots.
  const count = found.length;
  const startNs = new BigInt64Array(count);
  const endNs = new BigInt64Array(count);
  const parentSlot = new Int32Array(count);
  for (let slot = 0; slot < count; slot++) {
    const span = found[slot];
    startNs[slot] = parseNano(span.startTimeUnixNano, `start time of span ${span.spanId}`);
    endNs[slot] = parseNano(span.endTimeUnixNano, `end time of span ${span.spanId}`);
    const parent = span.parentSpanId ? slotOf.get(span.parentSpanId) : undefined;
    parentSlot[slot] = parent === undefined ? -1 : parent;
  }

  // Pass 3: order the spans depth-first into the table, then wrap each one.
  const { table, idxOfSlot } = buildSpanTable({ spans: found, serviceNames, parentSlot, startNs, endNs });

  const spans = new Map<string, IndexedSpan>();
  const ordered = new Array<IndexedSpan>(count);
  let min = Infinity;
  let max = -Infinity;
  for (let slot = 0; slot < count; slot++) {
    const span = found[slot];
    const startMs = bigNanoToMilli(startNs[slot]);
    const endMs = bigNanoToMilli(endNs[slot]);
    const indexed: IndexedSpan = {
      span,
      spanId: span.spanId,
      parentId: span.parentSpanId || undefined,
      serviceName: serviceNames[slot],
      startMs,
      endMs,
      durationMs: endMs - startMs,
      idx: idxOfSlot[slot],
    };
    spans.set(span.spanId, indexed);
    ordered[indexed.idx] = indexed;
    if (startMs < min) min = startMs;
    if (endMs > max) max = endMs;
  }

  // Roots and children come out in depth-first order, which is start order among siblings.
  const rootIds: string[] = [];
  const childrenOf = new Map<string, string[]>();
  for (let row = 0; row < count; row++) {
    const parentRow = table.parent[row];
    if (parentRow < 0) {
      rootIds.push(table.ids[row]);
      continue;
    }
    const siblings = childrenOf.get(table.ids[parentRow]);
    if (siblings) {
      siblings.push(table.ids[row]);
    } else {
      childrenOf.set(table.ids[parentRow], [table.ids[row]]);
    }
  }

  const traceId = rootIds.length > 0 ? ordered[0].span.traceId : '';

  return {
    spans,
    roots: rootIds,
    childrenOf,
    timeRange: count === 0 ? { min: 0, max: 0 } : { min, max },
    traceId,
    size: count,
    ordered,
    table,
  };
}

function extractServiceName(resourceSpan: ResourceSpans): string {
  const attr = resourceSpan.resource.attributes.find(
    a => a.key === 'service.name'
  );
  return extractString(attr?.value) ?? 'unknown-service';
}
