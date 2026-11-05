/**
 * log2trace-ui — embeddable trace visualization Web Component.
 *
 * Importing this module registers three custom elements as a side
 * effect: `<trace-visualizer>` (the trace view), `<trace-filter>`
 * (declarative filter inputs), and `<span-kind-rule>` (declarative
 * span-kind classification rules). After import the component can be
 * used directly from HTML, or driven programmatically via the exports
 * below, which include everything the headless `log2trace-ui/core` entry offers.
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

// Auto-register <trace-visualizer>, <trace-filter> and <span-kind-rule> when imported
import './element/carriers.ts';
import './element/trace-visualizer.ts';

export * from './core.ts';
export { TraceVisualizerElement } from './element/trace-visualizer.ts';
export type { LogDataInput, SelectSpanOptions } from './element/trace-visualizer.ts';
export type { TraceVisualizerConfig } from './element/config.ts';

// The view contract: register a view of your own next to the waterfall, the inspector and the flame graph
export { getView, listViews, registerView } from './kit/view.ts';
export type { RendererKind, TraceView, ViewContext, ViewDefinition, ViewHit } from './kit/view.ts';
export { choiceOption, flagOption, numberOption, type ViewOptions } from './kit/view-options.ts';
export type { ViewCommand } from './kit/commands.ts';
