/**
 * Element configuration: attributes, child elements, merging, kind colours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkViewsDeprecated,
  DEPRECATED_VIEWS_WARNING,
  isTransformReady,
  kindColorOverrides,
  mergeConfig,
  readConfig,
  resolveActiveView,
  resolveDeclaredViews,
  type AttributeSource,
} from '../../src/element/config.ts';
import { TraceViewElement } from '../../src/element/carriers.ts';

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

test('<trace-view> children: type, label, active; incomplete ones are skipped', () => {
  const host = new FakeSource('x')
    .child('TRACE-VIEW', { type: 'waterfall' })
    .child('trace-view', { type: 'flame', label: 'Flamegraph', active: '' })
    .child('trace-view', { id: 'sequence', label: 'Causal Sequence' })
    .child('trace-view', { label: 'Missing type' });
  const views = readConfig(host).viewConfigs ?? [];
  assert.equal(views.length, 3);
  assert.deepEqual(views[0], { type: 'waterfall' });
  assert.deepEqual(views[1], { type: 'flame', label: 'Flamegraph', active: true });
  assert.deepEqual(views[2], { type: 'sequence', label: 'Causal Sequence' });

  // No trace-view children
  const emptyHost = new FakeSource('trace-visualizer');
  assert.equal(readConfig(emptyHost).viewConfigs, undefined);
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

test('the views attribute is ignored in readConfig', () => {
  const host = new FakeSource('trace-visualizer', { views: 'flame,service' });
  const config = readConfig(host);
  assert.equal(config.viewConfigs, undefined);
});

test('checkViewsDeprecated warns once per element when views attribute is present', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    const hostWithViews = new FakeSource('trace-visualizer', { views: 'flame,service' });
    let warned = false;

    // First check triggers warning and returns true
    warned = checkViewsDeprecated(hostWithViews, warned);
    assert.equal(warned, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], DEPRECATED_VIEWS_WARNING);

    // Subsequent checks (e.g. repeated read or lifecycle) do not warn again
    warned = checkViewsDeprecated(hostWithViews, warned);
    assert.equal(warned, true);
    assert.equal(warnings.length, 1, 'warned only once');

    // Host without views attribute does not warn
    const hostWithoutViews = new FakeSource('trace-visualizer');
    const unwarned = checkViewsDeprecated(hostWithoutViews, false);
    assert.equal(unwarned, false);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveDeclaredViews drops unknown types, warns about them, and deduplicates type values', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    const isKnown = (type: string) => ['waterfall', 'flame', 'service'].includes(type);

    // Unknown types dropped (with warning), duplicates dropped (first occurrence kept)
    const configs = [
      { type: 'waterfall', label: 'First Waterfall' },
      { type: 'inspector' },
      { type: 'flame', label: 'Flame' },
      { type: 'waterfall', label: 'Duplicate Waterfall' },
      { type: 'unknown-view' },
    ];
    const resolved = resolveDeclaredViews(configs, isKnown);
    assert.deepEqual(resolved, [
      { type: 'waterfall', label: 'First Waterfall' },
      { type: 'flame', label: 'Flame' },
    ]);
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].includes('inspector'), 'warns about removed inspector type');
    assert.ok(warnings[1].includes('unknown-view'), 'warns about unknown type');

    // When all declared are unknown, warns and falls back to waterfall
    assert.deepEqual(resolveDeclaredViews([{ type: 'bad1' }, { type: 'bad2' }], isKnown), [
      { type: 'waterfall' },
    ]);

    // Empty or undefined fallback
    assert.deepEqual(resolveDeclaredViews([], isKnown), [{ type: 'waterfall' }]);
    assert.deepEqual(resolveDeclaredViews(undefined, isKnown), [{ type: 'waterfall' }]);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveDeclaredViews calls onUnknown callback if provided', () => {
  const unknown: string[] = [];
  const isKnown = (type: string) => type === 'waterfall';
  const resolved = resolveDeclaredViews([{ type: 'flame' }, { type: 'inspector' }], isKnown, (type) => unknown.push(type));
  assert.deepEqual(resolved, [{ type: 'waterfall' }]);
  assert.deepEqual(unknown, ['flame', 'inspector']);
});

test('resolveActiveView preserves valid requested view, or falls back when view is removed', () => {
  const available = ['waterfall', 'service', 'sequence'];

  // 1. Valid requested view is preserved
  assert.equal(resolveActiveView(available, 'service'), 'service');

  // 2. Removed active view falls back to declared active view if present
  const withActive = [
    { type: 'waterfall' },
    { type: 'service' },
    { type: 'sequence', active: true },
  ];
  // 'flame' was active but is not in available: falls back to 'sequence' (active: true)
  assert.equal(resolveActiveView(available, 'flame', withActive), 'sequence');

  // 3. Removed active view falls back to first available view when no active flag
  const withoutActive = [
    { type: 'waterfall' },
    { type: 'service' },
  ];
  assert.equal(resolveActiveView(available, 'flame', withoutActive), 'waterfall');

  // 4. Fallback when requested is null
  assert.equal(resolveActiveView(available, null, withActive), 'sequence');
  assert.equal(resolveActiveView(available, null, withoutActive), 'waterfall');

  // 5. Empty available types defaults to waterfall
  assert.equal(resolveActiveView([], 'flame'), 'waterfall');
});

test('TraceViewElement attributeChangedCallback triggers a single host rerender passing itself', () => {
  let rerenderCalls = 0;
  let passedCarrier: unknown = null;
  const fakeHost = {
    _rerender(carrier?: HTMLElement) {
      rerenderCalls++;
      passedCarrier = carrier;
    },
  };

  const carrier = new TraceViewElement();
  (carrier as unknown as Record<string, unknown>).host = fakeHost;

  carrier.attributeChangedCallback();
  assert.equal(rerenderCalls, 1, 'notifies host exactly once per attribute change');
  assert.equal(passedCarrier, carrier, 'passes the carrier itself to host _rerender');
});
