/**
 * The trace store: shared state, batched notifications, and the selectors cached on top of it.
 * Written against the public `core` entry on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_ORIGIN,
  MIXED_ORIGIN,
  Slice,
  SpanMask,
  buildSpanIndex,
  createTraceStore,
  defineSelector,
  hoveredSpan,
  matchSpans,
  matchSummary,
  selectedSpan,
  spanSetOf,
  touches,
  type ChangeSet,
  type SpanIndex,
  type TraceData,
  type TraceStore,
} from '../src/core.ts';
import { demoLogsIndex, demoOtelIndex, readDemoJson } from './support/demo-data.ts';

// The otel demo tree (ids shortened in the comments):
//   eee19 frontend-web
//   └ 00f06 order-service
//     ├ b7ad6 validate_inventory ─ 3c3c4 ─ 9f8e7
//     ├ 1a2b3 payment ─ a1b2c, f1e2d
//     ├ 7e8f9 notification ─ 4f5e6
//     └ 2b3c4 shipping ─ 8c9d0
const ROOT = 'eee19b7ec3c1b174';
const ORDER = '00f067aa0ba902b7';
const VALIDATE = 'b7ad6b7169203331';
const INVENTORY = '3c3c4e5a6b7d8e9f';
const SELECT = '9f8e7d6c5b4a3210';
const PAYMENT = '1a2b3c4d5e6f7890';
const STRIPE = 'a1b2c3d4e5f60718';
const NOTIFY = '7e8f9a0b1c2d3e4f';
const SHIPPING = '2b3c4d5e6f708192';
const PARENTS = [ROOT, ORDER, VALIDATE, INVENTORY, PAYMENT, NOTIFY, SHIPPING];

/** A scheduler the test triggers by hand. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (flush: () => void): void => {
      queue.push(flush);
    },
    run(): void {
      while (queue.length > 0) queue.shift()?.();
    },
    get waiting(): number {
      return queue.length;
    },
  };
}

/** A store holding the otel demo, with the load notification already delivered. */
function loadedStore(index: SpanIndex = demoOtelIndex()) {
  const scheduler = manualScheduler();
  const store = createTraceStore({ schedule: scheduler.schedule });
  store.setData(index);
  scheduler.run();
  const changes: ChangeSet[] = [];
  store.subscribe((change) => changes.push(change));
  return { store, scheduler, changes };
}

function ids(set: Iterable<string>): string[] {
  return [...set].sort();
}

test('a new store is empty', () => {
  const { state } = createTraceStore();
  assert.equal(state.data.phase, 'empty');
  assert.equal(state.data.index.size, 0);
  assert.equal(state.data.generation, 0);
  assert.equal(state.selection.ids.size, 0);
  assert.equal(state.selection.primary, null);
  assert.equal(state.hover, null);
  assert.equal(state.collapsed.size, 0);
  assert.equal(state.matched, null);
  assert.equal(state.window, null);
});

test('setData loads the index, counts generations and notifies once', () => {
  const scheduler = manualScheduler();
  const store = createTraceStore({ schedule: scheduler.schedule });
  const changes: ChangeSet[] = [];
  store.subscribe((change) => changes.push(change));

  const index = demoOtelIndex();
  store.setData(index);
  assert.equal(store.state.data.index, index, 'the state is current before any notification');
  assert.equal(store.state.data.phase, 'ready');
  assert.equal(store.state.data.generation, 1);
  assert.equal(changes.length, 0, 'notifications wait for the scheduler');

  scheduler.run();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mask, Slice.Data);
  assert.equal(changes[0].origin, API_ORIGIN);
  assert.equal(changes[0].prev.data.phase, 'empty');

  store.setData(index);
  scheduler.run();
  assert.equal(changes.length, 1, 'loading the same index again changes nothing');

  store.setData(buildSpanIndex({ resourceSpans: [] }));
  assert.equal(store.state.data.phase, 'empty');
  assert.equal(store.state.data.generation, 2);
});

