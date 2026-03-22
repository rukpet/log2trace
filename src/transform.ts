/**
 * Data flow step 2: Log-to-Span Transformation
 *
 * Converts arbitrary application log arrays into OTel TraceData
 * using a TransformConfig that describes field mappings.
 */

import {
  TraceData,
  ResourceSpans,
  Span,
  SpanKind,
  Event,
} from './opentelemetry/trace.ts';
import { KeyValue } from './opentelemetry/common.ts';
import type { TransformConfig, SpanKindRule } from './config.ts';

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/** Traverse a dot-separated path on an unknown object. */
function getField(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** DJB2 hash → 32-bit unsigned integer. */
function djb2(str: string, seed: number = 5381): number {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Deterministic 32-hex-char trace ID (4 × djb2). */
function makeTraceId(input: string): string {
  return [0, 1, 2, 3]
    .map(s => djb2(input, 5381 + s).toString(16).padStart(8, '0'))
    .join('');
}

/** Deterministic 16-hex-char span ID (2 × djb2). */
function makeSpanId(input: string): string {
  return [0, 1]
    .map(s => djb2(input, 5381 + s).toString(16).padStart(8, '0'))
    .join('');
}

/** Convert a timestamp value to nanoseconds (bigint). */
function parseTimestampNano(value: unknown): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (value > 1e15) return BigInt(Math.trunc(value));          // already nanos
    if (value > 1e12) return BigInt(Math.trunc(value)) * 1_000n; // micros
    return BigInt(Math.trunc(value)) * 1_000_000n;                // millis
  }

  if (typeof value === 'string') {
    // Pure numeric string
    if (/^\d+$/.test(value)) {
      const n = BigInt(value);
      if (n > 1_000_000_000_000_000n) return n;        // nanos
      if (n > 1_000_000_000_000n) return n * 1_000n;   // micros
      return n * 1_000_000n;                             // millis
    }
    // ISO 8601 — if no timezone suffix, treat as UTC to avoid local-time skew
    const normalized = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value) ? value + 'Z' : value;
    const ms = Date.parse(normalized);
    if (!isNaN(ms)) return BigInt(ms) * 1_000_000n;

    // DD/MM/YYYY hh:mm:ss.SSS AM/PM  (e.g. "26/02/2026 05:37:21.148 AM")
    const dmyMatch = value.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(AM|PM)?$/i
    );
    if (dmyMatch) {
      const [, dd, mm, yyyy, hh, min, sec, frac, ampm] = dmyMatch;
      let hour = Number(hh);
      if (ampm) {
        const upper = ampm.toUpperCase();
        if (upper === 'PM' && hour < 12) hour += 12;
        if (upper === 'AM' && hour === 12) hour = 0;
      }
      const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${min}:${sec}.${(frac ?? '0').padEnd(3, '0').slice(0, 3)}Z`;
      const parsed = Date.parse(iso);
      if (!isNaN(parsed)) return BigInt(parsed) * 1_000_000n;
    }
  }

  return 0n;
}

/** Convert a log object into an OTel Event. */
function logToEvent(log: unknown, config: TransformConfig): Event {
  const ts = parseTimestampNano(getField(log, config.timestampField));
  const name = String(getField(log, config.spanNameField) ?? 'log');
  const attributes: KeyValue[] = [];

  // Flatten all log fields into event attributes
  flattenToAttributes(log, '', attributes);

  return { timeUnixNano: ts.toString(), name, attributes };
}

/** Recursively flatten an object into KeyValue attributes with dot-notation keys. */
function flattenToAttributes(obj: unknown, prefix: string, out: KeyValue[]): void {
  if (obj == null) return;
  if (typeof obj !== 'object') {
    const key = prefix || 'value';
    if (typeof obj === 'string') {
      out.push({ key, value: { stringValue: obj } });
    } else if (typeof obj === 'number') {
      if (Number.isInteger(obj)) out.push({ key, value: { intValue: obj } });
      else out.push({ key, value: { doubleValue: obj } });
    } else if (typeof obj === 'boolean') {
      out.push({ key, value: { boolValue: obj } });
    } else {
      out.push({ key, value: { stringValue: String(obj) } });
    }
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      flattenToAttributes(v, fullKey, out);
    } else if (v != null) {
      flattenToAttributes(v, fullKey, out);
    }
  }
}

/** Map a string or number to a SpanKind enum value. */
function parseSpanKind(value: string): SpanKind {
  const s = value.toUpperCase().replace('SPAN_KIND_', '');
  const map: Record<string, SpanKind> = {
    UNSPECIFIED: SpanKind.Unspecified,
    INTERNAL: SpanKind.Internal,
    SERVER: SpanKind.Server,
    CLIENT: SpanKind.Client,
    PRODUCER: SpanKind.Producer,
    CONSUMER: SpanKind.Consumer,
  };
  return map[s] ?? SpanKind.Unspecified;
}

/** Evaluate spanKindRules against a group of logs. First matching rule wins. */
function resolveSpanKind(logs: unknown[], rules: SpanKindRule[], fallback: SpanKind = SpanKind.Unspecified): SpanKind {
  for (const rule of rules) {
    const entries = Object.entries(rule.match);
    for (const log of logs) {
      if (entries.every(([path, val]) => String(getField(log, path) ?? '') === val)) {
        return parseSpanKind(rule.kind);
      }
    }
  }
  return fallback;
}

/** Pick the most common string from an array. */
function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function transformLogs(logs: unknown[], config: TransformConfig): TraceData {
  if (logs.length === 0) return { resourceSpans: [] };

  const groupFields: string[] = config.spanGroupFields
    ? (typeof config.spanGroupFields === 'string' ? [config.spanGroupFields] : config.spanGroupFields)
    : [];

  const lookupFields: string[] = config.parentSpanLookupFields
    ? (typeof config.parentSpanLookupFields === 'string' ? [config.parentSpanLookupFields] : config.parentSpanLookupFields)
    : [];

  // Phase 1: group logs by trace ID
  const traceGroups = new Map<string, unknown[]>();
  for (const log of logs) {
    const traceKey = String(getField(log, config.traceIdField) ?? 'unknown-trace');
    let group = traceGroups.get(traceKey);
    if (!group) { group = []; traceGroups.set(traceKey, group); }
    group.push(log);
  }

  // Accumulate spans keyed by service name
  const serviceSpans = new Map<string, Span[]>();

  for (const [traceKey, traceLogs] of traceGroups) {
    const traceId = makeTraceId(traceKey);

    // Phase 2: group logs into spans
    const spanGroups = new Map<string, unknown[]>();

    if (groupFields.length > 0) {
      for (const log of traceLogs) {
        const compositeKey = groupFields
          .map(f => String(getField(log, f) ?? ''))
          .join('\x00');
        let group = spanGroups.get(compositeKey);
        if (!group) { group = []; spanGroups.set(compositeKey, group); }
        group.push(log);
      }
    } else {
      // One log per span
      for (let i = 0; i < traceLogs.length; i++) {
        const log = traceLogs[i];
        const key = config.spanIdField
          ? String(getField(log, config.spanIdField) ?? i)
          : String(i);
        spanGroups.set(key, [log]);
      }
    }

    // Phase 3: build Span objects
    // When lookupFields are configured, collect metadata for Phase 3.5
    const spanEntries: { span: Span; keyParts: string[]; startNano: bigint; endNano: bigint; groupLogs: unknown[] }[] = [];

    for (const [compositeKey, groupLogs] of spanGroups) {
      const spanId = makeSpanId(traceKey + '\x00' + compositeKey);

      // Span name: most common value of spanNameField
      const names = groupLogs
        .map(l => String(getField(l, config.spanNameField) ?? ''))
        .filter(n => n !== '');
      const name = names.length > 0 ? mode(names) : '(unnamed)';

      // Timestamps
      let startNano = BigInt('9223372036854775807'); // max i64
      let endNano = 0n;
      for (const log of groupLogs) {
        const ts = parseTimestampNano(getField(log, config.timestampField));
        if (ts < startNano) startNano = ts;
        if (ts > endNano) endNano = ts;

        if (config.endTimeField) {
          const ets = parseTimestampNano(getField(log, config.endTimeField));
          if (ets > endNano) endNano = ets;
        }
      }
      // Ensure visible bar
      if (endNano <= startNano) endNano = startNano + 1_000_000n;

      // Parent span
      let parentSpanId: string | undefined;
      if (config.parentSpanIdField) {
        for (const log of groupLogs) {
          const pv = getField(log, config.parentSpanIdField);
          if (pv != null && String(pv) !== '') {
            parentSpanId = makeSpanId(traceKey + '\x00' + String(pv));
            break;
          }
        }
      }

      // Status: check if any log has a non-zero / truthy error code
      let hasError = false;
      if (config.statusCodeField) {
        for (const log of groupLogs) {
          const code = getField(log, config.statusCodeField);
          if (code != null && code !== 0 && code !== '0' && code !== '' && code !== false) {
            hasError = true;
            break;
          }
        }
      }

      // Convert each log into an OTel Event
      const events = groupLogs.map(log => logToEvent(log, config));

      const span: Span = {
        traceId,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        name,
        kind: resolveSpanKind(
          groupLogs,
          config.spanKindRules ?? [],
          config.defaultSpanKind ? parseSpanKind(config.defaultSpanKind) : SpanKind.Unspecified,
        ),
        startTimeUnixNano: startNano.toString(),
        endTimeUnixNano: endNano.toString(),
        status: hasError ? { code: 2 } : { code: 1 },
        attributes: [
          { key: 'log2trace.log_count', value: { intValue: groupLogs.length } },
        ],
        events,
      };

      // Service name → group into ResourceSpans later
      const serviceName = String(getField(groupLogs[0], config.serviceNameField) ?? 'unknown-service');
      let bucket = serviceSpans.get(serviceName);
      if (!bucket) { bucket = []; serviceSpans.set(serviceName, bucket); }
      bucket.push(span);

      if (lookupFields.length > 0) {
        spanEntries.push({
          span,
          keyParts: compositeKey.split('\x00'),
          startNano,
          endNano,
          groupLogs,
        });
      }
    }

    // Phase 4: resolve parentSpanLookupFields by partial composite-key match
    if (lookupFields.length > 0) {
      for (const entry of spanEntries) {
        // Skip if parentSpanIdField already resolved a parent
        if (entry.span.parentSpanId) continue;

        // Read lookup values from the first log that has them
        const lookupParts: string[] = [];
        let hasLookup = false;
        for (const log of entry.groupLogs) {
          const parts = lookupFields.map(f => {
            const v = getField(log, f);
            return v != null && String(v) !== '' ? String(v) : '';
          });
          if (parts.some(p => p !== '')) {
            lookupParts.push(...parts);
            hasLookup = true;
            break;
          }
        }
        if (!hasLookup) continue;

        // Skip self-references: if lookup parts match own key parts
        const ownPrefix = entry.keyParts.slice(0, lookupParts.length);
        if (ownPrefix.every((p, i) => p === lookupParts[i])) continue;

        // Find candidates whose composite key starts with lookupParts
        const candidates: typeof spanEntries = [];
        for (const other of spanEntries) {
          if (other === entry) continue;
          const prefix = other.keyParts.slice(0, lookupParts.length);
          if (prefix.length >= lookupParts.length &&
              prefix.every((p, i) => p === lookupParts[i])) {
            candidates.push(other);
          }
        }
        if (candidates.length === 0) continue;

        // Strategy 1: encompassing span (parent fully contains child)
        let parent: typeof spanEntries[0] | undefined;
        for (const c of candidates) {
          if (c.startNano <= entry.startNano && c.endNano >= entry.endNano) {
            // Prefer the tightest encompassing span
            if (!parent || (c.startNano >= parent.startNano && c.endNano <= parent.endNano)) {
              parent = c;
            }
          }
        }

        // Strategy 2 fallback: latest span that starts before current
        if (!parent) {
          for (const c of candidates) {
            if (c.startNano < entry.startNano) {
              if (!parent || c.startNano > parent.startNano) {
                parent = c;
              }
            }
          }
        }

        if (parent) {
          entry.span.parentSpanId = parent.span.spanId;
        }
      }
    }
  }

  // Phase 5: organize into ResourceSpans by service
  const resourceSpans: ResourceSpans[] = [];
  for (const [serviceName, spans] of serviceSpans) {
    resourceSpans.push({
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
      },
      scopeSpans: [{
        scope: { name: 'log2trace' },
        spans,
      }],
    });
  }

  return { resourceSpans };
}
