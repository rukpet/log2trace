/**
 * The DOM painter against a fake DOM: the pool of rows, what each row shows, and what a change
 * of scroll, camera, selection and hover rewrites.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, createTraceStore, type TraceStore } from '../../../src/core.ts';
import { createTextMeter } from '../../../src/kit/canvas/text-cache.ts';
import { createFrameScheduler, type FrameScheduler } from '../../../src/kit/scheduler.ts';
import { COLOR_TOKENS, KIND_TOKENS, type ColorToken, type ResolvedTheme } from '../../../src/kit/theme/theme.ts';
import { WaterfallController } from '../../../src/views/waterfall/controller.ts';
import { WaterfallDirty } from '../../../src/views/waterfall/model/interaction.ts';
import { createDomPainter, type DomClasses } from '../../../src/views/waterfall/paint/dom.ts';
import type { WaterfallPainter } from '../../../src/views/waterfall/paint/painter.ts';
import { createFakeClock, type FakeClock } from '../../support/fake-frame.ts';
import { FakeElement, FakeResizeObserver, installFakeDom } from '../../support/fake-dom-tree.ts';
import { treeTrace, type TreeNode } from '../../support/trace-builder.ts';

let restore: () => void;
before(() => {
  restore = installFakeDom();
});
after(() => restore());

/** Class names that spell what they are: `styles.rowHover` is `'rowHover'`, `styles.kind.server` is `'kind.server'`. */
function fakeClasses(): DomClasses {
  const group = (prefix: string): unknown =>
    new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? `${prefix}.${key}` : undefined) });
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined;
      if (key === 'kind' || key === 'chevronState') return group(key);
      return key.endsWith('Var') ? `var(--${key})` : key;
    },
  }) as DomClasses;
}

const theme: ResolvedTheme = (() => {
  const colors = {} as Record<ColorToken, string>;
  for (const token of COLOR_TOKENS) colors[token] = `color:${token}`;
  return { colors, fonts: { sans: 'Test Sans', mono: 'Test Mono' }, kindColors: KIND_TOKENS.map((token) => colors[token]), dark: false };
})();

interface Rig {
  readonly store: TraceStore;
  readonly controller: WaterfallController;
  readonly painter: WaterfallPainter;
  readonly host: FakeElement;
  readonly clock: FakeClock;
  readonly scheduler: FrameScheduler;
  /** Resize the host and draw the frame that follows. */
  size(width: number, height: number): void;
  /** Tell the painter what changed and draw the frame. */
  draw(bits: number): void;
  layer(): FakeElement;
  /** The rows that are shown (not hidden), as `name` texts in top-to-bottom order. */
  shownNames(): string[];
  rows(): FakeElement[];
}

function rig(tree: TreeNode, width = 1000, height = 400): Rig {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSpanIndex(treeTrace(tree)));
  const controller = new WaterfallController({ store, origin: 'wf-dom' });
  const clock = createFakeClock();
  const scheduler = createFrameScheduler(clock);
  const host = new FakeElement('div');
  const painter = createDomPainter(
    {
      controller,
      host: host as unknown as HTMLElement,
      meter: createTextMeter({ measure: (text) => text.length * 6 }),
      theme,
      scheduler,
      onSize: (w, h) => {
        controller.resize(w, h);
      },
    },
    fakeClasses(),
  );

  const layer = (): FakeElement => host.children[0];
  const rows = (): FakeElement[] => layer().findAll('row');
  const translateY = (row: FakeElement): number => Number(/translateY\((-?[\d.]+)px\)/.exec(String(row.style.transform))?.[1] ?? 0);
  const r: Rig = {
    store, controller, painter, host, clock, scheduler, layer, rows,
    size(w, h) {
      FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1].fire(w, h);
      clock.frame();
    },
    draw(bits) {
      painter.mark(bits);
      clock.frame();
    },
    shownNames() {
      return rows()
        .filter((row) => row.style.display !== 'none')
        .sort((a, b) => translateY(a) - translateY(b))
        .map((row) => row.findAll('name')[0].textContent);
    },
  };
  r.size(width, height);
  return r;
}

/** A root with `children` leaf children, one millisecond each. */
function wide(children: number): TreeNode {
  return {
    id: 'root', start: 0, end: children + 1,
    children: Array.from({ length: children }, (_, i) => ({ id: `s${i}`, start: i, end: i + 1 })),
  };
}

test('the painter puts one layer in the host and removes it on dispose', () => {
  const r = rig(wide(5));
  assert.equal(r.host.children.length, 1);
  assert.equal(r.layer().classList.contains('layer'), true);
  r.painter.dispose();
  assert.equal(r.host.children.length, 0);
  assert.equal(FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1].disconnected, true);
});

test('the layout goes into custom properties on the layer, once', () => {
  const r = rig(wide(5), 1000, 400);
  const props = r.layer().customProperties;
  assert.equal(props.get('--rowHeightVar'), '35px');
  assert.equal(props.get('--barHeightVar'), '30px');
  assert.equal(props.get('--gutterWidthVar'), '250px');
  assert.equal(props.get('--plotLeftVar'), '250px');
});

