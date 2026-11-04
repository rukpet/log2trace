/**
 * The filter controller against a real store, a fake bar and a fake data source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceStore } from '../../src/core/store.ts';
import type { FetchCallback, FilterFieldConfig, FilterSource, FilterValue } from '../../src/core/config.ts';
import type { TraceData } from '../../src/core/otel/trace.ts';
import type { FilterModel } from '../../src/core/filter-model.ts';
import type { ElementConfig } from '../../src/element/config.ts';
import { FilterController, type FilterBarEvents, type FilterBarLike } from '../../src/element/filter-controller.ts';
import { demoOtelIndex, readDemoJson } from '../support/demo-data.ts';

function filter(partial: Partial<FilterFieldConfig> & Pick<FilterFieldConfig, 'field' | 'type' | 'source'>): FilterFieldConfig {
  return {
    label: partial.field, target: 'span', required: false, options: [], optionsSource: 'static',
    placeholder: '', debounce: 0, width: 0, autoRange: false, ...partial,
  };
}

class FakeBar implements FilterBarLike {
  updates = 0;
  disposed = false;
  lastAutoFetch: boolean | null = null;
  constructor(readonly events: FilterBarEvents) {}
  update(_model: FilterModel, autoFetch: boolean): void {
    this.updates++;
    this.lastAutoFetch = autoFetch;
  }
  dispose(): void {
    this.disposed = true;
  }
}

interface Rig {
  readonly controller: FilterController;
  readonly bar: FakeBar;
  readonly store: ReturnType<typeof createTraceStore>;
  readonly config: ElementConfig;
  readonly events: Array<{ type: string; detail: unknown }>;
  readonly calls: Array<{ url: string | undefined; params: Record<string, string | string[]> }>;
  statusChanges: number;
  callback: FetchCallback | null;
}

function rig(config: ElementConfig): Rig {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(demoOtelIndex());
  const payload = readDemoJson('otel-trace.json') as TraceData;
  const r = {
    store, config, events: [] as Rig['events'], calls: [] as Rig['calls'], statusChanges: 0,
    callback: null as FetchCallback | null,
  } as Rig;
  r.callback = async (url, params) => {
    r.calls.push({ url, params });
    return payload;
  };
  let bar!: FakeBar;
  const controller = new FilterController(
    {
      store,
      config: () => r.config,
      fetchCallback: () => r.callback,
      dispatch: (type, detail) => r.events.push({ type, detail }),
      statusChanged: () => {
        r.statusChanges++;
      },
    },
    (events) => {
      bar = new FakeBar(events);
      return bar;
    },
  );
  return Object.assign(r, { controller, bar });
}

const user = (r: Rig, field: string, source: FilterSource, value: FilterValue): void => r.bar.events.onChange(field, source, value);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('configure takes the configs and draws the bar', () => {
  const r = rig({ filterConfigs: [filter({ field: 'spanName', type: 'text', source: 'local' })] });
  r.controller.configure();
  assert.equal(r.controller.model.configs.length, 1);
  assert.ok(r.bar.updates > 0);
  assert.equal(r.bar.lastAutoFetch, true);
  assert.equal(r.store.state.matched, null, 'no value yet: no filter');
});

test('a local filter puts its result into the store, and reports the change', () => {
  const r = rig({ filterConfigs: [filter({ field: 'spanName', type: 'text', source: 'local' })] });
  r.controller.configure();

  user(r, 'spanName', 'local', 'PaymentService');
  const matched = r.store.state.matched;
  assert.ok(matched !== null && matched.size > 0 && matched.size < r.store.state.data.index.size);
  assert.deepEqual(r.events, [{ type: 'filter-changed', detail: { field: 'spanName', source: 'local', value: 'PaymentService', allFilters: { spanName: 'PaymentService' } } }]);
  assert.equal(r.calls.length, 0, 'a local filter never fetches');
});

test('clearing the local filters empties them and lifts the mask', () => {
  const r = rig({ filterConfigs: [filter({ field: 'spanName', type: 'text', source: 'local' })] });
  r.controller.configure();
  user(r, 'spanName', 'local', 'PaymentService');
  r.bar.events.onClear();
  assert.equal(r.controller.model.get('spanName', 'local'), '');
  assert.equal(r.store.state.matched, null);
});

test('an external filter fetches at once with its parameters, and the answer replaces the data', async () => {
  const r = rig({ dataUrl: '/api', filterConfigs: [filter({ field: 'q', type: 'text', source: 'external' })] });
  r.controller.configure();
  const before = r.store.state.data.index;

  user(r, 'q', 'external', 'abc');
  assert.equal(r.controller.fetching, true);
  await settle();

  assert.deepEqual(r.calls, [{ url: '/api', params: { q: 'abc' } }]);
  assert.equal(r.controller.fetching, false);
  assert.notEqual(r.store.state.data.index, before);
  assert.ok(r.statusChanges >= 2, 'status told about the start and the end');
});

test('with auto-fetch off an external change waits for Search', async () => {
  const r = rig({ dataUrl: '/api', autoFetch: false, filterConfigs: [filter({ field: 'q', type: 'text', source: 'external' })] });
  r.controller.configure();
  assert.equal(r.bar.lastAutoFetch, false);

  user(r, 'q', 'external', 'abc');
  await settle();
  assert.equal(r.calls.length, 0);

  r.bar.events.onSearch();
  await settle();
  assert.equal(r.calls.length, 1);
});

test('a required external filter without a value empties the data and fetches nothing', async () => {
  const r = rig({ dataUrl: '/api', filterConfigs: [filter({ field: 'id', type: 'text', source: 'external', required: true })] });
  r.controller.configure();
  user(r, 'id', 'external', '');
  await settle();
  assert.equal(r.calls.length, 0);
  assert.equal(r.store.state.data.index.size, 0);
  assert.equal(r.controller.model.requiredUnfilled(), true);
});

test('a failed fetch leaves no data and no spinner', async () => {
  const r = rig({ dataUrl: '/api', filterConfigs: [filter({ field: 'q', type: 'text', source: 'external' })] });
  r.callback = async () => {
    throw new Error('boom');
  };
  r.controller.configure();
  user(r, 'q', 'external', 'x');
  await settle();
  assert.equal(r.store.state.data.index.size, 0);
  assert.equal(r.controller.fetching, false);
});

test('the answer of a superseded fetch is dropped', async () => {
  const r = rig({ dataUrl: '/api', filterConfigs: [filter({ field: 'q', type: 'text', source: 'external' })] });
  const payload = readDemoJson('otel-trace.json') as TraceData;
  const releases: Array<() => void> = [];
  r.callback = (_url, params) => new Promise((resolve) => {
    r.calls.push({ url: undefined, params });
    releases.push(() => resolve(params.q === 'first' ? { resourceSpans: [] } : payload));
  });
  r.controller.configure();

  user(r, 'q', 'external', 'first');
  user(r, 'q', 'external', 'second');
  releases[1]();
  await settle();
  const afterSecond = r.store.state.data.index;
  releases[0]();
  await settle();

  assert.equal(r.store.state.data.index, afterSecond, 'the first answer arrived late and changed nothing');
  assert.ok(afterSecond.size > 0);
});

test('new data fills auto dropdown options and re-applies the local filter', () => {
  const service = filter({ field: 'serviceName', type: 'dropdown', source: 'local', optionsSource: 'auto' });
  const r = rig({ filterConfigs: [service] });
  r.controller.configure();
  assert.ok(r.controller.model.configs[0].options.length > 1);

  user(r, 'serviceName', 'local', r.controller.model.configs[0].options[0].value);
  assert.ok(r.store.state.matched !== null);
  r.store.setData(demoOtelIndex());
  r.controller.refresh();
  assert.ok(r.store.state.matched !== null, 'the filter is still applied to the new data');
});

test('dispose stops the bar', () => {
  const r = rig({});
  r.controller.dispose();
  assert.equal(r.bar.disposed, true);
});