test('setPhase reports loading and errors without touching the index', () => {
  const { store, scheduler, changes } = loadedStore();
  const index = store.state.data.index;

  store.setPhase('loading');
  store.setPhase('error', 'network down');
  scheduler.run();

  assert.equal(store.state.data.phase, 'error');
  assert.equal(store.state.data.error, 'network down');
  assert.equal(store.state.data.index, index);
  assert.equal(store.state.data.generation, 1);
  assert.equal(changes.length, 1, 'both calls arrive as one change');
  assert.equal(changes[0].mask, Slice.Data);

  store.setPhase('error', 'network down');
  scheduler.run();
  assert.equal(changes.length, 1, 'repeating the same phase is not a change');

  store.setData(index);
  assert.equal(store.state.data.phase, 'ready', 'loading the index again recovers');
  assert.equal(store.state.data.error, undefined);
});

test('changes of one tick arrive together, with the state from before the first', () => {
  const { store, scheduler, changes } = loadedStore();
  const before = store.state;

  store.setSelection([ORDER]);
  store.setHover([PAYMENT]);
  store.toggleCollapse(SHIPPING);
  assert.equal(store.state.selection.primary, ORDER, 'state is current immediately');
  assert.equal(changes.length, 0);
  assert.equal(scheduler.waiting, 1, 'one flush is scheduled however many changes are made');

  scheduler.run();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mask, Slice.Selection | Slice.Hover | Slice.Collapse);
  assert.equal(changes[0].prev, before);
  assert.equal(touches(changes[0], Slice.Hover), true);
  assert.equal(touches(changes[0], Slice.Filter | Slice.Window), false);
});

test('origin: one origin is passed on, several become MIXED', () => {
  const { store, scheduler, changes } = loadedStore();

  store.setSelection([ORDER], { origin: 'view-1' });
  store.toggleCollapse(PAYMENT, { origin: 'view-1' });
  scheduler.run();
  assert.equal(changes[0].origin, 'view-1');

  store.setHover([ROOT], { origin: 'view-1' });
  store.setHover(null, { origin: 'shell' });
  scheduler.run();
  assert.equal(changes[1].origin, MIXED_ORIGIN, 'two origins in one batch cannot be told apart');

  store.setSelection([STRIPE], { origin: 'view-1' });
  store.setWindow({ t0: 0, t1: 10 }, { origin: 'view-1' });
  scheduler.run();
  assert.equal(changes[2].origin, 'view-1');
});

test('subscribers hear only about the slices they ask for, in subscription order', () => {
  const { store, scheduler } = loadedStore();
  const calls: string[] = [];
  store.subscribe(() => calls.push('all'), Slice.All);
  store.subscribe(() => calls.push('hover'), Slice.Hover);
  store.subscribe(() => calls.push('filter'), Slice.Filter | Slice.Window);

  store.setSelection([ORDER]);
  scheduler.run();
  assert.deepEqual(calls, ['all']);

  calls.length = 0;
  store.setHover([ORDER]);
  store.setWindow({ t0: 5, t1: 9 });
  scheduler.run();
  assert.deepEqual(calls, ['all', 'hover', 'filter']);
});

test('unsubscribing works, including from inside a listener', () => {
  const { store, scheduler } = loadedStore();
  const calls: string[] = [];
  const stopFirst = store.subscribe(() => calls.push('first'));
  const stopSecond = store.subscribe(() => {
    calls.push('second');
    stopThird();
  });
  const stopThird = store.subscribe(() => calls.push('third'));

  store.setSelection([ORDER]);
  scheduler.run();
  assert.deepEqual(calls, ['first', 'second'], 'a listener removed during the delivery is skipped');

  calls.length = 0;
  stopFirst();
  stopSecond();
  store.setSelection([ROOT]);
  scheduler.run();
  assert.deepEqual(calls, []);
});

test('a listener that throws does not stop the others; the first error surfaces', () => {
  const { store } = loadedStore();
  const calls: string[] = [];
  store.subscribe(() => {
    throw new Error('first listener');
  });
  store.subscribe(() => {
    calls.push('second');
    throw new Error('second listener');
  });
  store.subscribe(() => calls.push('third'));

  store.setSelection([ORDER]);
  assert.throws(() => store.flushSync(), /first listener/);
  assert.deepEqual(calls, ['second', 'third']);
});

