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

// Export utility classes for advanced usage
export { TraceParser } from './parser.js';
export { TraceRenderer } from './renderer.js';

// Export public types (OpenTelemetry standard types)
export * from './types/opentelemetry/common.js';
export * from './types/opentelemetry/resource.js';
export * from './types/opentelemetry/trace.js';
export * from './types/opentelemetry/logs.js';

// Auto-register the component when imported
import './component.js';
