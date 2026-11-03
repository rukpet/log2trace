/**
 * Virtual list windowing: the visible range and overscan (against a brute-force
 * reference), the boundaries (first and last row, empty list, overscroll), reveal
 * with `nearest` and `center`, and keeping a row at the same screen y after the
 * row list changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScrollTop,
  ensureRowVisible,
  keepRowAtSameY,
  maxScrollTop,
  visibleRange,
  type ListMetrics,
  type RowRange,
} from '../../../src/kit/geometry/virtual-list.ts';

function list(rowHeight: number, rowCount: number, viewportHeight: number): ListMetrics {
  return { rowHeight, rowCount, viewportHeight };
}

function count(range: RowRange): number {
  return Math.max(0, range.last - range.first + 1);
}

/** Deterministic PRNG (mulberry32): same seed, same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('visibleRange returns the rows that intersect the viewport', () => {
  const metrics = list(35, 1000, 700); // 20 rows fill the viewport exactly

  assert.deepEqual(visibleRange(metrics, 0), { first: 0, last: 19 });
  assert.deepEqual(visibleRange(metrics, 10), { first: 0, last: 20 }, 'a sliver of row 20 counts');
  assert.deepEqual(visibleRange(metrics, 349), { first: 9, last: 29 }, 'a sliver of row 9 counts');
  assert.deepEqual(visibleRange(metrics, 350), { first: 10, last: 29 }, 'row 9 ends exactly at the viewport top');
  assert.deepEqual(visibleRange(metrics, 34_300), { first: 980, last: 999 }, 'scrolled to the end');
});

test('visibleRange clamps overscroll and ignores a NaN scroll position', () => {
  const metrics = list(35, 1000, 700);
  const atEnd = { first: 980, last: 999 };

  assert.deepEqual(visibleRange(metrics, 1e9), atEnd);
  assert.deepEqual(visibleRange(metrics, Infinity), atEnd);
  assert.deepEqual(visibleRange(metrics, -50), { first: 0, last: 19 }, 'rubber-band above the top');
  assert.deepEqual(visibleRange(metrics, NaN), { first: 0, last: 19 });
});

test('overscan adds rows on both sides and stops at the first and last row', () => {
  const metrics = list(35, 1000, 700);

  assert.deepEqual(visibleRange(metrics, 350, 5), { first: 5, last: 34 });
  assert.deepEqual(visibleRange(metrics, 0, 5), { first: 0, last: 24 });
  assert.deepEqual(visibleRange(metrics, 34_300, 5), { first: 975, last: 999 });
  assert.deepEqual(visibleRange(metrics, 350, 5000), { first: 0, last: 999 });

  assert.deepEqual(visibleRange(metrics, 350, -3), visibleRange(metrics, 350), 'negative overscan is none');
  assert.deepEqual(visibleRange(metrics, 350, 2.9), visibleRange(metrics, 350, 2), 'fractional overscan rounds down');
  assert.deepEqual(visibleRange(metrics, 350, NaN), visibleRange(metrics, 350));
});

test('an empty list or unusable row height renders nothing and always scrolls to 0', () => {
  for (const [what, metrics] of [
    ['no rows', list(35, 0, 700)],
    ['zero row height', list(0, 100, 700)],
    ['negative row height', list(-35, 100, 700)],
    ['NaN row height', list(NaN, 100, 700)],
    ['NaN row count', list(35, NaN, 700)],
  ] as const) {
    for (const scrollTop of [0, 123, -5, NaN, 1e9]) {
      const range = visibleRange(metrics, scrollTop, 5);
      assert.ok(range.last < range.first, `${what} at ${scrollTop}: got ${JSON.stringify(range)}`);
      assert.equal(count(range), 0);
      assert.equal(maxScrollTop(metrics), 0, what);
      assert.equal(clampScrollTop(metrics, scrollTop), 0, what);
      assert.equal(ensureRowVisible(metrics, scrollTop, 3, 'nearest'), 0, what);
      assert.equal(ensureRowVisible(metrics, scrollTop, 3, 'center'), 0, what);
      assert.equal(keepRowAtSameY(metrics, scrollTop, 3, 5), 0, what);
    }
  }
});

test('a viewport without height (a hidden host) renders nothing but keeps the scroll position', () => {
  for (const viewportHeight of [0, -10, NaN]) {
    const metrics = list(35, 100, viewportHeight);
    const range = visibleRange(metrics, 700, 5);
    assert.equal(count(range), 0, `viewport ${viewportHeight}`);

    for (const value of [
      maxScrollTop(metrics),
      clampScrollTop(metrics, 700),
      ensureRowVisible(metrics, 700, 50, 'nearest'),
      ensureRowVisible(metrics, 700, 50, 'center'),
      keepRowAtSameY(metrics, 700, 20, 30),
    ]) {
      assert.ok(Number.isFinite(value), `viewport ${viewportHeight}: got ${value}`);
    }
  }

  // The content is still 3500 px tall, so a hidden tab does not lose where it was scrolled to.
  assert.equal(clampScrollTop(list(35, 100, 0), 700), 700);
});

test('a list shorter than the viewport shows every row and never scrolls', () => {
  const metrics = list(35, 3, 700);

  for (const scrollTop of [0, 20, 500, -1]) {
    assert.deepEqual(visibleRange(metrics, scrollTop), { first: 0, last: 2 });
  }
  assert.equal(maxScrollTop(metrics), 0);
  assert.deepEqual(visibleRange(list(35, 1, 700), 0), { first: 0, last: 0 });

  // A viewport smaller than one row still shows the row under it.
  assert.deepEqual(visibleRange(list(35, 10, 10), 40), { first: 1, last: 1 });
});

test('visibleRange matches a brute-force intersection test on random lists', () => {
  const random = mulberry32(11);
  for (let n = 0; n < 4000; n++) {
    const rowHeight = 8 + Math.floor(random() * 53);
    const rowCount = Math.floor(random() * 400);
    const viewportHeight = 1 + Math.floor(random() * 800);
    const metrics = list(rowHeight, rowCount, viewportHeight);
    const scrollTop = Math.floor(random() * (rowHeight * rowCount + 200)) - 100;
    const overscan = Math.floor(random() * 8);

    // Integer geometry, so the reference is exact: row r covers [r * h, (r + 1) * h).
    const top = Math.min(Math.max(scrollTop, 0), Math.max(0, rowHeight * rowCount - viewportHeight));
    const visible: number[] = [];
    for (let row = 0; row < rowCount; row++) {
      if (row * rowHeight < top + viewportHeight && (row + 1) * rowHeight > top) visible.push(row);
    }

    const range = visibleRange(metrics, scrollTop, overscan);
    const what = `${JSON.stringify(metrics)} at ${scrollTop}, overscan ${overscan}`;
    if (visible.length === 0) {
      assert.equal(count(range), 0, what);
    } else {
      assert.equal(range.first, Math.max(0, visible[0] - overscan), `${what}: first`);
      assert.equal(range.last, Math.min(rowCount - 1, visible[visible.length - 1] + overscan), `${what}: last`);
    }
  }
});

test('maxScrollTop and clampScrollTop keep the scroll position inside the content', () => {
  const metrics = list(35, 1000, 700);

  assert.equal(maxScrollTop(metrics), 34_300);
  assert.equal(maxScrollTop(list(35, 10, 700)), 0, 'everything fits');
  assert.equal(maxScrollTop(list(35, 20, 700)), 0, 'fits exactly');

  assert.equal(clampScrollTop(metrics, 1234.5), 1234.5);
  assert.equal(clampScrollTop(metrics, -5), 0);
  assert.equal(clampScrollTop(metrics, NaN), 0);
  assert.equal(clampScrollTop(metrics, 1e9), 34_300);
  assert.equal(clampScrollTop(list(35, 50, 700), 3500), 1050, 'after the list shrank');
});

test('ensureRowVisible nearest: no move for a fully visible row, minimal move otherwise', () => {
  const metrics = list(35, 1000, 700);
  const scrollTop = 3500; // rows 100..119 are fully visible

  assert.equal(ensureRowVisible(metrics, scrollTop, 100, 'nearest'), 3500, 'first visible row');
  assert.equal(ensureRowVisible(metrics, scrollTop, 110, 'nearest'), 3500);
  assert.equal(ensureRowVisible(metrics, scrollTop, 119, 'nearest'), 3500, 'last visible row');

  assert.equal(ensureRowVisible(metrics, scrollTop, 99, 'nearest'), 3465, 'just above: its top meets the viewport top');
  assert.equal(ensureRowVisible(metrics, scrollTop, 120, 'nearest'), 3535, 'just below: its bottom meets the viewport bottom');
  assert.equal(ensureRowVisible(metrics, scrollTop, 500, 'nearest'), 17_500 + 35 - 700, 'far below');
  assert.equal(ensureRowVisible(metrics, scrollTop, 3, 'nearest'), 105, 'far above');

  // A row cut off by the viewport edge is not "visible": scroll just enough to show it whole.
  assert.equal(ensureRowVisible(metrics, 3510, 120, 'nearest'), 3535, 'partly below');
  assert.equal(ensureRowVisible(metrics, 3510, 100, 'nearest'), 3500, 'partly above');
});

test('ensureRowVisible nearest at the ends of the list and with out-of-range rows', () => {
  const metrics = list(35, 1000, 700);

  assert.equal(ensureRowVisible(metrics, 3500, 0, 'nearest'), 0);
  assert.equal(ensureRowVisible(metrics, 3500, 999, 'nearest'), 34_300);
  assert.equal(ensureRowVisible(metrics, 3500, -5, 'nearest'), 0, 'rows before the first are clamped');
  assert.equal(ensureRowVisible(metrics, 3500, 1e9, 'nearest'), 34_300, 'rows after the last are clamped');
  assert.equal(ensureRowVisible(metrics, 3500, NaN, 'nearest'), 0);
  assert.equal(ensureRowVisible(metrics, 3500, 100.9, 'nearest'), 3500, 'fractional rows round down');

  assert.equal(ensureRowVisible(metrics, 1e9, 999, 'nearest'), 34_300, 'a stale scroll position is clamped first');
  assert.equal(ensureRowVisible(list(35, 10, 700), 0, 9, 'nearest'), 0, 'a short list never scrolls');
});

test('ensureRowVisible nearest aligns a row taller than the viewport to its top', () => {
  const metrics = list(100, 50, 60);

  assert.equal(ensureRowVisible(metrics, 1000, 12, 'nearest'), 1200, 'below');
  assert.equal(ensureRowVisible(metrics, 1000, 5, 'nearest'), 500, 'above');
  assert.equal(ensureRowVisible(metrics, 1000, 10, 'nearest'), 1000, 'already at its top');
});

test('ensureRowVisible center puts the row in the middle, as far as the list allows', () => {
  const metrics = list(35, 1000, 700);

  // Row 500 spans [17500, 17535): its centre 17517.5 minus half the viewport.
  assert.equal(ensureRowVisible(metrics, 0, 500, 'center'), 17_167.5);
  assert.equal(ensureRowVisible(metrics, 17_167.5, 500, 'center'), 17_167.5);

  // Even a visible row is re-centred.
  assert.equal(ensureRowVisible(metrics, 3500, 105, 'center'), 105 * 35 - 332.5);

  assert.equal(ensureRowVisible(metrics, 3500, 0, 'center'), 0, 'first row: clamped at the top');
  assert.equal(ensureRowVisible(metrics, 3500, 5, 'center'), 0);
  assert.equal(ensureRowVisible(metrics, 3500, 999, 'center'), 34_300, 'last row: clamped at the bottom');
  assert.equal(ensureRowVisible(metrics, 3500, 990, 'center'), 34_300);
  assert.equal(ensureRowVisible(metrics, 3500, 5000, 'center'), 34_300, 'out-of-range rows are clamped');
  assert.equal(ensureRowVisible(list(35, 10, 700), 0, 9, 'center'), 0, 'a short list never scrolls');
});

test('ensureRowVisible properties on random lists', () => {
  const random = mulberry32(5);
  for (let n = 0; n < 4000; n++) {
    const rowHeight = 8 + Math.floor(random() * 53);
    const rowCount = 1 + Math.floor(random() * 400);
    const viewportHeight = rowHeight + Math.floor(random() * 800); // at least one row fits
    const metrics = list(rowHeight, rowCount, viewportHeight);
    const max = maxScrollTop(metrics);
    const scrollTop = Math.floor(random() * (max + 200)) - 100;
    const row = Math.floor(random() * rowCount);
    const top = row * rowHeight;
    const bottom = top + rowHeight;
    const current = clampScrollTop(metrics, scrollTop);
    const what = `${JSON.stringify(metrics)} at ${scrollTop}, row ${row}`;

    const nearest = ensureRowVisible(metrics, scrollTop, row, 'nearest');
    assert.ok(nearest >= 0 && nearest <= max, `${what}: nearest ${nearest} outside [0, ${max}]`);
    assert.ok(top >= nearest && bottom <= nearest + viewportHeight, `${what}: row not fully visible at ${nearest}`);
    if (top >= current && bottom <= current + viewportHeight) {
      assert.equal(nearest, current, `${what}: a visible row must not move the view`);
    } else {
      assert.ok(nearest === top || nearest + viewportHeight === bottom, `${what}: not the minimal move (${nearest})`);
    }

    const centred = ensureRowVisible(metrics, scrollTop, row, 'center');
    assert.ok(centred >= 0 && centred <= max, `${what}: centre ${centred} outside [0, ${max}]`);
    const ideal = top + rowHeight / 2 - viewportHeight / 2;
    assert.equal(centred, Math.min(Math.max(ideal, 0), max), `${what}: centre`);
  }
});

test('keepRowAtSameY follows the row when rows are added or removed above it', () => {
  const metrics = list(35, 1000, 700);
  const scrollTop = 3500;
  const fromRow = 105; // on screen at y = 105 * 35 - 3500 = 175

  const expanded = keepRowAtSameY(metrics, scrollTop, fromRow, 112); // 7 rows appeared above it
  assert.equal(expanded, 3745);
  assert.equal(112 * 35 - expanded, 175);

  const collapsed = keepRowAtSameY(metrics, scrollTop, fromRow, 98); // 7 rows disappeared above it
  assert.equal(collapsed, 3255);
  assert.equal(98 * 35 - collapsed, 175);

  assert.equal(keepRowAtSameY(metrics, scrollTop, fromRow, fromRow), scrollTop, 'the row did not move');

  // A partly scrolled first row keeps its sub-row offset.
  assert.equal(keepRowAtSameY(metrics, 3510, 100, 107), 3510 + 7 * 35);
});

test('keepRowAtSameY settles for the nearest position when the scroll range does not allow it', () => {
  const metrics = list(35, 1000, 700);

  // Row 105 was at y = 175; row 3 would need a negative scroll position.
  assert.equal(keepRowAtSameY(metrics, 3500, 105, 3), 0);
  // The list shrank to 50 rows (max scroll 1050) and the row is now near its end.
  assert.equal(keepRowAtSameY(list(35, 50, 700), 3500, 105, 48), 1050);
  assert.equal(keepRowAtSameY(list(35, 15, 700), 3500, 105, 10), 0, 'everything fits now');
});

test('keepRowAtSameY with a row that is gone only clamps', () => {
  const metrics = list(35, 50, 700); // max scroll 1050

  assert.equal(keepRowAtSameY(metrics, 800, 20, -1), 800);
  assert.equal(keepRowAtSameY(metrics, 3500, 20, -1), 1050);
  assert.equal(keepRowAtSameY(metrics, 3500, NaN, 4), 1050);
  assert.equal(keepRowAtSameY(metrics, 3500, 20, NaN), 1050);
});

test('keepRowAtSameY keeps the screen y whenever the result is not clamped', () => {
  const random = mulberry32(9);
  for (let n = 0; n < 4000; n++) {
    const rowHeight = 8 + Math.floor(random() * 53);
    const rowCount = 20 + Math.floor(random() * 400);
    const viewportHeight = rowHeight + Math.floor(random() * 600);
    const metrics = list(rowHeight, rowCount, viewportHeight);
    const scrollTop = Math.floor(random() * (maxScrollTop(metrics) + 1));
    const fromRow = Math.floor(random() * rowCount);
    const toRow = Math.floor(random() * rowCount);

    const result = keepRowAtSameY(metrics, scrollTop, fromRow, toRow);
    const wanted = scrollTop + (toRow - fromRow) * rowHeight;
    const what = `${JSON.stringify(metrics)} at ${scrollTop}, row ${fromRow} -> ${toRow}`;

    assert.ok(result >= 0 && result <= maxScrollTop(metrics), `${what}: ${result} out of range`);
    if (wanted >= 0 && wanted <= maxScrollTop(metrics)) {
      assert.equal(toRow * rowHeight - result, fromRow * rowHeight - scrollTop, `${what}: screen y changed`);
    }
  }
});
