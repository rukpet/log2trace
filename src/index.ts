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

// Export the Web Component
export { TraceVisualizerElement } from './component.js';

// Export public types (OpenTelemetry standard types)
export * from './opentelemetry/common.js';
export * from './opentelemetry/resource.js';
export * from './opentelemetry/trace.js';
// Auto-register the component when imported
import './component.js';
