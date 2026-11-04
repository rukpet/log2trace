/**
 * Core filtering logic.
 *
 * compileFilters() turns the active local filters into one predicate over
 * {@link IndexedSpan}s, doing the per-filter work (lower-casing a needle,
 * parsing a date bound) once instead of once per span.
 * matchSpans() runs it over a {@link SpanIndex} and returns the matches as a
 * {@link SpanMask} for the store; filterSpanIds() returns them as a Set of ids.
 * buildQueryParams() converts external filter values to URL query params.
 * areRequiredExternalFiltersFilled() gates fetch on required fields.
 */

import type { IndexedSpan, SpanIndex } from './span-index.ts';
import { SpanMask } from './span-set.ts';
import type { Filter, FilterValue, FieldValue } from './config.ts';
import type { AnyValue } from './otel/common.ts';
import type { Event } from './otel/trace.ts';
import { getField } from './transform.ts';

/** Decides whether one span passes a filter (or all of them). */
export type SpanMatcher = (indexed: IndexedSpan) => boolean;

/** Decides whether a field value passes a filter. */
type ValueMatcher = (resolved: FieldValue) => boolean;

const ANY_SPAN: SpanMatcher = () => true;
const ANY_VALUE: ValueMatcher = () => true;
const NO_VALUE: ValueMatcher = () => false;

// ---------------------------------------------------------------------------
// Local filtering
// ---------------------------------------------------------------------------

/**
 * Compile the active filters into a single predicate.
 *
 * A span passes when it passes every active filter. Filters with an empty
 * value are inactive and skipped. Use the result to filter in chunks (to keep
 * the main thread responsive) or on any subset of spans.
 *
 * @param filters - Local filter state (config + current value).
 * @returns The combined predicate, or `null` when no filter is active.
 */
export function compileFilters(filters: readonly Filter[]): SpanMatcher | null {
  const matchers = filters.filter(f => isActiveValue(f.value)).map(compileFilter);
  if (matchers.length === 0) return null;
  if (matchers.length === 1) return matchers[0];
  return indexed => {
    for (const matches of matchers) {
      if (!matches(indexed)) return false;
    }
    return true;
  };
}

/**
 * Filter indexed spans and return the matching span IDs.
 *
 * Works on {@link IndexedSpan} (from SpanIndex). Returns a Set of spanIds
 * that pass all active filters.
 *
 * @param spans - Iterable of indexed spans to filter.
 * @param filters - Local filter state (config + current value).
 * @returns Set of spanIds that match all active filters, or null if no filters are active.
 */
export function filterSpanIds(spans: Iterable<IndexedSpan>, filters: Filter[]): Set<string> | null {
  const matches = compileFilters(filters);
  if (matches === null) return null;

  const result = new Set<string>();
  for (const indexed of spans) {
    if (matches(indexed)) result.add(indexed.spanId);
  }
  return result;
}

/**
 * Filter every span of an index and return the matches as a mask over its rows,
 * ready for `TraceStore.setMatched`.
 *
 * @param index - The spans to filter.
 * @param filters - Local filter state (config + current value).
 * @returns The matching spans, or `null` when no filter is active.
 */
export function matchSpans(index: SpanIndex, filters: readonly Filter[]): SpanMask | null {
  const matches = compileFilters(filters);
  if (matches === null) return null;

  const { ordered } = index;
  const bits = new Uint8Array(ordered.length);
  let count = 0;
  for (let row = 0; row < ordered.length; row++) {
    if (matches(ordered[row])) {
      bits[row] = 1;
      count++;
    }
  }
  return new SpanMask(index, bits, count);
}

function isActiveValue(value: FilterValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return !!(value.from || value.to);
  return false;
}

function compileFilter(filter: Filter): SpanMatcher {
  const { config, value } = filter;

  // Wildcard: search across all span fields + all event attributes
  if (config.field === '*') {
    return compileWildcard(config.type, value);
  }

  if (config.target === 'log') {
    return compileLogFilter(config.field, config.type, value);
  }

  return compileSpanFilter(config.field, config.type, value);
}

function compileWildcard(type: string, value: FilterValue): SpanMatcher {
  if (type !== 'text' || typeof value !== 'string') return ANY_SPAN;

  const needle = value.toLowerCase();
  return ({ span, serviceName }) => {
    // Check span-level fields
    if (span.name.toLowerCase().includes(needle)) return true;
    if (serviceName.toLowerCase().includes(needle)) return true;
    if (span.spanId.toLowerCase().includes(needle)) return true;
    if (span.traceId.toLowerCase().includes(needle)) return true;

    // Check span attributes
    if (span.attributes) {
      for (const attr of span.attributes) {
        const val = extractAttrString(attr.value);
        if (val && val.toLowerCase().includes(needle)) return true;
      }
    }

    // Check all event attributes
    if (span.events) {
      for (const event of span.events) {
        if (event.name.toLowerCase().includes(needle)) return true;
        if (event.attributes) {
          for (const attr of event.attributes) {
            const val = extractAttrString(attr.value);
            if (val && val.toLowerCase().includes(needle)) return true;
          }
        }
      }
    }

    return false;
  };
}

function extractAttrString(value: AnyValue): string | undefined {
  if (value.stringValue !== undefined) return String(value.stringValue);
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  return undefined;
}

