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

/** Filter spans by all active local filters (AND logic). */
export function filterSpans(spans: FlatSpan[], filters: Filter[]): FlatSpan[] {
  const active = filters.filter(f => isActiveValue(f.value));
  if (active.length === 0) return spans;

  return spans.filter(flatSpan => active.every(f => matchesFilter(flatSpan, f)));
}

function isActiveValue(value: FilterValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
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

    case 'datetime': {
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

/** Check whether all required external filters have a value. */
export function areRequiredExternalFiltersFilled(filters: Filter[]): boolean {
  return filters
    .filter(f => f.config.required)
    .every(f => isActiveValue(f.value));
}

/** Convert external filter values to a flat Record for URL query params. */
export function buildQueryParams(filters: Filter[]): Record<string, string> {
  const params: Record<string, string> = {};

  for (const { config, value } of filters) {
    if (!isActiveValue(value)) continue;

    if (config.type === 'datetime' && typeof value === 'object' && value !== null) {
      const { from, to } = value as { from?: string; to?: string };
      if (from) params[`${config.field}From`] = from;
      if (to) params[`${config.field}To`] = to;
    } else if (config.type === 'checkbox') {
      if (value) params[config.field] = 'true';
    } else if (typeof value === 'string') {
      params[config.field] = value;
    }
  }

  return params;
}
