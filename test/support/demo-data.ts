/**
 * The demo data and the transform mapping the tests share.
 *
 * Not a test itself (the runner only picks up `*.test.ts`); imported by the suites that
 * characterise the data layer on `demo/logs.json` and `demo/otel-trace.json`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformLogs } from '../../src/core/transform.ts';
import { buildSpanIndex, type SpanIndex } from '../../src/core/span-index.ts';
import type { LogEntry, SpanKindRule, TransformConfig } from '../../src/core/config.ts';
import type { TraceData } from '../../src/core/otel/trace.ts';

export function readDemoJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../demo/${name}`, import.meta.url), 'utf8'));
}

function rule(field: string, value: string, kind: string): SpanKindRule {
  return { match: { [field]: value }, kind };
}

/** The mapping used by `demo/logs-transform.html` (attributes plus `<span-kind-rule>` children). */
export const DEMO_CONFIG: TransformConfig = {
  traceIdField: 'text.BTMID',
  spanGroupFields: ['text.Application', 'text.Action'],
  spanNameField: 'text.Action',
  serviceNameField: 'text.Application',
  timestampField: 'text.CreateDate',
  statusCodeField: 'text.Code',
  parentSpanLookupFields: ['text.InitiatingApplication'],
  spanKindRules: [
    rule('text.ClassName', 'API', 'Server'),
    rule('text.MethodName', 'LogOutgoingDomainRequest', 'Client'),
    rule('text.MethodName', 'LogReceivedDomainResponse', 'Client'),
    rule('text.ClassName', 'HttpUtilSync', 'Client'),
    rule('text.MethodName', 'UnaryServerHandler', 'Server'),
    rule('text.ClassName', 'LoggingInterceptor', 'Server'),
    rule('text.ClassName', 'ServerLoggingInterceptor', 'Server'),
    rule('text.ClassName', 'LoggerInterceptor', 'Server'),
    rule('text.ClassName', '<ProcessConsumeResult>d__27', 'Consumer'),
    rule('text.ClassName', '<ProcessConsumeResult>d__26', 'Consumer'),
    rule('text.ClassName', 'DomainServiceMessageInspector', 'Internal'),
  ],
};

/** The 432 raw log records of `demo/logs.json`. */
export function demoLogs(): LogEntry[] {
  return readDemoJson('logs.json') as LogEntry[];
}

/** `demo/logs.json` transformed with {@link DEMO_CONFIG}: 94 spans. */
export function demoLogsTrace(): TraceData {
  return transformLogs(demoLogs(), DEMO_CONFIG);
}

let logsIndex: SpanIndex | undefined;
let otelIndex: SpanIndex | undefined;

/** The index of {@link demoLogsTrace}, built once and shared. Treat it as read-only. */
export function demoLogsIndex(): SpanIndex {
  logsIndex ??= buildSpanIndex(demoLogsTrace());
  return logsIndex;
}

/** The index of `demo/otel-trace.json`: 12 spans in 6 services, built once and shared. */
export function demoOtelIndex(): SpanIndex {
  otelIndex ??= buildSpanIndex(readDemoJson('otel-trace.json') as TraceData);
  return otelIndex;
}

/** SHA-256 of the lines, the fingerprint the characterisation numbers were recorded with. */
export function sha256(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