function compileSpanFilter(field: string, type: string, value: FilterValue): SpanMatcher {
  switch (type) {
    case 'text':
    case 'dropdown':
    case 'multiselect': {
      const matchesValue = compileValueMatcher(type, value);
      return indexed => matchesValue(resolveSpanField(indexed, field));
    }

    case 'checkbox':
      if (!value) return ANY_SPAN;
      if (field === 'hasError') return ({ span }) => span.status?.code === 2;
      return indexed => !!resolveSpanField(indexed, field);

    case 'datetime-range': {
      if (typeof value !== 'object' || value === null) return ANY_SPAN;
      const { from, to } = value as { from?: string; to?: string };
      // An unparsable bound is NaN, and every comparison with NaN is false, so it filters nothing.
      const fromMs = from ? new Date(from).getTime() : undefined;
      const toMs = to ? new Date(to).getTime() : undefined;
      return ({ startMs }) => {
        if (fromMs !== undefined && startMs < fromMs) return false;
        if (toMs !== undefined && startMs > toMs) return false;
        return true;
      };
    }

    default:
      return ANY_SPAN;
  }
}

/** The text / dropdown / multiselect rules, shared by span and log filters. */
function compileValueMatcher(type: string, value: FilterValue): ValueMatcher {
  switch (type) {
    case 'text': {
      if (typeof value !== 'string') return NO_VALUE;
      const needle = value.toLowerCase();
      return resolved => typeof resolved === 'string' && resolved.toLowerCase().includes(needle);
    }
    case 'dropdown':
      return typeof value === 'string' ? resolved => String(resolved) === value : NO_VALUE;
    case 'multiselect':
      return Array.isArray(value) ? resolved => value.includes(String(resolved)) : NO_VALUE;
    default:
      return ANY_VALUE;
  }
}

function resolveSpanField({ span, serviceName }: IndexedSpan, field: string): FieldValue {
  switch (field) {
    case 'spanName':
    case 'name':
      return span.name;
    case 'serviceName':
      return serviceName;
    case 'hasError':
      return span.status?.code === 2;
    case 'spanKind':
    case 'kind':
      return String(span.kind);
    default:
      // Try span attributes
      if (span.attributes) {
        const attr = span.attributes.find(a => a.key === field);
        if (attr) {
          if (attr.value.stringValue !== undefined) return attr.value.stringValue;
          if (attr.value.intValue !== undefined) return String(attr.value.intValue);
          if (attr.value.boolValue !== undefined) return String(attr.value.boolValue);
        }
      }
      return getField(span, field);
  }
}

function compileLogFilter(field: string, type: string, value: FilterValue): SpanMatcher {
  const matchesValue: ValueMatcher = type === 'checkbox'
    ? resolved => (value ? !!resolved : true)
    : compileValueMatcher(type, value);

  // Span passes if ANY event matches
  return ({ span }) => {
    const events = span.events;
    if (!events || events.length === 0) return false;
    return events.some(event => matchesValue(resolveEventField(event, field)));
  };
}

function resolveEventField(event: Event, field: string): FieldValue {
  // Try direct attribute match
  if (event.attributes) {
    const attr = event.attributes.find(a => a.key === field);
    if (attr) {
      if (attr.value.stringValue !== undefined) return attr.value.stringValue;
      if (attr.value.intValue !== undefined) return String(attr.value.intValue);
      if (attr.value.boolValue !== undefined) return String(attr.value.boolValue);
    }
  }

  // Try dot-path traversal on the event object
  return getField(event, field);
}

// ---------------------------------------------------------------------------
// External filtering helpers
// ---------------------------------------------------------------------------

/**
 * Check whether all required external filters have a non-empty value.
 *
 * Used to gate fetching: when external filters are marked `required`,
 * the component must not issue a request until the user has supplied
 * values for each of them.
 *
 * @param filters - The full filter set; only those with `config.required` are inspected.
 * @returns `true` when every required filter is filled, or when there are no required filters.
 */
export function areRequiredExternalFiltersFilled(filters: Filter[]): boolean {
  return filters
    .filter(f => f.config.required)
    .every(f => isActiveValue(f.value));
}

/**
 * Convert active external filter values into a flat record suitable for URL query parameters.
 *
 * Encoding rules per filter type:
 * - `datetime-range` becomes two keys, `<field>From` and `<field>To`,
 *   each only present when its bound is set.
 * - `checkbox` is emitted only when truthy, with the literal string `"true"`.
 * - `multiselect` is emitted as a `string[]` so callers can serialize it
 *   however their backend expects (repeated keys, comma-joined, etc.).
 * - All other types fall through as a single string under `config.field`.
 *
 * Inactive filters (empty value) are skipped.
 *
 * @param filters - The full filter set; only those with non-empty values are encoded.
 * @returns A record keyed by query-parameter name.
 */
export function buildQueryParams(filters: Filter[]): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};

  for (const { config, value } of filters) {
    if (!isActiveValue(value)) continue;

    if (config.type === 'datetime-range' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { from, to } = value as { from?: string; to?: string };
      if (from) params[`${config.field}From`] = from;
      if (to) params[`${config.field}To`] = to;
    } else if (config.type === 'checkbox') {
      if (value) params[config.field] = 'true';
    } else if (config.type === 'multiselect' && Array.isArray(value)) {
      params[config.field] = value;
    } else if (typeof value === 'string') {
      params[config.field] = value;
    }
  }

  return params;
}
