/**
 * Core filtering logic.
 *
 * filterSpanIds() applies local filters and returns matching span IDs as a Set.
 * buildQueryParams() converts external filter values to URL query params.
 * areRequiredExternalFiltersFilled() gates fetch on required fields.
 */

import type { IndexedSpan } from './span-index.ts';
import type { Filter, FilterValue, FieldValue } from './config.ts';
import type { AnyValue } from './opentelemetry/common.ts';
import type { Event, Span } from './opentelemetry/trace.ts';
import { getField } from './transform.ts';

/** Internal shape used by filter matchers. */
type SpanEntry = { span: Span; serviceName: string };

// ---------------------------------------------------------------------------
// Local filtering
// ---------------------------------------------------------------------------

/**
 * Filter indexed spans and return matching span IDs.
 *
 * Works on {@link IndexedSpan} (from SpanIndex). Returns a Set of spanIds
 * that pass all active filters, suitable for passing to
 * `TraceViewModel.applyFilter()`.
 *
 * @param spans - Iterable of indexed spans to filter.
 * @param filters - Local filter state (config + current value).
 * @returns Set of spanIds that match all active filters, or null if no filters are active.
 */
export function filterSpanIds(spans: Iterable<IndexedSpan>, filters: Filter[]): Set<string> | null {
  const active = filters.filter(f => isActiveValue(f.value));
  if (active.length === 0) return null;

  const result = new Set<string>();
  for (const indexed of spans) {
    const entry: SpanEntry = { span: indexed.span, serviceName: indexed.serviceName };
    if (active.every(f => matchesFilter(entry, f))) {
      result.add(indexed.spanId);
    }
  }
  return result;
}

function isActiveValue(value: FilterValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return !!(value.from || value.to);
  return false;
}

function matchesFilter(entry: SpanEntry, filter: Filter): boolean {
  const { config, value } = filter;

  // Wildcard: search across all span fields + all event attributes
  if (config.field === '*') {
    return matchesWildcard(entry, config.type, value);
  }

  if (config.target === 'log') {
    return matchesLogFilter(entry, config.field, config.type, value);
  }

  return matchesSpanFilter(entry, config.field, config.type, value);
}

function matchesWildcard(entry: SpanEntry, type: string, value: FilterValue): boolean {
  if (type !== 'text' || typeof value !== 'string') return true;

  const needle = value.toLowerCase();
  const { span, serviceName } = entry;

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
}

function extractAttrString(value: AnyValue): string | undefined {
  if (value.stringValue !== undefined) return String(value.stringValue);
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.boolValue !== undefined) return String(value.boolValue);
  return undefined;
}

function matchesSpanFilter(
  entry: SpanEntry,
  field: string,
  type: string,
  value: FilterValue,
): boolean {
  const resolved = resolveSpanField(entry, field);

  switch (type) {
    case 'text':
      return typeof value === 'string' && typeof resolved === 'string'
        && resolved.toLowerCase().includes(value.toLowerCase());

    case 'dropdown':
      return typeof value === 'string' && String(resolved) === value;

    case 'checkbox':
      if (!value) return true;
      if (field === 'hasError') return entry.span.status?.code === 2;
      return !!resolved;

    case 'datetime-range': {
      if (typeof value !== 'object' || value === null) return true;
      const startMs = Number(BigInt(entry.span.startTimeUnixNano) / 1_000_000n);
      const { from, to } = value as { from?: string; to?: string };
      if (from) {
        const fromMs = new Date(from).getTime();
        if (startMs < fromMs) return false;
      }
      if (to) {
        const toMs = new Date(to).getTime();
        if (startMs > toMs) return false;
      }
      return true;
    }

    case 'multiselect':
      return Array.isArray(value) && value.includes(String(resolved));

    default:
      return true;
  }
}

function resolveSpanField(entry: SpanEntry, field: string): FieldValue {
  const { span, serviceName } = entry;

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

function matchesLogFilter(
  entry: SpanEntry,
  field: string,
  type: string,
  value: FilterValue,
): boolean {
  const events = entry.span.events;
  if (!events || events.length === 0) return false;

  // Span passes if ANY event matches
  return events.some(event => {
    const resolved = resolveEventField(event, field);

    switch (type) {
      case 'text':
        return typeof value === 'string' && typeof resolved === 'string'
          && resolved.toLowerCase().includes(value.toLowerCase());
      case 'dropdown':
        return typeof value === 'string' && String(resolved) === value;
      case 'checkbox':
        return value ? !!resolved : true;
      case 'multiselect':
        return Array.isArray(value) && value.includes(String(resolved));
      default:
        return true;
    }
  });
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