test('flushSync delivers at once, and the scheduled flush afterwards finds nothing to do', () => {
  const { store, scheduler, changes } = loadedStore();

  store.setSelection([ORDER]);
  store.flushSync();
  assert.equal(changes.length, 1);

  scheduler.run();
  assert.equal(changes.length, 1);

  store.setHover([ORDER]);
  assert.equal(scheduler.waiting, 1, 'a change after flushSync schedules a new flush');
  scheduler.run();
  assert.equal(changes.length, 2);
});

test('by default notifications are delivered in a microtask', async () => {
  const store = createTraceStore();
  let heard = 0;
  store.subscribe(() => heard++);

  store.setData(demoOtelIndex());
  store.setSelection([ORDER]);
  assert.equal(heard, 0);
  await Promise.resolve();
  assert.equal(heard, 1);
});

test('setters that change nothing do not notify', () => {
  const { store, scheduler, changes } = loadedStore();
  store.setSelection([ORDER]);
  store.setWindow({ t0: 1, t1: 2 });
  store.setHover([ROOT]);
  scheduler.run();
  changes.length = 0;

  store.setSelection([ORDER]);
  store.setSelection(['no-such-span', ORDER]);
  store.setHover([ROOT]);
  store.setWindow({ t0: 1, t1: 2 });
  store.setMatched(null);
  store.expandAll();
  store.toggleCollapse(SELECT); // a leaf
  store.toggleCollapse('no-such-span');
  store.setCollapsed([SELECT, 'no-such-span']);
  store.expandAncestors(ROOT);
  store.touch(0);
  scheduler.run();

  assert.deepEqual(changes, []);
});

test('selection keeps the spans that exist, picks a primary and remembers who chose it', () => {
  const { store, scheduler, changes } = loadedStore();

  store.setSelection([PAYMENT, 'no-such-span', STRIPE, PAYMENT], { origin: 'flame-1', key: 'box-7' });
  scheduler.run();
  const { selection } = store.state;
  assert.deepEqual([...selection.ids], [PAYMENT, STRIPE], 'unknown ids are dropped, duplicates collapse');
  assert.equal(selection.primary, PAYMENT, 'the first id is primary by default');
  assert.equal(selection.origin, 'flame-1');
  assert.equal(selection.key, 'box-7');
  assert.equal(changes[0].origin, 'flame-1');

  store.setSelection([PAYMENT, STRIPE], { primary: STRIPE, origin: 'flame-1', key: 'box-7' });
  assert.equal(store.state.selection.primary, STRIPE);
  store.setSelection([PAYMENT, STRIPE], { primary: ROOT });
  assert.equal(store.state.selection.primary, PAYMENT, 'a primary outside the set is ignored');

  store.setSelection(['no-such-span']);
  assert.equal(store.state.selection.ids.size, 0);
  assert.equal(store.state.selection.primary, null);
});

test('hover is a target too, and nothing known clears it', () => {
  const { store } = loadedStore();

  store.setHover([STRIPE], { origin: 'graph-2', key: 'edge-1' });
  assert.equal(store.state.hover?.primary, STRIPE);
  assert.equal(store.state.hover?.key, 'edge-1');

  store.setHover(['no-such-span']);
  assert.equal(store.state.hover, null);
  store.setHover([STRIPE]);
  store.setHover(null);
  assert.equal(store.state.hover, null);
});

