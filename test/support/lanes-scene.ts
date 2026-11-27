/**
 * A ready-made lanes state for model tests: a trace, its lane model, a layout, a stack of lanes and a camera.
 */

import { SpanMask, buildSpanIndex, type SpanIndex } from '../../src/core/index.ts';
import { createCamera, type Camera1D } from '../../src/kit/geometry/camera1d.ts';
import { buildLaneModel, orderLanes, type LaneModel, type LaneOrder } from '../../src/views/lanes/model/lanes.ts';
import {
  DEFAULT_METRICS,
  LaneMode,
  computeLayout,
  stackLanes,
  type LaneStack,
  type LanesLayout,
  type LanesMetrics,
} from '../../src/views/lanes/model/layout.ts';
import { LanesFramePlan, SummarySource, buildLanesPlan, selectionMasks, type PlanInput } from '../../src/views/lanes/model/plan.ts';
import { kv, random, span, trace } from './trace-builder.ts';
import { SpanKind, type Span, type TraceData } from '../../src/core/otel/trace.ts';

export interface LanesScene {
  readonly index: SpanIndex;
  readonly model: LaneModel;
  readonly layout: LanesLayout;
  readonly order: Int32Array;
  readonly stack: LaneStack;
  readonly summaries: SummarySource;
  readonly matched: SpanMask | null;
  /** Shows the whole trace over the whole plot. */
  readonly camera: Camera1D;
}

export interface SceneOptions {
  readonly width?: number;
  readonly height?: number;
  readonly metrics?: Partial<LanesMetrics>;
  readonly peers?: boolean;
  readonly order?: LaneOrder;
  /** Mode of every lane (by name); the rest is capped. */
  readonly modes?: Readonly<Record<string, LaneMode>>;
  readonly matched?: readonly string[];
}

/** Index a trace and lay it out in a view (1000 × 600 by default: a plot of 756 px with the default 220 px gutter and 24 px padding). */
export function scene(data: TraceData, options: SceneOptions = {}): LanesScene {
  const index = buildSpanIndex(data);
  const model = buildLaneModel(index);
  const layout = computeLayout({ ...DEFAULT_METRICS, ...options.metrics }, options.width ?? 1000, options.height ?? 600);
  const order = options.order === undefined || options.order === 'start' ? model.order : orderLanes(model, options.order);
  const modes = new Uint8Array(model.laneCount).fill(LaneMode.Capped);
  for (const [name, mode] of Object.entries(options.modes ?? {})) modes[model.names.indexOf(name)] = mode;
  return {
    index,
    model,
    layout,
    order,
    stack: stackLanes(model, layout, order, options.peers ?? true, modes),
    summaries: new SummarySource(model),
    matched: options.matched ? SpanMask.of(index, options.matched) : null,
    camera: createCamera(index.table.extentMs, layout.plotWidth),
  };
}

/** Text of 6 px per character, cut with an ellipsis. */
export function fitText(text: string, maxWidth: number): string {
  if (text.length * 6 <= maxWidth) return text;
  const room = Math.floor(maxWidth / 6) - 1;
  return room >= 1 ? `${text.slice(0, room)}…` : '';
}

/** The input of a plan for a scene; `extra` overrides any field. */
export function planInput(s: LanesScene, extra: Partial<PlanInput> = {}): PlanInput {
  return {
    model: s.model,
    layout: s.layout,
    stack: s.stack,
    camera: s.camera,
    scrollTop: 0,
    matched: s.matched,
    selection: null,
    hovered: null,
    summaries: s.summaries,
    fitText,
    ...extra,
  };
}

/** Build a plan for a scene. */
export function planOf(s: LanesScene, extra: Partial<PlanInput> = {}, plan = new LanesFramePlan()): LanesFramePlan {
  buildLanesPlan(plan, planInput(s, extra));
  return plan;
}

/** The selection masks of spans by id. */
export function selectionOf(s: LanesScene, ids: readonly string[]) {
  return selectionMasks(s.index, ids.map((id) => s.index.table.ids.indexOf(id)));
}

/** `n` parentless spans of one service that all run at once, one millisecond apart: a lane of `n` levels. */
export function concurrentSpans(prefix: string, n: number, start = 0, length = 500): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < n; i++) spans.push(span(`${prefix}${i}`, undefined, start + i, start + i + length));
  return spans;
}

/**
 * A trace of three services and one peer:
 * - `web` has a root `w` [0, 1000] and its client call `w-call` [10, 990];
 * - `api` has `a` [20, 980] with 20 workers `p0 … p19` that all run at once, so its lane has 21 levels;
 * - `a-db` [30, 60] and `a-db2` [40, 90] call `postgres`, an uninstrumented peer;
 * - `bg` has a few short spans at the end, after a long idle gap.
 */
export function wideTrace(): TraceData {
  const workers = Array.from({ length: 20 }, (_, i) => span(`p${i}`, 'a', 100 + i, 400 + i));
  return trace(
    ['web', [
      span('w', undefined, 0, 1000, { kind: SpanKind.Server }),
      span('w-call', 'w', 10, 990, { kind: SpanKind.Client }),
    ]],
    ['api', [
      span('a', 'w-call', 20, 980, { kind: SpanKind.Server }),
      ...workers,
      span('a-db', 'a', 30, 60, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')] }),
      span('a-db2', 'a', 40, 90, { kind: SpanKind.Client, attributes: [kv('db.system', 'postgres')], status: { code: 2 } }),
    ]],
    ['bg', [
      span('b1', undefined, 900, 910),
      span('b2', undefined, 950, 960, { status: { code: 2 } }),
    ]],
  );
}

/** `n` spans over six services with heavy concurrency, nesting and database calls, deterministic. */
export function largeTrace(n: number): TraceData {
  const services = ['api-gateway', 'order-svc', 'payment-svc', 'inventory-svc', 'worker-pool', 'cache-svc'];
  const bySvc = services.map(() => [] as Span[]);
  const baseNs = 1_700_000_000_000_000_000n;
  const rnd = random(7);

  for (let i = 0; i < n; i++) {
    const svcIdx = i % services.length;
    const parentIdx = i === 0 ? -1 : Math.floor(rnd() * i);
    const startNs = baseNs + BigInt(Math.floor(rnd() * 60_000_000_000));
    const durNs = BigInt(Math.floor(rnd() * 200_000_000));
    const call = i % 9 === 0;
    bySvc[svcIdx].push({
      traceId: 'perf-trace',
      spanId: `s-${i}`,
      parentSpanId: parentIdx >= 0 ? `s-${parentIdx}` : undefined,
      name: `op-${i % 20}`,
      kind: call ? SpanKind.Client : SpanKind.Internal,
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(startNs + durNs),
      attributes: call ? [{ key: 'db.system', value: { stringValue: i % 2 === 0 ? 'postgresql' : 'redis' } }] : [],
      status: { code: i % 97 === 0 ? 2 : 1 },
    });
  }

  return {
    resourceSpans: services.map((name, idx) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: name } }] },
      scopeSpans: [{ scope: { name: 'perf' }, spans: bySvc[idx] }],
    })),
  };
}
