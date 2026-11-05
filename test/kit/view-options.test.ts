/**
 * The readers a view uses on the options of the element: wrong types and unknown values read as unset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceOption, flagOption, numberOption, type ViewOptions } from '../../src/kit/view-options.ts';

function options(config: Record<string, unknown>, attributes: Record<string, string> = {}): ViewOptions {
  return { config, attribute: (name) => attributes[name] ?? null };
}

test('numberOption takes finite numbers only', () => {
  const o = options({ a: 12, zero: 0, text: '12', nan: Number.NaN, inf: Infinity, nothing: undefined });
  assert.equal(numberOption(o, 'a'), 12);
  assert.equal(numberOption(o, 'zero'), 0);
  for (const key of ['text', 'nan', 'inf', 'nothing', 'missing']) assert.equal(numberOption(o, key), undefined, key);
});

test('flagOption is true for a present attribute whatever its value', () => {
  const o = options({}, { 'wheel-zoom': '', other: 'false' });
  assert.equal(flagOption(o, 'wheel-zoom'), true);
  assert.equal(flagOption(o, 'other'), true);
  assert.equal(flagOption(o, 'absent'), false);
});

test('choiceOption takes a listed value and nothing else', () => {
  const o = options({}, { renderer: 'canvas', bad: 'svg' });
  assert.equal(choiceOption(o, 'renderer', ['dom', 'canvas']), 'canvas');
  assert.equal(choiceOption(o, 'bad', ['dom', 'canvas']), undefined);
  assert.equal(choiceOption(o, 'absent', ['dom', 'canvas']), undefined);
  assert.equal(choiceOption(o, 'renderer', ['dom']), undefined);
});
