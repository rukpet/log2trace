/**
 * log2trace-ui/core: the headless half of the library.
 *
 * Everything that works on trace data without drawing it: turning log records
 * into OTel spans, indexing spans, filtering, the shared view state (store and
 * selectors) and the text a UI shows about a span. Nothing here touches the DOM
 * or any browser global, so it loads in Node, in a Worker and in a test.
 *
 * ```ts
 * import { transformLogs, buildSpanIndex, matchSpans } from 'log2trace-ui/core';
 * ```
 *
 * The package root re-exports all of this next to the `<trace-visualizer>` element.
 */

// Log → trace → index
export { transformLogs, getField } from './transform.ts';
export { buildSpanIndex } from './span-index.ts';
export type { SpanIndex, IndexedSpan } from './span-index.ts';
export type { SpanTable } from './span-table.ts';
export { SpanMask, EMPTY_SPAN_SET, spanSetOf } from './span-set.ts';
export type { SpanId, SpanSet } from './span-set.ts';

// Configuration and filtering
export { normalizeOptions } from './config.ts';
export type {
  TransformConfig, SpanKindRule, LogEntry, FieldValue,
  FilterFieldConfig, FilterFieldType, FilterSource, FilterTarget, FilterOption, FilterValue, OptionsSource, Filter,
  FetchCallback,
} from './config.ts';
export {
  filterSpanIds, matchSpans, compileFilters, buildQueryParams, areRequiredExternalFiltersFilled,
} from './filter.ts';
export type { SpanMatcher } from './filter.ts';

// Shared view state
export { createTraceStore } from './store.ts';
export type { TraceStore, TraceStoreOptions, FlushScheduler, MutationOptions, TargetOptions } from './store.ts';
export { Slice, touches, API_ORIGIN, MIXED_ORIGIN } from './state.ts';
export type { TraceState, Target, ChangeSet, Origin, DataPhase, TimeWindow } from './state.ts';
export { defineSelector, matchSummary, selectedSpan, hoveredSpan } from './selectors.ts';
export type { Selector, MatchSummary } from './selectors.ts';

// What to show about a span
export { describeSpan } from './describe.ts';
export type { InfoModel, InfoSection, InfoGroup, InfoRow, InfoStatus, InfoLevel } from './describe.ts';
export { formatDuration, formatOffset, formatAbsoluteTime, extractAnyValue } from './format.ts';

// OpenTelemetry trace types
export { SpanKind, spanKindName } from './otel/trace.ts';
export type { TraceData, ResourceSpans, ScopeSpans, Span, Event, Link, Status } from './otel/trace.ts';
export type { AnyValue, KeyValue, ArrayValue, KeyValueList, InstrumentationScope } from './otel/common.ts';
