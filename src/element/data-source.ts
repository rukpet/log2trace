/**
 * Data source: how the element gets a trace.
 *
 * Three ways in: a URL (the sample file of OTel trace data, or raw logs when the transform is
 * configured), a `fetchCallback` the page supplies, and external filters, whose values travel as
 * query parameters or as the callback's argument. Whatever arrives is turned into a span index.
 *
 * No DOM here, and `fetch` can be replaced, so the whole path is tested in Node.
 */

import type { FetchCallback, LogEntry, TransformConfig } from '../core/config.ts';
import type { TraceData } from '../core/otel/trace.ts';
import { buildSpanIndex, type SpanIndex } from '../core/span-index.ts';
import { transformLogs } from '../core/transform.ts';
import { measure } from '../core/instrumentation.ts';
import { isTransformReady, type TraceVisualizerConfig } from './config.ts';

/** The part of `fetch` the source uses. */
export type FetchLike = (url: string) => Promise<{ readonly ok: boolean; readonly statusText: string; json(): Promise<unknown> }>;

function defaultFetch(url: string): ReturnType<FetchLike> {
  return globalThis.fetch(url);
}

/** Fetch a JSON document. */
export async function fetchJson<T>(url: string, fetchImpl: FetchLike = defaultFetch): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to load: ${response.statusText}`);
  return (await response.json()) as T;
}

/** The URL with filter parameters appended; an array value becomes one parameter per item. */
export function urlWithParams(url: string, params: Record<string, string | string[]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) search.append(key, item);
    else search.set(key, value);
  }
  const query = search.toString();
  return query === '' ? url : `${url}?${query}`;
}

/** Options of {@link fetchFiltered}. */
export interface FilteredFetch {
  readonly url: string | undefined;
  readonly params: Record<string, string | string[]>;
  readonly callback: FetchCallback | null;
  readonly fetchImpl?: FetchLike;
}

/**
 * Get data for the external filters: the callback when there is one, else the URL with the
 * parameters. Resolves to `null` when there is nothing to ask.
 */
export async function fetchFiltered(options: FilteredFetch): Promise<TraceData | LogEntry[] | null> {
  if (options.callback !== null) return options.callback(options.url, options.params);
  if (options.url === undefined || options.url === '') return null;
  return fetchJson<TraceData | LogEntry[]>(urlWithParams(options.url, options.params), options.fetchImpl);
}

/** Index a payload: raw logs are transformed first when the transform fields are configured. */
export function payloadToIndex(payload: TraceData | LogEntry[], config: TraceVisualizerConfig): SpanIndex {
  if (isTransformReady(config)) {
    const traceData = measure('transformLogs', () => transformLogs(payload as LogEntry[], config as TransformConfig));
    return measure('buildSpanIndex', () => buildSpanIndex(traceData));
  }
  return measure('buildSpanIndex', () => buildSpanIndex(payload as TraceData));
}