test('collapse: toggle, set, all, expand, and ancestors', () => {
  const { store, scheduler, changes } = loadedStore();
  const collapsed = () => ids(store.state.collapsed);

  store.toggleCollapse(PAYMENT);
  assert.deepEqual(collapsed(), [PAYMENT]);
  store.toggleCollapse(ORDER);
  assert.deepEqual(collapsed(), [ORDER, PAYMENT].sort());
  store.toggleCollapse(PAYMENT);
  assert.deepEqual(collapsed(), [ORDER]);

  store.setCollapsed([SHIPPING, STRIPE, 'no-such-span', SHIPPING]);
  assert.deepEqual(collapsed(), [SHIPPING], 'leaves and unknown ids are ignored');

  store.collapseAll();
  assert.deepEqual(collapsed(), PARENTS.slice().sort(), 'exactly the spans that have children');
  assert.equal(store.state.collapsed.size, 7);

  // from a fully collapsed trace, reveal one span: only its ancestors open
  store.expandAncestors(SELECT);
  assert.deepEqual(collapsed(), [PAYMENT, NOTIFY, SHIPPING].sort());
  store.expandAncestors(SELECT);
  assert.deepEqual(collapsed(), [PAYMENT, NOTIFY, SHIPPING].sort(), 'revealing a visible span changes nothing');

  store.expandAll();
  assert.equal(store.state.collapsed.size, 0);
  scheduler.run();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mask, Slice.Collapse);
});

test('collapsed state is copy-on-write, so earlier states stay valid', () => {
  const { store } = loadedStore();
  const before = store.state;

  store.toggleCollapse(ORDER);
  assert.equal(before.collapsed.size, 0);
  assert.equal(store.state.collapsed.size, 1);
  assert.notEqual(store.state, before);
  assert.equal(before.collapsed.has(ORDER), false);
  assert.equal(store.state.collapsed.has(ORDER), true);
});

test('the filter result is stored as a mask over the rows', () => {
  const { store, scheduler, changes } = loadedStore();
  const index = store.state.data.index;
  const mask = new SpanMask(index, new Uint8Array(index.size).fill(0)).withRow(1, true).withRow(2, true);

  store.setMatched(mask);
  assert.equal(store.state.matched, mask);
  store.setMatched(SpanMask.of(index, [...mask]));
  scheduler.run();
  assert.equal(changes.length, 1, 'an equal mask is not a change');
  assert.equal(changes[0].mask, Slice.Filter);

  store.setMatched(spanSetOf([STRIPE, 'no-such-span']));
  assert.ok(store.state.matched instanceof SpanMask, 'other sets are converted');
  assert.deepEqual([...(store.state.matched ?? [])], [STRIPE]);

  store.setMatched(null);
  assert.equal(store.state.matched, null);
});

test('the shared time window ignores values that make no sense', () => {
  const { store } = loadedStore();

  store.setWindow({ t0: 100, t1: 200 });
  assert.deepEqual(store.state.window, { t0: 100, t1: 200 });
  store.setWindow({ t0: 5, t1: 5 });
  store.setWindow({ t0: 9, t1: 3 });
  store.setWindow({ t0: Number.NaN, t1: 3 });
  store.setWindow({ t0: 0, t1: Infinity });
  assert.deepEqual(store.state.window, { t0: 100, t1: 200 });
  store.setWindow(null);
  assert.equal(store.state.window, null);
});

test('touch reports changes the store holds no state for', () => {
  const { store, scheduler, changes } = loadedStore();
  const before = store.state;

  store.touch(Slice.Theme | Slice.Config, { origin: 'element' });
  scheduler.run();

  assert.equal(store.state, before);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mask, Slice.Theme | Slice.Config);
  assert.equal(changes[0].origin, 'element');
});

test('replacing the data keeps what still exists and resets the rest', () => {
  const { store, scheduler, changes } = loadedStore();
  store.setSelection([PAYMENT, STRIPE], { primary: STRIPE });
  store.setHover([ROOT]);
  store.setCollapsed([ORDER, SHIPPING]);
  store.setMatched(spanSetOf([PAYMENT]));
  store.setWindow({ t0: 10, t1: 50 });
  scheduler.run();
  changes.length = 0;

  const reloaded = buildSpanIndex(readDemoJson('otel-trace.json') as TraceData);
  store.setData(reloaded);
  scheduler.run();

  const { state } = store;
  assert.equal(state.data.index, reloaded);
  assert.equal(state.data.generation, 2);
  assert.deepEqual([...state.selection.ids], [PAYMENT, STRIPE]);
  assert.equal(state.selection.primary, STRIPE);
  assert.deepEqual(ids(state.collapsed), [ORDER, SHIPPING].sort());
  assert.equal(state.collapsed.index, reloaded, 'the mask now refers to the new rows');
  assert.equal(state.hover, null);
  assert.equal(state.matched, null);
  assert.equal(state.window, null);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mask, Slice.Data | Slice.Hover | Slice.Collapse | Slice.Filter | Slice.Window);
});

