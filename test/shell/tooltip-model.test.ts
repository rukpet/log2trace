/**
 * Where a tooltip goes: next to the anchor, flipped when it would leave the container.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeTooltip, TOOLTIP_GAP } from '../../src/shell/tooltip-model.ts';

const container = { width: 400, height: 300 };
const size = { width: 100, height: 60 };

test('the tooltip sits to the right of and below the anchor', () => {
  const place = placeTooltip({ x: 10, y: 20, w: 50, h: 20 }, size, container);
  assert.deepEqual(place, { x: 10 + 50 + TOOLTIP_GAP, y: 20 + 20 + TOOLTIP_GAP });
});

test('it flips to the left when the right side would leave the container', () => {
  const place = placeTooltip({ x: 330, y: 20, w: 50, h: 20 }, size, container);
  assert.equal(place.x, 330 - size.width - TOOLTIP_GAP);
  assert.equal(place.y, 20 + 20 + TOOLTIP_GAP);
});

test('it flips above when the bottom would leave the container', () => {
  const place = placeTooltip({ x: 10, y: 270, w: 50, h: 20 }, size, container);
  assert.equal(place.x, 10 + 50 + TOOLTIP_GAP);
  assert.equal(place.y, 270 - size.height - TOOLTIP_GAP);
});

test('it never goes to negative coordinates, even in a container too small for it', () => {
  const place = placeTooltip({ x: 5, y: 5, w: 10, h: 10 }, { width: 500, height: 500 }, { width: 100, height: 100 });
  assert.deepEqual(place, { x: 0, y: 0 });
});

test('an unknown size (not measured yet) places the box at the anchor corner', () => {
  const place = placeTooltip({ x: 10, y: 20, w: 50, h: 20 }, { width: 0, height: 0 }, container);
  assert.deepEqual(place, { x: 68, y: 48 });
});

test('positions are whole pixels', () => {
  const place = placeTooltip({ x: 10.4, y: 20.6, w: 50.2, h: 20.3 }, size, container);
  assert.ok(Number.isInteger(place.x) && Number.isInteger(place.y));
});
