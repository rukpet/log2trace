/**
 * The view registry and the helpers that resolve `<trace-view>` declarations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getView, listViews, registerView, resolveViews, type TraceView, type ViewDefinition } from '../../src/kit/view.ts';

function definition(id: string): ViewDefinition {
  return { id, label: id.toUpperCase(), capabilities: {}, create: () => ({}) as TraceView };
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

test('resolveViews keeps known types once in document order, overrides labels, and picks the active tab', () => {
  const known = [definition('waterfall'), definition('flame'), definition('service')];
  assert.deepEqual(
    resolveViews(
      [
        { type: 'flame', active: false },
        { type: 'unknown', active: true },
        { type: 'waterfall', label: 'Timeline', active: false },
        { type: 'flame', label: 'Duplicate', active: true },
        { type: 'service', active: true },
      ],
      known,
    ),
    {
      tabs: [
        { id: 'flame', label: 'FLAME' },
        { id: 'waterfall', label: 'Timeline' },
        { id: 'service', label: 'SERVICE' },
      ],
      initial: 'service',
    },
  );
  assert.deepEqual(
    resolveViews(
      [
        { type: 'service', active: false },
        { type: 'flame', active: true },
        { type: 'waterfall', active: true },
      ],
      known,
    ),
    {
      tabs: [
        { id: 'service', label: 'SERVICE' },
        { id: 'flame', label: 'FLAME' },
        { id: 'waterfall', label: 'WATERFALL' },
      ],
      initial: 'flame',
    },
    'first active declaration wins',
  );
  assert.deepEqual(
    resolveViews([{ type: 'service', active: false }, { type: 'flame', active: false }], known),
    {
      tabs: [
        { id: 'service', label: 'SERVICE' },
        { id: 'flame', label: 'FLAME' },
      ],
      initial: 'service',
    },
    'defaults to the first tab when none is marked active',
  );
});

test('resolveViews falls back to waterfall, then the first known view, or empty when none are registered', () => {
  const withWaterfall = [definition('flame'), definition('waterfall')];
  assert.deepEqual(resolveViews([], withWaterfall), { tabs: [{ id: 'waterfall', label: 'WATERFALL' }], initial: 'waterfall' });
  assert.deepEqual(resolveViews([{ type: 'nope', active: true }], withWaterfall), { tabs: [{ id: 'waterfall', label: 'WATERFALL' }], initial: 'waterfall' });

  const withoutWaterfall = [definition('flame'), definition('service')];
  assert.deepEqual(resolveViews([], withoutWaterfall), { tabs: [{ id: 'flame', label: 'FLAME' }], initial: 'flame' });
  assert.deepEqual(resolveViews([], []), { tabs: [], initial: '' });
});