test('replacing the data with a different trace drops the selection that no longer exists', () => {
  const { store, scheduler, changes } = loadedStore();
  store.setSelection([PAYMENT]);
  scheduler.run();
  changes.length = 0;

  store.setData(demoLogsIndex());
  scheduler.run();

  assert.equal(store.state.selection.ids.size, 0);
  assert.equal(store.state.selection.primary, null);
  assert.equal(changes[0].mask, Slice.Data | Slice.Selection);
});

// -- selectors ------------------------------------------------------------------------------

test('derive recomputes only when a slice the selector reads has changed', () => {
  const { store } = loadedStore();
  let runs = 0;
  const selectionSize = defineSelector<number>('test.selectionSize', Slice.Selection, (state) => {
    runs++;
    return state.selection.ids.size;
  });

  assert.equal(store.derive(selectionSize), 0);
  assert.equal(store.derive(selectionSize), 0);
  assert.equal(runs, 1);

  store.setHover([ROOT]);
  store.toggleCollapse(ORDER);
  store.setWindow({ t0: 1, t1: 2 });
  assert.equal(store.derive(selectionSize), 0);
  assert.equal(runs, 1, 'other slices do not invalidate it');

  store.setSelection([ROOT, ORDER]);
  assert.equal(store.derive(selectionSize), 2);
  assert.equal(store.derive(selectionSize), 2);
  assert.equal(runs, 2);
});

test('each store has its own selector cache, and a selector sees the previous result', () => {
  const first = loadedStore().store;
  const second = loadedStore().store;
  const seen: Array<number | undefined> = [];
  const hoverCount = defineSelector<number>('test.hoverCount', Slice.Hover, (state, previous) => {
    seen.push(previous);
    return (previous ?? 0) + (state.hover?.ids.size ?? 0);
  });

  first.setHover([ROOT]);
  assert.equal(first.derive(hoverCount), 1);
  first.setHover([ROOT, ORDER]);
  assert.equal(first.derive(hoverCount), 3);
  assert.equal(second.derive(hoverCount), 0);
  assert.deepEqual(seen, [undefined, 1, undefined]);
});

test('a selector depending on the data is recomputed when the data changes', () => {
  const { store } = loadedStore();
  const spanCount = defineSelector<number>('test.spanCount', Slice.Data, (state) => state.data.index.size);

  assert.equal(store.derive(spanCount), 12);
  store.setData(demoLogsIndex());
  assert.equal(store.derive(spanCount), 94);
});

test('the shared selectors', () => {
  const { store } = loadedStore();
  const index = store.state.data.index;

  const initial = store.derive(matchSummary);
  assert.deepEqual(initial, { total: 12, matched: 12, filtered: false });

  store.setSelection([STRIPE]);
  assert.equal(store.derive(matchSummary), initial, 'unrelated changes keep the same object');

  const mask = matchSpans(index, [{
    config: {
      field: 'serviceName', label: '', type: 'dropdown', source: 'local', target: 'span', required: false,
      options: [], optionsSource: 'static', placeholder: '', debounce: 0, width: 0, autoRange: false,
    },
    value: 'payment-service',
  }]);
  store.setMatched(mask);
  assert.deepEqual(store.derive(matchSummary), { total: 12, matched: 3, filtered: true });

  assert.equal(store.derive(selectedSpan)?.spanId, STRIPE);
  assert.equal(store.derive(hoveredSpan), null);
  store.setHover([SHIPPING]);
  assert.equal(store.derive(hoveredSpan)?.span.name, 'ShippingService.createShipment');
  store.setSelection([]);
  assert.equal(store.derive(selectedSpan), null);
});

test('stores are independent of each other', () => {
  const a: TraceStore = loadedStore().store;
  const b: TraceStore = loadedStore().store;
  a.setSelection([ROOT]);
  assert.equal(b.state.selection.ids.size, 0);
});
