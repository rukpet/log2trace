/**
 * describeSpan: what to tell the user about a span, as data.
 *
 * The result is an {@link InfoModel}: a title, a status and sections of
 * label/value rows. Nothing in it is markup, so the tooltip, the detail panel
 * and any view-specific popup can render it their own way (and a test can
 * read it). The brief level fits a tooltip; the full level is the detail panel.
 *
 * Headless: no DOM, no browser globals.
 */

import { spanKindName } from './otel/trace.ts';
import type { SpanIndex } from './span-index.ts';
import type { SpanId } from './span-set.ts';
import { extractAnyValue, formatAbsoluteTime, formatDuration, formatOffset } from './format.ts';

/** Outcome of a span, as the status badge shows it. */
export type InfoStatus = 'ok' | 'error' | 'unset';

/** A label and its value. */
export type InfoRow = readonly [label: string, value: string];

/** Rows under a heading of their own, such as one event of a span. */
export interface InfoGroup {
  readonly title: string;
  /** Text next to the title, such as when an event happened. */
  readonly aside?: string;
  readonly rows: readonly InfoRow[];
}

/** One block of an {@link InfoModel}. */
export interface InfoSection {
  readonly title: string;
  /** A count to show next to the title. */
  readonly badge?: number;
  readonly rows?: readonly InfoRow[];
  readonly groups?: readonly InfoGroup[];
}

/** A description of something on screen, ready to render. */
export interface InfoModel {
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: InfoStatus;
  readonly sections: readonly InfoSection[];
}

/** How much to describe: `brief` for a tooltip, `full` for the detail panel. */
export type InfoLevel = 'brief' | 'full';

/** Attribute keys with this prefix are the library's own bookkeeping and are not shown. */
const INTERNAL_ATTRIBUTE_PREFIX = 'log2trace.';

const STATUS_LABELS = ['Unset', 'OK', 'Error'] as const;
const STATUS_KINDS = ['unset', 'ok', 'error'] as const;

/**
 * Describe one span.
 *
 * The full model has an Overview section (service, status, kind, duration, start and end
 * time, ids), an Attributes section (omitted when there are none) and an Events section
 * (one group per event, in time order, with its offset from the span start).
 * The brief model has only the quick facts.
 *
 * @param index - The trace the span belongs to.
 * @param id - Id of the span.
 * @param level - How much to include; defaults to `full`.
 * @returns The description, or `null` when the span is not in the trace.
 */
export function describeSpan(index: SpanIndex, id: SpanId, level: InfoLevel = 'full'): InfoModel | null {
  const indexed = index.spans.get(id);
  if (!indexed) return null;

  const { span, serviceName, idx } = indexed;
  const { table } = index;
  const statusCode = span.status?.code ?? 0;
  const statusKind = STATUS_KINDS[statusCode] ?? 'unset';
  const statusLabel = STATUS_LABELS[statusCode] ?? 'Unset';
  const kindLabel = spanKindName(span.kind) || 'Unknown';
  const duration = formatDuration(table.end[idx] - table.start[idx]);
  const message = span.status?.message;
  const eventCount = table.evOff[idx + 1] - table.evOff[idx];

  if (level === 'brief') {
    const rows: InfoRow[] = [
      ['Duration', duration],
      ['Kind', kindLabel],
      ['Span ID', span.spanId],
    ];
    if (message) rows.push(['Message', message]);
    if (eventCount > 0) rows.push(['Events', String(eventCount)]);
    return {
      title: span.name,
      subtitle: serviceName,
      status: statusKind,
      sections: [{ title: 'Overview', rows }],
    };
  }

  const overview: InfoRow[] = [
    ['Service', serviceName],
    ['Status', statusLabel],
  ];
  if (message) overview.push(['Message', message]);
  overview.push(
    ['Kind', kindLabel],
    ['Duration', duration],
    ['Start', formatAbsoluteTime(span.startTimeUnixNano)],
    ['End', formatAbsoluteTime(span.endTimeUnixNano)],
  );
  const logCount = span.attributes?.find(a => a.key === 'log2trace.log_count');
  if (logCount) overview.push(['Log Count', extractAnyValue(logCount.value)]);
  overview.push(['Trace ID', span.traceId], ['Span ID', span.spanId]);
  if (span.parentSpanId) overview.push(['Parent ID', span.parentSpanId]);

  const sections: InfoSection[] = [{ title: 'Overview', rows: overview }];

  const attributes = (span.attributes ?? []).filter(a => !a.key.startsWith(INTERNAL_ATTRIBUTE_PREFIX));
  if (attributes.length > 0) {
    sections.push({
      title: 'Attributes',
      badge: attributes.length,
      rows: attributes.map((a): InfoRow => [a.key, extractAnyValue(a.value)]),
    });
  }

  if (eventCount > 0 && span.events) {
    const groups: InfoGroup[] = [];
    for (let k = table.evOff[idx]; k < table.evOff[idx + 1]; k++) {
      const event = span.events[table.evSrc[k]];
      groups.push({
        title: event.name,
        aside: formatOffset(table.evT[k] - table.start[idx]),
        rows: (event.attributes ?? []).map((a): InfoRow => [a.key, extractAnyValue(a.value)]),
      });
    }
    sections.push({ title: 'Events', badge: eventCount, groups });
  }

  return { title: span.name, subtitle: serviceName, status: statusKind, sections };
}
