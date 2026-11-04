/**
 * A ready-made waterfall state for model tests: a trace, its rows, a layout and a camera.
 */

import { buildSpanIndex, SpanMask, type SpanIndex, type TraceData } from '../../src/core.ts';
import { createCamera, type Camera1D } from '../../src/kit/geometry/camera1d.ts';
import { computeLayout, DEFAULT_METRICS, type WaterfallLayout, type WaterfallMetrics } from '../../src/views/waterfall/model/layout.ts';
import { projectRows, type RowProjection } from '../../src/views/waterfall/model/rows.ts';

export interface Scene {
  readonly index: SpanIndex;
  readonly projection: RowProjection;
  readonly collapsed: SpanMask | null;
  readonly matched: SpanMask | null;
  readonly layout: WaterfallLayout;
  /** Shows the whole trace over the whole plot. */
  readonly camera: Camera1D;
}

export interface SceneOptions {
  readonly width?: number;
  readonly height?: number;
  readonly metrics?: WaterfallMetrics;
  readonly collapsed?: readonly string[];
  readonly matched?: readonly string[];
}

/** Index a trace and lay it out in a view (1000 × 600 by default). */
export function scene(data: TraceData, options: SceneOptions = {}): Scene {
  const index = buildSpanIndex(data);
  const collapsed = options.collapsed ? SpanMask.of(index, options.collapsed) : null;
  const matched = options.matched ? SpanMask.of(index, options.matched) : null;
  const maxDepth = index.table.depth.reduce((deepest, depth) => Math.max(deepest, depth), 0);
  const layout = computeLayout(options.metrics ?? DEFAULT_METRICS, options.width ?? 1000, options.height ?? 600, maxDepth);
  return {
    index,
    projection: projectRows(index, collapsed, matched),
    collapsed,
    matched,
    layout,
    camera: createCamera(index.table.extentMs, layout.plotWidth),
  };
}

/** Measures a text as 6 px per character, so label placement is easy to predict. */
export function monospace(text: string): number {
  return text.length * 6;
}
