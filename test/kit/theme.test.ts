/**
 * Theme token tables and CSS variable helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  KIND_TOKENS,
  cssVariableName,
  tokenRecord,
} from '../../src/kit/theme/theme.ts';

test('the token tables have no duplicates and the kinds are six', () => {
  assert.equal(new Set(COLOR_TOKENS).size, COLOR_TOKENS.length);
  assert.equal(new Set(FONT_TOKENS).size, FONT_TOKENS.length);
  assert.equal(KIND_TOKENS.length, 6);
  for (const token of KIND_TOKENS) assert.ok(COLOR_TOKENS.includes(token));
});

test('cssVariableName extracts the custom property name from a var() reference', () => {
  assert.equal(cssVariableName('var(--l2t-text)'), '--l2t-text');
  assert.equal(cssVariableName('var(--foo, #000)'), '--foo');
  assert.throws(() => cssVariableName('#000'));
});

test('tokenRecord builds an entry for every key', () => {
  assert.deepEqual(tokenRecord(FONT_TOKENS, (token) => `font:${token}`), {
    sans: 'font:sans',
    mono: 'font:mono',
  });
});
