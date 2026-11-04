/**
 * Text formatting and span descriptions (the data behind the tooltip and the detail panel).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpanIndex,
  describeSpan,
  extractAnyValue,
  formatAbsoluteTime,
  formatDuration,
  formatOffset,
  SpanKind,
  type InfoModel,
} from '../src/core.ts';
import { demoLogsIndex, demoOtelIndex } from './support/demo-data.ts';
import { event, kv, span, trace } from './support/trace-builder.ts';

const PAYMENT = '1a2b3c4d5e6f7890';

function rows(model: InfoModel | null, section: string): ReadonlyArray<readonly [string, string]> {
  return model?.sections.find((s) => s.title === section)?.rows ?? [];
}

function describeOne(...spans: Parameters<typeof span>[]): (id: string, level?: 'brief' | 'full') => InfoModel | null {
  const index = buildSpanIndex(trace(['svc', spans.map((args) => span(...args))]));
  return (id, level) => describeSpan(index, id, level);
}

test('formatDuration picks the unit that reads best', () => {
  assert.equal(formatDuration(0), '0µs');
  assert.equal(formatDuration(0.25), '250µs');
  assert.equal(formatDuration(1), '1.00ms');
  assert.equal(formatDuration(12.5), '12.50ms');
  assert.equal(formatDuration(1500), '1.50s');
  assert.equal(formatDuration(60_000), '1.00min');
  assert.equal(formatDuration(125_000), '2.08min');
});

test('formatOffset carries a sign', () => {
  assert.equal(formatOffset(0.25), '+250µs');
  assert.equal(formatOffset(0), '+0µs');
  assert.equal(formatOffset(1500), '+1.50s');
  assert.equal(formatOffset(-1500), '-1.50s');
  assert.equal(formatOffset(-0.25), '-250µs');
});

test('extractAnyValue turns every attribute kind into text', () => {
  assert.equal(extractAnyValue({ stringValue: 'hello' }), 'hello');
  assert.equal(extractAnyValue({ stringValue: '' }), '');
  assert.equal(extractAnyValue({ intValue: 42 }), '42');
  assert.equal(extractAnyValue({ intValue: '9007199254740993' }), '9007199254740993');
  assert.equal(extractAnyValue({ doubleValue: 1.5 }), '1.5');
  assert.equal(extractAnyValue({ boolValue: false }), 'false');
  assert.equal(extractAnyValue({ bytesValue: 'AAEC' }), 'AAEC');
  assert.equal(extractAnyValue({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: 2 }] } }), '["a","2"]');
  assert.equal(
    extractAnyValue({ kvlistValue: { values: [kv('k', 'v'), { key: 'n', value: { boolValue: true } }] } }),
    '{"k":"v","n":"true"}',
  );
  assert.equal(extractAnyValue({}), '');
});

test('formatAbsoluteTime shows local wall-clock time with milliseconds', () => {
  const local = new Date(2026, 1, 26, 5, 37, 20, 340); // built from local parts, so the test holds in any time zone
  assert.equal(formatAbsoluteTime(String(BigInt(local.getTime()) * 1_000_000n)), '2026-02-26 05:37:20.340');
  const earlier = new Date(2009, 0, 2, 3, 4, 5, 6);
  assert.equal(formatAbsoluteTime(String(BigInt(earlier.getTime()) * 1_000_000n)), '2009-01-02 03:04:05.006');
});

test('describeSpan returns null for a span that is not in the trace', () => {
  assert.equal(describeSpan(demoOtelIndex(), 'nope'), null);
  assert.equal(describeSpan(demoOtelIndex(), 'nope', 'brief'), null);
});

test('the brief description has the quick facts for a tooltip', () => {
  assert.deepEqual(describeSpan(demoOtelIndex(), PAYMENT, 'brief'), {
    title: 'PaymentService.processPayment',
    subtitle: 'payment-service',
    status: 'ok',
    sections: [{
      title: 'Overview',
      rows: [
        ['Duration', '1.20s'],
        ['Kind', 'Server'],
        ['Span ID', PAYMENT],
        ['Events', '3'],
      ],
    }],
  });
});

test('the full description has overview, attributes and events', () => {
  const model = describeSpan(demoOtelIndex(), PAYMENT);
  assert.ok(model);

  assert.equal(model.title, 'PaymentService.processPayment');
  assert.equal(model.subtitle, 'payment-service');
  assert.equal(model.status, 'ok');
  assert.deepEqual(model.sections.map((s) => s.title), ['Overview', 'Attributes', 'Events']);

  assert.deepEqual(rows(model, 'Overview'), [
    ['Service', 'payment-service'],
    ['Status', 'OK'],
    ['Kind', 'Server'],
    ['Duration', '1.20s'],
    ['Start', formatAbsoluteTime('1706889600900000000')],
    ['End', formatAbsoluteTime('1706889602100000000')],
    ['Trace ID', '5b8efff798038103d269b633813fc60c'],
    ['Span ID', PAYMENT],
    ['Parent ID', '00f067aa0ba902b7'],
  ]);

  const attributes = model.sections[1];
  assert.equal(attributes.badge, 6);
  assert.deepEqual(attributes.rows?.slice(0, 3), [
    ['rpc.system', 'grpc'],
    ['rpc.service', 'PaymentService'],
    ['rpc.method', 'processPayment'],
  ]);

  const events = model.sections[2];
  assert.equal(events.badge, 3);
  assert.deepEqual(events.groups?.map((g) => [g.title, g.aside, g.rows.length]), [
    ['payment.authorization_requested', '+50.00ms', 0],
    ['payment.authorized', '+900.00ms', 1],
    ['payment.captured', '+1.15s', 1],
  ]);
});

test('a root span has no parent row, and an empty span has only an overview', () => {
  const describe = describeOne(['solo', undefined, 0, 2]);
  const full = describe('solo');

  assert.deepEqual(full?.sections.map((s) => s.title), ['Overview']);
  assert.equal(rows(full, 'Overview').some(([label]) => label === 'Parent ID'), false);
  assert.deepEqual(rows(describe('solo', 'brief'), 'Overview').map(([label]) => label), ['Duration', 'Kind', 'Span ID']);
});

test('sub-millisecond durations keep their microseconds', () => {
  const describe = describeOne(['fast', undefined, 10, 10.35]);
  assert.deepEqual(rows(describe('fast', 'brief'), 'Overview')[0], ['Duration', '350µs']);
});

test('a status message is shown with the status, and unknown codes read as unset', () => {
  const describe = describeOne(
    ['failed', undefined, 0, 5, { status: { code: 2, message: 'connection reset' } }],
    ['odd', undefined, 6, 7, { status: { code: 7 }, kind: 99 as SpanKind }],
  );

  const failed = describe('failed');
  assert.equal(failed?.status, 'error');
  assert.deepEqual(rows(failed, 'Overview').slice(1, 3), [['Status', 'Error'], ['Message', 'connection reset']]);
  assert.deepEqual(rows(describe('failed', 'brief'), 'Overview').at(-1), ['Message', 'connection reset']);

  const odd = describe('odd');
  assert.equal(odd?.status, 'unset');
  assert.deepEqual(rows(odd, 'Overview').slice(1, 3), [['Status', 'Unset'], ['Kind', 'Unknown']]);
});

test('library attributes are hidden, but the log count is shown in the overview', () => {
  const describe = describeOne(['grouped', undefined, 0, 5, {
    attributes: [kv('log2trace.log_count', '5'), kv('http.method', 'GET'), kv('log2trace.source_logs', '[]')],
  }]);
  const model = describe('grouped');

  assert.deepEqual(rows(model, 'Attributes'), [['http.method', 'GET']]);
  assert.equal(model?.sections.find((s) => s.title === 'Attributes')?.badge, 1);
  assert.deepEqual(rows(model, 'Overview').find(([label]) => label === 'Log Count'), ['Log Count', '5']);
});

test('events are listed in time order, with their offset from the start of the span', () => {
  const describe = describeOne(['s', undefined, 100, 200, {
    events: [
      event('late', 130, [kv('k', 'v')]),
      event('early', 110),
      event('before-start', 95),
    ],
  }]);
  const events = describe('s')?.sections.find((s) => s.title === 'Events');

  assert.deepEqual(events?.groups?.map((g) => [g.title, g.aside]), [
    ['before-start', '-5.00ms'],
    ['early', '+10.00ms'],
    ['late', '+30.00ms'],
  ]);
  assert.deepEqual(events?.groups?.[2].rows, [['k', 'v']]);
  assert.equal(events?.badge, 3);
});

test('demo/logs.json: the gateway span carries its 54 logs', () => {
  const index = demoLogsIndex();
  const model = describeSpan(index, '3a3f24de298ab89f');
  assert.ok(model);

  assert.equal(model.status, 'error');
  assert.deepEqual(rows(model, 'Overview').find(([label]) => label === 'Log Count'), ['Log Count', '54']);
  assert.deepEqual(model.sections.map((s) => s.title), ['Overview', 'Events'], 'the only attribute is the hidden log count');
  const events = model.sections[1];
  assert.equal(events.badge, 54);
  assert.equal(events.groups?.length, 54);
  assert.equal(events.groups?.[0].aside, '+0µs');
});
