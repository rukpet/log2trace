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

// Auto-register the component when imported
import './component.ts';

export { transformLogs } from './transform.ts';
export { TraceTree } from './trace-tree.ts';
export { Template } from './template.ts';
export { resolveDisplayDefaults } from './config.ts';
export type { TraceVisualizerConfig, TransformConfig, DisplayConfig } from './config.ts';