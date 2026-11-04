/**
 * Small helpers for building OTel traces by hand in tests.
 *
 * Times are given in milliseconds after a fixed epoch instant and converted to
 * the nanosecond strings OTel uses, so sub-millisecond values can be written as decimals.
 */

import { SpanKind, type Event, type ResourceSpans, type Span, type TraceData } from '../../src/core/otel/trace.ts';
import type { KeyValue } from '../../src/core/otel/common.ts';

/** Time zero of the helpers, ns since the Unix epoch (2023-11-14T22:13:20Z). */
export const BASE_NS = 1_700_000_000_000_000_000n;

/** Nanosecond timestamp string for `ms` milliseconds after {@link BASE_NS}. */
export function nsAt(ms: number): string {
  return String(BASE_NS + BigInt(Math.round(ms * 1_000_000)));
}

export function kv(key: string, stringValue: string): KeyValue {
  return { key, value: { stringValue } };
}

export function event(name: string, ms: number, attributes: KeyValue[] = []): Event {
  return { timeUnixNano: nsAt(ms), name, attributes };
}

/** A span from `startMs` to `endMs`; `extra` overrides any field. */
export function span(
  id: string,
  parent: string | undefined,
  startMs: number,
  endMs: number,
  extra: Partial<Span> = {},
): Span {
  return {
    traceId: 'trace-1',
    spanId: id,
    parentSpanId: parent,
    name: id,
    kind: SpanKind.Internal,
    startTimeUnixNano: nsAt(startMs),
    endTimeUnixNano: nsAt(endMs),
    attributes: [],
    ...extra,
  };
}

/** One ResourceSpans per `[service, spans]` pair. */
export function trace(...groups: ReadonlyArray<readonly [service: string, spans: Span[]]>): TraceData {
  const resourceSpans: ResourceSpans[] = groups.map(([service, spans]) => ({
    resource: { attributes: [kv('service.name', service)] },
    scopeSpans: [{ scope: { name: 'test' }, spans }],
  }));
  return { resourceSpans };
}

/** A span written as a tree, for tests that care about the shape. */
export interface TreeNode {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly children?: readonly TreeNode[];
  /** Event times, ms after {@link BASE_NS}. */
  readonly events?: readonly number[];
  readonly status?: number;
  readonly kind?: SpanKind;
}

/** One trace, one service, from spans written as a tree (parents point at their children). */
export function treeTrace(roots: TreeNode | readonly TreeNode[], service = 'svc'): TraceData {
  const spans: Span[] = [];
  const add = (node: TreeNode, parent: string | undefined): void => {
    spans.push(span(node.id, parent, node.start, node.end, {
      events: node.events?.map((ms, k) => event(`${node.id}-e${k}`, ms)),
      status: node.status === undefined ? undefined : { code: node.status },
      kind: node.kind ?? SpanKind.Internal,
    }));
    for (const child of node.children ?? []) add(child, node.id);
  };
  for (const root of Array.isArray(roots) ? roots : [roots]) add(root as TreeNode, undefined);
  return trace([service, spans]);
}

/** Deterministic pseudo-random numbers in [0, 1): mulberry32. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
