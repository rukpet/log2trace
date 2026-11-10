/**
 * The view registry and the helpers that read the `views` attribute.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getView, listViews, parseViewIds, registerView, resolveRenderer, type TraceView, type ViewDefinition } from '../../src/kit/view.ts';

function definition(id: string, renderers: ViewDefinition['renderers'] = ['dom']): ViewDefinition {
  return { id, label: id.toUpperCase(), renderers, capabilities: {}, create: () => ({}) as TraceView };
}

test('a registered view is found by its id and listed once, in registration order', () => {
  registerView(definition('alpha-test'));
  registerView(definition('beta-test'));
  assert.equal(getView('alpha-test')?.label, 'ALPHA-TEST');
  assert.equal(getView('missing-test'), undefined);

  const ids = listViews().map((view) => view.id);
  assert.ok(ids.indexOf('alpha-test') < ids.indexOf('beta-test'));
  assert.equal(ids.filter((id) => id === 'alpha-test').length, 1);
});

test('registering an id again replaces the definition without moving it', () => {
  registerView(definition('gamma-test'));
  registerView(definition('delta-test'));
  registerView({ ...definition('gamma-test'), label: 'Replaced' });
  assert.equal(getView('gamma-test')?.label, 'Replaced');
  const ids = listViews().map((view) => view.id);
  assert.ok(ids.indexOf('gamma-test') < ids.indexOf('delta-test'));
});

test('resolveRenderer takes the one asked for when the view has it, else the default', () => {
  assert.equal(resolveRenderer('canvas', ['dom', 'canvas']), 'canvas');
  assert.equal(resolveRenderer(undefined, ['dom', 'canvas']), 'dom');
  assert.equal(resolveRenderer('canvas', ['dom']), 'dom', 'a view without a canvas backend ignores the request');
});

test('parseViewIds keeps the known ids once, in the order given', () => {
  const known = ['waterfall', 'sequence', 'flame'];
  assert.deepEqual(parseViewIds('sequence, waterfall', known), ['sequence', 'waterfall']);
  assert.deepEqual(parseViewIds('waterfall,waterfall,flame', known), ['waterfall', 'flame']);
  assert.deepEqual(parseViewIds(' waterfall ,, sequence ', known), ['waterfall', 'sequence']);
});

test('parseViewIds falls back to the first registered view when nothing usable is asked for', () => {
  const known = ['waterfall', 'sequence'];
  assert.deepEqual(parseViewIds(null, known), ['waterfall']);
  assert.deepEqual(parseViewIds('', known), ['waterfall']);
  assert.deepEqual(parseViewIds('nope,also-nope', known), ['waterfall']);
});
