/**
 * The model of the inspector: the store state as text, through one selector.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Slice, createTraceStore } from '../../../src/core.ts';
import { MAX_LISTED, describeState, inspectorModel } from '../../../src/views/inspector/model.ts';
import { demoOtelIndex } from '../../support/demo-data.ts';

const rowOf = (model: ReturnType<typeof describeState>, id: string): string => model.rows.find((row) => row.id === id)?.value ?? '';

test('an empty store says so', () => {
  const store = createTraceStore();
  const model = describeState(store.state);
  assert.equal(rowOf(model, 'phase'), 'empty');
  assert.equal(rowOf(model, 'selection'), 'none');
  assert.equal(rowOf(model, 'hover'), 'none');
  assert.equal(rowOf(model, 'filter'), 'off');
  assert.equal(rowOf(model, 'window'), 'whole trace');
  assert.deepEqual(model.selected, []);
  assert.equal(model.selectedTotal, 0);
});

test('loaded data, a selection and a hover show in the rows', () => {
  const store = createTraceStore();
  const index = demoOtelIndex();
  store.setData(index);
  store.setPhase('ready');
  const [first, second] = [...index.spans.keys()];
  store.setSelection([first, second], { origin: 'waterfall-1', primary: first });
  store.setHover([second], { origin: 'inspector-1' });
  store.flushSync();

  const model = describeState(store.state);
  assert.equal(rowOf(model, 'phase'), 'ready');
  assert.match(rowOf(model, 'spans'), /^12 in 1 tree$/);
  assert.match(rowOf(model, 'selection'), /^2 spans: .+ \(from waterfall-1\)$/);
  assert.match(rowOf(model, 'hover'), /^1 span\b.* \(from inspector-1\)$/);
  assert.equal(model.selected.length, 2);
  assert.equal(model.selectedTotal, 2);
});

test('the list is capped and the total still counts every selected span', () => {
  const store = createTraceStore();
  const index = demoOtelIndex();
  store.setData(index);
  store.setSelection([...index.spans.keys()]);
  store.flushSync();
  const model = describeState(store.state);
  assert.equal(model.selected.length, Math.min(MAX_LISTED, index.size));
  assert.equal(model.selectedTotal, index.size);
});

test('the list key changes with the selection and not with a hover', () => {
  const store = createTraceStore();
  const index = demoOtelIndex();
  store.setData(index);
  const [first, second] = [...index.spans.keys()];
  store.setSelection([first]);
  store.flushSync();
  const before = describeState(store.state).selectedKey;

  store.setHover([second]);
  store.flushSync();
  assert.equal(describeState(store.state).selectedKey, before, 'a hover must not rebuild the list under the pointer');

  store.setSelection([second]);
  store.flushSync();
  assert.notEqual(describeState(store.state).selectedKey, before);
});

test('collapse and window appear in the rows', () => {
  const store = createTraceStore();
  store.setData(demoOtelIndex());
  store.collapseAll();
  store.setWindow({ t0: 10, t1: 250.55 });
  store.flushSync();
  const model = describeState(store.state);
  assert.match(rowOf(model, 'collapsed'), /^\d+ spans?$/);
  assert.notEqual(rowOf(model, 'collapsed'), '0 spans');
  assert.equal(rowOf(model, 'window'), '10.0 to 250.6 ms');
});

test('the selector is cached until a slice it shows changes', () => {
  const store = createTraceStore();
  store.setData(demoOtelIndex());
  store.flushSync();
  const first = store.derive(inspectorModel);
  assert.equal(store.derive(inspectorModel), first, 'no change, same object');

  store.touch(Slice.Config); // the inspector shows nothing of the configuration
  store.flushSync();
  assert.equal(store.derive(inspectorModel), first);

  store.setHover([[...store.state.data.index.spans.keys()][0]]);
  store.flushSync();
  assert.notEqual(store.derive(inspectorModel), first);
});