test('the rows in view show their names, in order', () => {
  const r = rig(wide(5));
  assert.deepEqual(r.shownNames(), ['root', 's0', 's1', 's2', 's3', 's4']);
  const root = r.rows().find((row) => row.findAll('name')[0].textContent === 'root');
  assert.equal(root?.getAttribute('aria-level'), '1');
  assert.equal(root?.getAttribute('aria-expanded'), 'true');
  assert.equal(root?.getAttribute('aria-posinset'), '1');
  assert.equal(root?.getAttribute('aria-setsize'), '6');
});

test('50,000 rows need only a handful of row elements', () => {
  const r = rig(wide(50_000), 1000, 400);
  assert.ok(r.rows().length <= 14, `row elements: ${r.rows().length}`);
  assert.ok(r.painter.stats.rows >= 10 && r.painter.stats.rows <= 12);
});

test('scrolling reuses the row elements and shows other spans', () => {
  const r = rig(wide(500), 1000, 400);
  const before = r.rows().length;
  const first = r.shownNames();

  r.controller.input({ type: 'scroll', top: 35 * 100 });
  r.draw(WaterfallDirty.Scroll);

  assert.equal(r.rows().length, before, 'no new elements');
  assert.notDeepEqual(r.shownNames(), first);
  assert.ok(r.shownNames().includes('s99') || r.shownNames().includes('s100'), r.shownNames().join(','));
});

test('a selection marks exactly one row and does not count as a redraw of the rows', () => {
  const r = rig(wide(20));
  const scenes = r.painter.stats.scenes;

  r.store.setSelection(['s3'], { origin: 'api' });
  r.draw(WaterfallDirty.Selection);

  const selected = r.rows().filter((row) => row.classList.contains('rowSelected'));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].findAll('name')[0].textContent, 's3');
  assert.equal(selected[0].getAttribute('aria-selected'), 'true');
  assert.equal(r.painter.stats.scenes, scenes);
});

test('clearing the selection and moving the hover only toggle classes', () => {
  const r = rig(wide(20));
  r.store.setSelection(['s3'], { origin: 'api' });
  r.store.setHover(['s5'], { origin: 'api' });
  r.draw(WaterfallDirty.Selection | WaterfallDirty.Hover);
  assert.equal(r.rows().filter((row) => row.classList.contains('rowHover')).length, 1);

  r.store.setSelection([], { origin: 'api' });
  r.store.setHover(['s6'], { origin: 'api' });
  r.draw(WaterfallDirty.Selection | WaterfallDirty.Hover);
  assert.equal(r.rows().filter((row) => row.classList.contains('rowSelected')).length, 0);
  const hovered = r.rows().filter((row) => row.classList.contains('rowHover'));
  assert.equal(hovered.length, 1);
  assert.equal(hovered[0].findAll('name')[0].textContent, 's6');
});

test('zooming moves the bars and hides those outside the window', () => {
  const tree: TreeNode = {
    id: 'root', start: 0, end: 1000,
    children: [{ id: 'near', start: 0, end: 5 }, { id: 'far', start: 900, end: 1000 }],
  };
  const r = rig(tree);
  const bar = (name: string): FakeElement => {
    const row = r.rows().find((candidate) => candidate.findAll('name')[0].textContent === name);
    assert.ok(row, `a row for ${name}`);
    return row.findAll('bar')[0];
  };

  assert.equal(bar('far').classList.contains('hidden'), false);
  r.controller.setState({ t0: 0, t1: 10, scrollTop: 0 });
  r.draw(WaterfallDirty.Camera);

  assert.equal(bar('far').classList.contains('hidden'), true, 'a bar outside the window is hidden, not placed millions of px away');
  assert.equal(bar('near').classList.contains('hidden'), false);
  assert.match(String(bar('near').style.transform), /translateX\(/);
  assert.ok(Number.parseFloat(String(bar('near').style.width)) > 100, 'the near bar got wide');
});

test('events become markers, at most as many as there are elements', () => {
  const r = rig(wide(3));
  const markers = r.rows()[0].findAll('marker');
  assert.equal(markers.length, 16);
  assert.ok(markers.every((marker) => marker.classList.contains('hidden')), 'spans without events show no markers');
});

test('a view without a size draws nothing', () => {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSpanIndex(treeTrace(wide(3))));
  const controller = new WaterfallController({ store, origin: 'wf-none' });
  const clock = createFakeClock();
  const host = new FakeElement('div');
  const painter = createDomPainter(
    { controller, host: host as unknown as HTMLElement, meter: createTextMeter({ measure: (t) => t.length }), theme, scheduler: createFrameScheduler(clock), onSize: () => undefined },
    fakeClasses(),
  );
  clock.frame();
  assert.equal(host.children[0].findAll('row').length, 0);
  assert.equal(painter.stats.scenes, 0);
});
