/**
 * log2trace-ui — embeddable trace visualization Web Component.
 *
 * Importing this module registers three custom elements as a side
 * effect: `<trace-visualizer>` (the main waterfall), `<trace-filter>`
 * (declarative filter inputs), and `<span-kind-rule>` (declarative
 * span-kind classification rules). After import the component can be
 * used directly from HTML, or driven programmatically via the exports
 * below.
 *
 * @example Declarative usage
 * ```html
 * <script type="module" src="./log2trace.js"></script>
 * <trace-visualizer data-url="./trace.json"></trace-visualizer>
 * ```
 *
 * @example Programmatic usage with raw logs
 * ```ts
 * import 'log2trace-ui';
 * import { transformLogs } from 'log2trace-ui';
 *
 * const el = document.querySelector('trace-visualizer');
 * el.traceData = transformLogs(myLogs, {
 *   traceIdField: 'text.BTMID',
 *   spanNameField: 'text.Action',
 *   serviceNameField: 'text.MachineName',
 *   timestampField: 'text.Timestamp',
 * });
 * ```
 *
 * @packageDocumentation
 */

// Auto-register the component, <trace-filter>, and <span-kind-rule> elements when imported
import './component.ts';

export { transformLogs, getField } from './transform.ts';
export { TraceTree } from './trace-tree.ts';
export { Template } from './template.ts';
export { filterSpans } from './filter.ts';
export { resolveDisplayDefaults, normalizeOptions } from './config.ts';
export type { TraceVisualizerConfig, TransformConfig, DisplayConfig, FilterFieldConfig, FilterOption, OptionsSource, Filter, FetchCallback, LogEntry, FieldValue } from './config.ts';
