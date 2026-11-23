/**
 * Keyboard movement in the view tab list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabAfterKey } from '../../src/shell/view-tabs-model.ts';

const IDS = ['waterfall', 'service', 'flame'];

test('the arrows move to the neighbour and wrap around', () => {
  assert.equal(tabAfterKey(IDS, 'waterfall', 'ArrowRight'), 'service');
  assert.equal(tabAfterKey(IDS, 'flame', 'ArrowRight'), 'waterfall');
  assert.equal(tabAfterKey(IDS, 'waterfall', 'ArrowLeft'), 'flame');
  assert.equal(tabAfterKey(IDS, 'service', 'ArrowLeft'), 'waterfall');
});

test('Home and End jump to the ends', () => {
  assert.equal(tabAfterKey(IDS, 'service', 'Home'), 'waterfall');
  assert.equal(tabAfterKey(IDS, 'service', 'End'), 'flame');
});

test('other keys, an unknown tab and a single tab go nowhere', () => {
  assert.equal(tabAfterKey(IDS, 'waterfall', 'Enter'), null);
  assert.equal(tabAfterKey(IDS, 'missing', 'ArrowRight'), null);
  assert.equal(tabAfterKey(['only'], 'only', 'ArrowRight'), null);
});
