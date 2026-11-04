/**
 * Hit testing: the row, bar, event marker and chevron under a point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, pxPerMs, withWindow } from '../../../src/kit/geometry/camera1d.ts';
import {
  BAR_TOLERANCE,
  EVENT_ANCHOR_WIDTH,
  EVENT_TOLERANCE,
  HitPart,
  createHitResult,
  hitTest,
  type HitInput,
  type HitResult,
} from '../../../src/views/waterfall/model/hit.ts';
import { CHEVRON_SIZE, chevronX } from '../../../src/views/waterfall/model/layout.ts';
import { random, span, trace, treeTrace, type TreeNode } from '../../support/trace-builder.ts';
import { scene, type Scene } from '../../support/waterfall-scene.ts';

//   r [0, 1000]  events at 0, 500, 1000          row 0, y 40..75
//   ├ a [100, 400]  four events                    row 1, y 75..110
//   ├ b [450, 455]  a thin bar                     row 2, y 110..145
//   └ c [900, 1000]                                row 3, y 145..180
const TREE: TreeNode = {
  id: 'r', start: 0, end: 1000, events: [0, 500, 1000], children: [
    { id: 'a', start: 100, end: 400, events: [150, 160, 170, 380] },
    { id: 'b', start: 450, end: 455 },
    { id: 'c', start: 900, end: 1000 },
  ],
};
const SCALE = 726 / 1000;
const PLOT_LEFT = 250;

function input(s: Scene, scrollTop = 0, camera = s.camera): HitInput {
  return { index: s.index, projection: s.projection, collapsed: s.collapsed, layout: s.layout, camera, scrollTop };
}

function hit(s: Scene, x: number, y: number, scrollTop = 0, camera = s.camera): HitResult {
  return hitTest(input(s, scrollTop, camera), x, y, createHitResult());
}

function box(result: HitResult): number[] {
  return [result.x, result.y, result.w, result.h].map((value) => Math.round(value * 100) / 100);
}

test('nothing is hit in the ruler, below the last row, or outside the view', () => {
  const s = scene(treeTrace(TREE));

  for (const [x, y] of [[300, 10], [300, 39.9], [300, 180], [300, 590], [-1, 60], [1000, 60], [Number.NaN, 60], [300, Number.NaN]]) {
    const result = hit(s, x, y);
    assert.equal(result.part, HitPart.None, `${x}, ${y}`);
    assert.equal(result.row, -1);
    assert.equal(result.span, -1);
    assert.equal(result.event, -1);
  }
});

test('rows are found by their y, with the scroll position taken into account', () => {
  const s = scene(treeTrace(TREE));

  assert.equal(hit(s, 100, 40).row, 0);
  assert.equal(hit(s, 100, 74.9).row, 0);
  assert.equal(hit(s, 100, 75).row, 1);
  assert.equal(hit(s, 100, 179.9).row, 3);
  assert.equal(hit(s, 100, 75).span, 1, 'the table row of the span');

  const many = scene(trace(['svc', Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i, i + 1))]));
  assert.equal(hit(many, 100, 40, 35 * 20).row, 20);
  assert.equal(hit(many, 100, 50, 35 * 20 + 10).row, 20, 'scrolled to the middle of a row');
  assert.equal(hit(many, 100, 40, 1e9).row, 100 - 16, 'scrolled to the end, the last screen of rows');
});

test('the gutter: a chevron where there are children on show, a label otherwise', () => {
  const s = scene(treeTrace(TREE));

  const chevron = hit(s, 10, 50);
  assert.equal(chevron.part, HitPart.Chevron);
  assert.deepEqual(box(chevron), [8, 40 + (35 - CHEVRON_SIZE) / 2, CHEVRON_SIZE, CHEVRON_SIZE]);
  assert.equal(hit(s, 7.9, 50).part, HitPart.Label, 'just left of the box');
  assert.equal(hit(s, 8 + CHEVRON_SIZE, 50).part, HitPart.Label, 'just right of the box');

  const label = hit(s, 120, 50);
  assert.equal(label.part, HitPart.Label);
  assert.deepEqual(box(label), [0, 40, 250, 35]);

  const childChevronX = chevronX(s.layout, 1) + 2;
  assert.equal(hit(s, childChevronX, 90).part, HitPart.Label, 'a leaf has no chevron to hit');
  assert.equal(hit(s, 10, 90).part, HitPart.Label);
});

test('a collapsed span has a chevron; a span whose children the filter removed does not', () => {
  assert.equal(hit(scene(treeTrace(TREE), { collapsed: ['r'] }), 10, 50).part, HitPart.Chevron);
  assert.equal(hit(scene(treeTrace(TREE), { matched: ['r'] }), 10, 50).part, HitPart.Label);
});

test('a bar is hit on its extent and up to the tolerance beside it', () => {
  const s = scene(treeTrace(TREE));

  const whole = hit(s, PLOT_LEFT + 300, 60);
  assert.equal(whole.part, HitPart.Bar);
  assert.deepEqual(box(whole), [250, 42.5, 726, 30]);

  const left = 450 * SCALE; // b: 326.7 .. 330.33
  const right = 455 * SCALE;
  assert.equal(hit(s, PLOT_LEFT + left - BAR_TOLERANCE + 0.2, 125).part, HitPart.Bar);
  assert.equal(hit(s, PLOT_LEFT + left - BAR_TOLERANCE - 0.2, 125).part, HitPart.Row);
  assert.equal(hit(s, PLOT_LEFT + right + BAR_TOLERANCE - 0.2, 125).part, HitPart.Bar);
  assert.equal(hit(s, PLOT_LEFT + right + BAR_TOLERANCE + 0.2, 125).part, HitPart.Row);

  const row = hit(s, PLOT_LEFT + 600, 125);
  assert.equal(row.part, HitPart.Row);
  assert.equal(row.span, 2, 'the row is still reported');
  assert.deepEqual(box(row), [0, 110, 1000, 35]);
});

test('a bar thinner than a pixel is still hit, as the two-pixel bar that is drawn', () => {
  const s = scene(treeTrace([{ id: 'r', start: 0, end: 1000 }, { id: 'dot', start: 500, end: 500.05 }]));
  const x = PLOT_LEFT + 500 * SCALE;

  assert.equal(hit(s, x + 1.9, 110 - 20).part, HitPart.Bar);
  assert.equal(hit(s, x + 2 + BAR_TOLERANCE - 0.1, 110 - 20).part, HitPart.Bar);
  assert.equal(hit(s, x + 2 + BAR_TOLERANCE + 0.1, 110 - 20).part, HitPart.Row);
});

test('a bar outside the window cannot be hit', () => {
  const s = scene(treeTrace(TREE));
  const early = withWindow(createCamera(1000, s.layout.plotWidth), 0, 100);

  assert.equal(hit(s, PLOT_LEFT + 300, 180 - 20, 0, early).part, HitPart.Row, 'c starts at 900 ms');
  assert.equal(hit(s, PLOT_LEFT + 300, 180 - 20, 0, early).span, 3);
});

test('an event marker is hit within the tolerance, and only inside the bar vertically', () => {
  const s = scene(treeTrace(TREE));
  const table = s.index.table;
  const marker = (ms: number): number => PLOT_LEFT + ms * SCALE; // a: events at 150, 160, 170, 380
  const barMiddle = 75 + 2.5 + 15;

  const result = hit(s, marker(150), barMiddle);
  assert.equal(result.part, HitPart.Event);
  assert.equal(table.evT[result.event], 150);
  assert.deepEqual(box(result), [Math.round((marker(150) - EVENT_ANCHOR_WIDTH / 2) * 100) / 100, 77.5, EVENT_ANCHOR_WIDTH, 30]);

  assert.equal(hit(s, marker(150) + EVENT_TOLERANCE - 0.1, barMiddle).part, HitPart.Event);
  assert.equal(hit(s, marker(150) + EVENT_TOLERANCE + 0.1 - 0.0, barMiddle).part, HitPart.Bar, 'between 150 and 160, out of reach of both');

  assert.equal(hit(s, marker(165), barMiddle).part, HitPart.Bar, 'halfway between two markers 7 px apart: out of reach of both');
  assert.equal(table.evT[hit(s, marker(168), barMiddle).event], 170, 'the nearer marker wins');
  assert.equal(table.evT[hit(s, marker(162), barMiddle).event], 160);

  assert.equal(hit(s, marker(150), 75 + 1).part, HitPart.Bar, 'in the gap above the bar');
  assert.equal(hit(s, marker(150), 75 + 2.5 + 30 + 1).part, HitPart.Bar, 'in the gap below the bar');
});

test('events of a bar too thin to show markers cannot be hit', () => {
  const s = scene(treeTrace([
    { id: 'r', start: 0, end: 1000 },
    { id: 'thin', start: 450, end: 452, events: [451] },
  ]));
  const result = hit(s, PLOT_LEFT + 451 * SCALE, 75 + 17.5);
  assert.equal(result.part, HitPart.Bar);
  assert.equal(result.event, -1);
});

test('the nearest event matches a brute-force search, on random data', () => {
  for (const seed of [31, 32, 33, 34]) {
    const next = random(seed);
    const times = Array.from({ length: 1 + Math.floor(next() * 400) }, () => next() * 1000).sort((a, b) => a - b);
    const s = scene(treeTrace({ id: 'only', start: 0, end: 1000, events: times }));
    const table = s.index.table;

    for (let trial = 0; trial < 300; trial++) {
      const width = 5 + next() * 995;
      const t0 = next() * (1000 - width);
      const camera = withWindow(createCamera(1000, s.layout.plotWidth), t0, t0 + width);
      const px = next() * s.layout.plotWidth;
      const scale = pxPerMs(camera);

      let expected = -1;
      let best = EVENT_TOLERANCE + 1;
      for (let k = 0; k < times.length; k++) {
        const distance = Math.abs((table.evT[k] - camera.t0) * scale - px);
        if (distance <= EVENT_TOLERANCE && distance < best) {
          best = distance;
          expected = k;
        }
      }

      const result = hit(s, PLOT_LEFT + px, 40 + 2.5 + 15, 0, camera);
      if (result.part === HitPart.Event) {
        assert.ok(expected >= 0, `seed ${seed}: hit an event where a search found none`);
        assert.ok(
          Math.abs((table.evT[result.event] - camera.t0) * scale - px) <= best + 1e-9,
          `seed ${seed}: an event was hit, but not the nearest`,
        );
      } else if (expected >= 0) {
        // the search found an event in reach, so only a bar that is too thin to show markers may hide it
        assert.ok(scale * (table.end[0] - table.start[0]) < 6 || px > 1e9, `seed ${seed}: an event in reach was missed`);
      }
    }
  }
});

test('the result object is reused and fully reset between calls', () => {
  const s = scene(treeTrace(TREE));
  const out = createHitResult();

  const first = hitTest(input(s), PLOT_LEFT + 150 * SCALE, 75 + 17.5, out);
  assert.equal(first, out);
  assert.equal(out.part, HitPart.Event);

  hitTest(input(s), 5, 5, out);
  assert.deepEqual(out, createHitResult());
});

test('a rowless trace has nothing to hit', () => {
  const s = scene(trace(['svc', []]));
  assert.equal(hit(s, 300, 60).part, HitPart.None);
});
