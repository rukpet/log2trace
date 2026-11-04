/**
 * Element configuration: attributes, child elements, merging, kind colours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransformReady, kindColorOverrides, mergeConfig, readConfig, type AttributeSource } from '../../src/element/config.ts';

class FakeSource implements AttributeSource {
  readonly children: Array<FakeSource & { tagName: string }> = [];

  constructor(public tagName = 'DIV', private readonly attributes: Record<string, string> = {}) {}

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  child(tagName: string, attributes: Record<string, string>): this {
    this.children.push(new FakeSource(tagName, attributes) as FakeSource & { tagName: string });
    return this;
  }
}

test('transform attributes become fields; lists are split and trimmed', () => {
  const config = readConfig(new FakeSource('trace-visualizer', {
    'data-url': './logs.json',
    'trace-id-field': 'text.BTMID',
    'span-name-field': 'text.Action',
    'service-name-field': 'text.MachineName',
    'timestamp-field': 'text.Timestamp',
    'span-group-fields': 'a, b ,c',
    'default-span-kind': 'Internal',
  }));
  assert.equal(config.dataUrl, './logs.json');
  assert.equal(config.traceIdField, 'text.BTMID');
  assert.deepEqual(config.spanGroupFields, ['a', 'b', 'c']);
  assert.equal(config.defaultSpanKind, 'Internal');
  assert.equal(isTransformReady(config), true);
});

test('without the four required fields the data is not logs', () => {
  assert.equal(isTransformReady(readConfig(new FakeSource('x', { 'trace-id-field': 'a' }))), false);
  assert.equal(isTransformReady({}), false);
});

test('display attributes: numbers, booleans, strings; a bad number is dropped', () => {
  const config = readConfig(new FakeSource('x', {
    'span-height': '24', 'span-padding': 'abc', height: '500', 'gutter-width': '300',
    'show-legend': '', 'full-width': 'false', 'detail-panel-width': '45%', 'auto-fetch': 'false',
  }));
  assert.equal(config.spanHeight, 24);
  assert.equal(config.spanPadding, undefined);
  assert.equal(config.height, 500);
  assert.equal(config.gutterWidth, 300);
  assert.equal(config.showLegend, true, 'a bare attribute is true');
  assert.equal(config.fullWidth, false);
  assert.equal(config.detailPanelWidth, '45%');
  assert.equal(config.autoFetch, false);
});

test('<span-kind-rule> children: field and value, or JSON; incomplete ones are skipped', () => {
  const host = new FakeSource('x')
    .child('SPAN-KIND-RULE', { kind: 'Server', 'match-field': 'text.Type', 'match-value': 'request' })
    .child('span-kind-rule', { kind: 'Client', match: '{"text.Type":"call","text.Dir":"out"}' })
    .child('span-kind-rule', { kind: 'Internal' })
    .child('span-kind-rule', { 'match-field': 'a', 'match-value': 'b' });
  const config = readConfig(host);
  assert.deepEqual(config.spanKindRules, [
    { match: { 'text.Type': 'request' }, kind: 'Server' },
    { match: { 'text.Type': 'call', 'text.Dir': 'out' }, kind: 'Client' },
  ]);
});

test('<trace-filter> children get defaults, and need field, label, type and source', () => {
  const host = new FakeSource('x')
    .child('trace-filter', { field: 'spanName', label: 'Name', type: 'text', source: 'local' })
    .child('trace-filter', { field: 'svc', label: 'Service', type: 'dropdown', source: 'local', options: '["a",{"value":"b","label":"B"}]', required: '', 'auto-range': '', debounce: '50' })
    .child('trace-filter', { field: 'broken', label: 'No type' });
  const filters = readConfig(host).filterConfigs ?? [];
  assert.equal(filters.length, 2);
  assert.equal(filters[0].debounce, 400);
  assert.equal(filters[0].width, 300);
  assert.equal(filters[0].target, 'span');
  assert.equal(filters[0].optionsSource, 'static');
  assert.deepEqual(filters[1].options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'B' }]);
  assert.equal(filters[1].required, true);
  assert.equal(filters[1].autoRange, true);
  assert.equal(filters[1].debounce, 50);
});

test('the programmatic config wins field by field', () => {
  const merged = mergeConfig({ spanHeight: 20, dataUrl: 'a.json' }, { spanHeight: 40 });
  assert.equal(merged.spanHeight, 40);
  assert.equal(merged.dataUrl, 'a.json');
  assert.deepEqual(mergeConfig({}, { spanGroupFields: 'one' as unknown as string[] }).spanGroupFields, ['one']);
});

test('kind-colors and the old color-scheme both set kind colours', () => {
  assert.deepEqual(readConfig(new FakeSource('x', { 'kind-colors': '{"2":"red"}' })).kindColors, { 2: 'red' });
  assert.deepEqual(readConfig(new FakeSource('x', { 'color-scheme': '{"3":"blue"}' })).kindColors, { 3: 'blue' });
  assert.equal(readConfig(new FakeSource('x', { 'kind-colors': '{bad' })).kindColors, undefined);
});

test('kind colour overrides take numbers and names and skip the rest', () => {
  assert.deepEqual(kindColorOverrides({ '2': 'red', client: 'blue', Producer: 'green', '9': 'x', nope: 'y' }), [
    ['kindServer', 'red'],
    ['kindClient', 'blue'],
    ['kindProducer', 'green'],
  ]);
  assert.deepEqual(kindColorOverrides(undefined), []);
});
