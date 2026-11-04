/**
 * FilterModel: the values behind the filter bar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FilterFieldConfig } from '../src/core/config.ts';
import { buildSpanIndex } from '../src/core/span-index.ts';
import { FilterModel, defaultFilterValue } from '../src/core/filter-model.ts';
import { demoOtelIndex } from './support/demo-data.ts';

function config(partial: Partial<FilterFieldConfig> & Pick<FilterFieldConfig, 'field' | 'type' | 'source'>): FilterFieldConfig {
  return {
    label: partial.field, target: 'span', required: false, options: [], optionsSource: 'static',
    placeholder: '', debounce: 0, width: 0, autoRange: false, ...partial,
  };
}

test('every filter type starts empty in its own shape', () => {
  assert.equal(defaultFilterValue(config({ field: 'a', type: 'text', source: 'local' })), '');
  assert.equal(defaultFilterValue(config({ field: 'a', type: 'dropdown', source: 'local' })), '');
  assert.equal(defaultFilterValue(config({ field: 'a', type: 'checkbox', source: 'local' })), false);
  assert.deepEqual(defaultFilterValue(config({ field: 'a', type: 'multiselect', source: 'local' })), []);
  assert.deepEqual(defaultFilterValue(config({ field: 'a', type: 'datetime-range', source: 'local' })), { from: '', to: '' });
});

test('values are kept per field and source, and survive a new configuration that keeps the field', () => {
  const model = new FilterModel();
  model.configure([config({ field: 'name', type: 'text', source: 'local' }), config({ field: 'q', type: 'text', source: 'external' })]);
  model.set('name', 'local', 'select');
  model.set('q', 'external', 'abc');
  model.set('nope', 'local', 'ignored');

  model.configure([config({ field: 'name', type: 'text', source: 'local' }), config({ field: 'other', type: 'text', source: 'local' })]);
  assert.equal(model.get('name', 'local'), 'select');
  assert.equal(model.get('other', 'local'), '');
  assert.equal(model.get('q', 'external'), undefined, 'a field that was dropped is gone');
  assert.equal(model.get('nope', 'local'), undefined);
});

test('allValues reports both kinds and clearLocal empties only the local ones', () => {
  const model = new FilterModel();
  model.configure([config({ field: 'name', type: 'text', source: 'local' }), config({ field: 'q', type: 'text', source: 'external' })]);
  model.set('name', 'local', 'x');
  model.set('q', 'external', 'y');
  assert.deepEqual(model.allValues(), { name: 'x', q: 'y' });

  model.clearLocal();
  assert.deepEqual(model.allValues(), { name: '', q: 'y' });
});

test('the version moves with every change', () => {
  const model = new FilterModel();
  const v0 = model.version;
  model.configure([config({ field: 'name', type: 'text', source: 'local' })]);
  const v1 = model.version;
  model.set('name', 'local', 'a');
  assert.ok(v1 > v0 && model.version > v1);
});

test('a required external filter holds the data back until it has a value', () => {
  const model = new FilterModel();
  model.configure([config({ field: 'id', type: 'text', source: 'external', required: true })]);
  assert.equal(model.requiredUnfilled(), true);
  model.set('id', 'external', 'abc');
  assert.equal(model.requiredUnfilled(), false);
  assert.deepEqual(model.queryParams(), { id: 'abc' });
});

test('a local filter narrows the spans; without a value it matches nothing special', () => {
  const index = demoOtelIndex();
  const model = new FilterModel();
  model.configure([config({ field: 'spanName', type: 'text', source: 'local' })]);
  assert.equal(model.match(index), null, 'no active filter');

  model.set('spanName', 'local', 'PaymentService');
  const mask = model.match(index);
  assert.ok(mask !== null);
  assert.ok(mask.size > 0 && mask.size < index.size);
});

test('auto dropdowns get their options from the data, sorted, once', () => {
  const index = demoOtelIndex();
  const model = new FilterModel();
  const service = config({ field: 'serviceName', type: 'dropdown', source: 'local', optionsSource: 'auto' });
  model.configure([service]);

  assert.equal(model.fillFromData(index), true);
  const values = service.options.map((option) => option.value);
  assert.ok(values.length > 1);
  assert.deepEqual(values, [...values].sort((a, b) => a.localeCompare(b)));
  assert.equal(model.fillFromData(index), false, 'nothing changes the second time');
});

test('auto-range fills the bounds of an empty range, and leaves a chosen one alone', () => {
  const index = demoOtelIndex();
  const model = new FilterModel();
  model.configure([config({ field: 'time', type: 'datetime-range', source: 'local', autoRange: true })]);
  assert.equal(model.fillFromData(index), true);
  const range = model.get('time', 'local') as { from: string; to: string };
  assert.match(range.from, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.ok(range.from <= range.to);

  model.set('time', 'local', { from: '2020-01-01T00:00:00.000', to: '' });
  model.fillFromData(index);
  assert.equal((model.get('time', 'local') as { from: string }).from, '2020-01-01T00:00:00.000');
});

test('an empty trace fills nothing', () => {
  const model = new FilterModel();
  model.configure([config({ field: 'serviceName', type: 'dropdown', source: 'local', optionsSource: 'auto' })]);
  assert.equal(model.fillFromData(buildSpanIndex({ resourceSpans: [] })), false);
});
