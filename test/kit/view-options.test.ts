/**
 * The readers a view uses on the options of the element: wrong types and unknown values read as unset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceOption, flagOption, numberOption, type ViewOptions } from '../../src/kit/view-options.ts';

function options(
  config: Record<string, unknown>,
  attributes: Record<string, string> = {},
  viewAttributes?: Record<string, string>,
): ViewOptions {
  const base: ViewOptions = { config, attribute: (name) => attributes[name] ?? null };
  return viewAttributes === undefined
    ? base
    : { ...base, viewAttribute: (name) => viewAttributes[name] ?? null };
}

test('numberOption takes finite numbers only', () => {
  const o = options({ a: 12, zero: 0, text: '12', nan: Number.NaN, inf: Infinity, nothing: undefined });
  assert.equal(numberOption(o, 'a'), 12);
  assert.equal(numberOption(o, 'zero'), 0);
  for (const key of ['text', 'nan', 'inf', 'nothing', 'missing']) assert.equal(numberOption(o, key), undefined, key);
});

test('numberOption prefers a finite child viewAttribute over config and falls back when invalid or absent', () => {
  assert.equal(numberOption(options({ spanHeight: 20 }, {}, { 'span-height': '32' }), 'spanHeight', 'span-height'), 32);
  assert.equal(numberOption(options({ spanHeight: 20 }, {}, { 'span-height': 'nope' }), 'spanHeight', 'span-height'), 20);
  assert.equal(numberOption(options({ spanHeight: 20 }, {}, { 'span-height': '   ' }), 'spanHeight', 'span-height'), 20);
  assert.equal(numberOption(options({ spanHeight: 20 }, {}), 'spanHeight', 'span-height'), 20);
});

test('flagOption is true for a present attribute whatever its value, with viewAttribute taking precedence', () => {
  const o = options({}, { 'wheel-zoom': '', other: 'false' });
  assert.equal(flagOption(o, 'wheel-zoom'), true);
  assert.equal(flagOption(o, 'other'), true);
  assert.equal(flagOption(o, 'absent'), false);

  assert.equal(flagOption(options({}, { 'wheel-zoom': '' }, { 'wheel-zoom': 'false' }), 'wheel-zoom'), false);
  assert.equal(flagOption(options({}, {}, { 'wheel-zoom': '' }), 'wheel-zoom'), true);
});

test('choiceOption takes a listed value and nothing else, preferring viewAttribute over the element', () => {
  const o = options({}, { mode: 'full', bad: 'auto' });
  assert.equal(choiceOption(o, 'mode', ['compact', 'full']), 'full');
  assert.equal(choiceOption(o, 'bad', ['compact', 'full']), undefined);
  assert.equal(choiceOption(o, 'absent', ['compact', 'full']), undefined);
  assert.equal(choiceOption(o, 'mode', ['compact']), undefined);

  assert.equal(choiceOption(options({}, { mode: 'compact' }, { mode: 'full' }), 'mode', ['compact', 'full']), 'full');
  assert.equal(choiceOption(options({}, { mode: 'compact' }, { mode: 'auto' }), 'mode', ['compact', 'full']), 'compact');
});
