/**
 * Core filtering logic.
 *
 * filterSpans() applies local filters to a FlatSpan[] array.
 * buildQueryParams() converts external filter values to URL query params.
 * areRequiredExternalFiltersFilled() gates fetch on required fields.
 */

import type { FlatSpan } from './trace-tree.ts';
import type { Filter, FilterValue, FieldValue } from './config.ts';
import type { AnyValue } from './opentelemetry/common.ts';
import type { Event } from './opentelemetry/trace.ts';
import { getField } from './transform.ts';

// ---------------------------------------------------------------------------
// Local filtering
// ---------------------------------------------------------------------------

/**
 * Filter a flattened span list by all active local filters.
 *
 * Filters are combined with AND logic: a span is kept only when every
 * active filter matches. A filter counts as "active" only when its value
 * is non-empty (e.g. a non-empty string, a checked checkbox, a non-empty
 * array, or a date range with at least one bound). Empty filters are
 * skipped entirely so that an unconfigured filter bar is a no-op.
 *
 * Only filters whose `config.source === 'local'` should be passed in;
 * external filters are applied server-side via {@link buildQueryParams}.
 *
 * @param spans - Flattened spans produced by {@link FlatSpan}.
 * @param filters - Local filter state (config + current value).
 * @returns A new array of spans that satisfy every active filter.
 */
export function filterSpans(spans: FlatSpan[], filters: Filter[]): FlatSpan[] {
  const active = filters.filter(f => isActiveValue(f.value));
  if (active.length === 0) return spans;

  return spans.filter(flatSpan => active.every(f => matchesFilter(flatSpan, f)));
}

function isActiveValue(value: FilterValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return !!(value.from || value.to);
  return false;
}

function matchesFilter(flatSpan: FlatSpan, filter: Filter): boolean {
  const { config, value } = filter;

  // Wildcard: search across all span fields + all event attributes
  if (config.field === '*') {
    return matchesWildcard(flatSpan, config.type, value);
  }

  if (config.target === 'log') {
    return matchesLogFilter(flatSpan, config.field, config.type, value);
  }

  return matchesSpanFilter(flatSpan, config.field, config.type, value);
}

function matchesWildcard(flatSpan: FlatSpan, type: string, value: FilterValue): boolean {
  if (type !== 'text' || typeof value !== 'string') return true;

  const needle = value.toLowerCase();
  const { span, serviceName } = flatSpan;

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
  flatSpan: FlatSpan,
  field: string,
  type: string,
  value: FilterValue,
): boolean {
  const resolved = resolveSpanField(flatSpan, field);

  switch (type) {
    case 'text':
      return typeof value === 'string' && typeof resolved === 'string'
        && resolved.toLowerCase().includes(value.toLowerCase());

    case 'dropdown':
      return typeof value === 'string' && String(resolved) === value;

    case 'checkbox':
      if (!value) return true;
      if (field === 'hasError') return flatSpan.span.status?.code === 2;
      return !!resolved;

    case 'datetime-range': {
      if (typeof value !== 'object' || value === null) return true;
      const startMs = Number(BigInt(flatSpan.span.startTimeUnixNano) / 1_000_000n);
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

function resolveSpanField(flatSpan: FlatSpan, field: string): FieldValue {
  const { span, serviceName } = flatSpan;

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
  flatSpan: FlatSpan,
  field: string,
  type: string,
  value: FilterValue,
): boolean {
  const events = flatSpan.span.events;
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
