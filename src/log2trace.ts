/**
 * Log2Trace Viewer - Web Component based trace visualization library
 * 
 * Usage:
 *   <trace-visualizer data-url="./trace.json"></trace-visualizer>
 * 
 * Or programmatically:
 *   const viewer = document.querySelector('trace-visualizer');
 *   viewer.traceData = myTraceData;
 */

// Auto-register the component, <trace-filter>, and <span-kind-rule> elements when imported
import './component.ts';

export { transformLogs, getField } from './transform.ts';
export { TraceTree } from './trace-tree.ts';
export { Template } from './template.ts';
export { filterSpans } from './filter.ts';
export { resolveDisplayDefaults } from './config.ts';
export type { TraceVisualizerConfig, TransformConfig, DisplayConfig, FilterFieldConfig, LocalFilter, ExternalFilter, FetchCallback } from './config.ts';