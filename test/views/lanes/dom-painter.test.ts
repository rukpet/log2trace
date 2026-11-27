/**
 * The DOM painter against a fake DOM: the pool of bars, what each element shows, how many elements a
 * big trace costs, and what a change of camera, hover, selection and lane mode rewrites.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { SpanMask, buildSpanIndex, createTraceStore, type ChangeSet, type TraceData, type TraceStore } from '../../../src/core/index.ts';
import { createTextMeter } from '../../../src/kit/text-cache.ts';
import { createFrameScheduler, type FrameScheduler } from '../../../src/kit/scheduler.ts';
import { LanesController } from '../../../src/views/lanes/controller.ts';
import { HitPart } from '../../../src/views/lanes/model/hit.ts';
import { LanesDirty } from '../../../src/views/lanes/model/interaction.ts';
import { LaneMode } from '../../../src/views/lanes/model/layout.ts';
import { MAX_BARS } from '../../../src/views/lanes/model/plan.ts';
import { createDomPainter, type DomClasses, type LanesPainter } from '../../../src/views/lanes/paint/dom.ts';
import { createFakeClock, type FakeClock } from '../../support/fake-frame.ts';
import { FakeElement, FakeResizeObserver, installFakeDom } from '../../support/fake-dom-tree.ts';
import { largeTrace, wideTrace } from '../../support/lanes-scene.ts';
import { span, trace } from '../../support/trace-builder.ts';

let restore: () => void;
before(() => {
  restore = installFakeDom();
});
after(() => restore());

/** Class names that spell what they are: `styles.barHovered` is `'barHovered'`, `styles.kind.server` is `'kind.server'`. */
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

const FONT_FAMILY = 'Test Sans';

interface Rig {
  readonly store: TraceStore;
  readonly controller: LanesController;
  readonly painter: LanesPainter;
  readonly host: FakeElement;
  readonly clock: FakeClock;
  readonly scheduler: FrameScheduler;
  /** Resize the host and draw the frame that follows. */
  size(width: number, height: number): void;
  /** Tell the painter what changed and draw the frame. */
  draw(bits: number): void;
  /** Deliver the store's pending changes to the controller, tell the painter and draw. */
  sync(): number;
  layer(): FakeElement;
  /** The bar elements that are in use. */
  bars(): FakeElement[];
  /** The lane headers in use, top to bottom. */
  headers(): FakeElement[];
  /** The summary rows in use. */
  summaries(): FakeElement[];
  /** The bar that shows the span, or undefined. */
  barOf(id: string): FakeElement | undefined;
}

const shown = (element: FakeElement): boolean => !element.classList.contains('hidden');

function rig(data: TraceData = wideTrace(), width = 1000, height = 600): Rig {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSpanIndex(data));
  const controller = new LanesController({ store, origin: 'lanes-dom' });
  const changes: ChangeSet[] = [];
  store.subscribe((change) => changes.push(change));
  store.flushSync();
  changes.length = 0;

  const clock = createFakeClock();
  const scheduler = createFrameScheduler(clock);
  const host = new FakeElement('div');
  const painter = createDomPainter(
    {
      controller,
      host: host as unknown as HTMLElement,
      meter: createTextMeter({ measure: (text) => text.length * 6 }),
      fontFamily: FONT_FAMILY,
      scheduler,
      onSize: (w, h) => {
        controller.resize(w, h);
      },
    },
    fakeClasses(),
  );

  const layer = (): FakeElement => host.children[0];
  const translateY = (element: FakeElement): number => Number(/translateY\((-?[\d.]+)px\)/.exec(String(element.style.transform))?.[1] ?? 0);
  const r: Rig = {
    store, controller, painter, host, clock, scheduler, layer,
    size(w, h) {
      FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1].fire(w, h);
      clock.frame();
    },
    draw(bits) {
      painter.mark(bits);
      clock.frame();
    },
    sync() {
      store.flushSync();
      let dirty = 0;
      for (const change of changes.splice(0)) dirty |= controller.update(change).dirty;
      r.draw(dirty);
      return dirty;
    },
    bars: () => layer().findAll('bar').filter(shown),
    headers: () => layer().findAll('header').filter(shown).sort((a, b) => translateY(a) - translateY(b)),
    summaries: () => layer().findAll('summary').filter(shown),
    barOf: (id) => r.bars().find((bar) => bar.getAttribute('data-span-id') === id),
  };
  r.size(width, height);
  return r;
}

/** Every element below `element`, counted. */
function countNodes(element: FakeElement): number {
  let total = 0;
  for (const child of element.children) total += 1 + countNodes(child);
  return total;
}

const nameOf = (header: FakeElement): string => header.getAttribute('data-lane') ?? '';
const laneId = (rig: Rig, name: string): number => rig.controller.model.names.indexOf(name);

test('the painter puts one layer in the host and removes it on dispose', () => {
  const r = rig();
  assert.equal(r.host.children.length, 1);
  assert.equal(r.layer().classList.contains('layer'), true);
  r.painter.dispose();
  assert.equal(r.host.children.length, 0);
  assert.equal(FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1].disconnected, true);
});

test('the layout goes into custom properties on the layer, once', () => {
  const r = rig(wideTrace(), 1000, 600);
  const props = r.layer().customProperties;
  assert.equal(props.get('--rowHeightVar'), '18px');
  assert.equal(props.get('--barHeightVar'), '16px');
  assert.equal(props.get('--summaryHeightVar'), '24px');
  assert.equal(props.get('--gutterWidthVar'), '220px');
  assert.equal(props.get('--plotLeftVar'), '220px');
  assert.equal(props.get('--plotWidthVar'), '756px');
});

test('lane headers are treeitems of a tree, with name, level, position and expanded state', () => {
  const r = rig();
  assert.equal(r.layer().findAll('body')[0].getAttribute('role'), 'tree');
  const headers = r.headers();
  assert.deepEqual(headers.map(nameOf), ['web', 'api', 'postgres', 'bg']);

  const api = headers[1];
  assert.equal(api.getAttribute('role'), 'treeitem');
  assert.equal(api.getAttribute('aria-level'), '1');
  assert.equal(api.getAttribute('aria-posinset'), '2');
  assert.equal(api.getAttribute('aria-setsize'), '4');
  assert.equal(api.getAttribute('aria-expanded'), 'true');
  assert.equal(api.findAll('name')[0].textContent, 'api');
  assert.match(api.findAll('stats')[0].textContent, /^23 spans · /, 'the stats readout is there for screen readers');
  assert.equal(api.findAll('name')[0].classList.contains('namePeer'), false);
  assert.equal(headers[2].findAll('name')[0].classList.contains('namePeer'), true, 'a peer lane is told apart');
  assert.equal(api.findAll('chevron')[0].classList.contains('chevronState.expanded'), true);
});

test('bars carry the span id and kind, sit at their plot position, and show a label when they are wide', () => {
  const r = rig();
  const w = r.barOf('w');
  assert.ok(w);
  assert.equal(w.classList.contains('kind.server'), true);
  assert.equal(w.style.transform, 'translate(0px, 1px)', 'the bar is 1 px into its row; the body starts below the ruler');
  assert.equal(w.style.width, `${756}px`);
  assert.equal(w.textContent, 'w');

  const call = r.barOf('w-call');
  assert.ok(call);
  assert.equal(call.classList.contains('kind.client'), true);
  const [x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(call.style.transform))?.slice(1).map(Number) ?? [];
  assert.ok(Math.abs(x - 10 * 0.756) < 0.001);
  assert.equal(y, 19, 'the second row of the lane');
  assert.equal(call.style.paddingLeft, '4px', 'the label starts 4 px into the bar');

  const tiny = r.barOf('b1');
  assert.ok(tiny);
  assert.equal(tiny.textContent, '', 'a 10 ms bar is too narrow for a label');
});

test('every drawn bar is an element of the pool, one per run, and nothing else is drawn as a bar', () => {
  const r = rig();
  assert.equal(r.bars().length, r.painter.stats.bars);
  assert.equal(r.painter.stats.barElements, r.bars().length);
  assert.equal(r.painter.stats.scenes > 0, true);
});

test('a call to a peer is drawn twice: its own bar, and a ghost on the peer lane', () => {
  const r = rig();
  const ids = r.bars().filter((bar) => bar.getAttribute('data-span-id') === 'a-db');
  assert.equal(ids.length, 2);
  assert.equal(ids.filter((bar) => bar.classList.contains('barGhost')).length, 1);
  assert.equal(ids.filter((bar) => !bar.classList.contains('barGhost')).length, 1);

  const failed = r.bars().filter((bar) => bar.getAttribute('data-span-id') === 'a-db2');
  assert.equal(failed.length, 2);
  assert.ok(failed.every((bar) => bar.classList.contains('barError')));
});

test('items closer than the merge gap are one merged bar with a count', () => {
  const spans = Array.from({ length: 100 }, (_, i) => span(`s${i}`, undefined, i * 10, i * 10 + 9));
  const r = rig(trace(['svc', spans]));
  assert.equal(r.bars().length, 1);
  const bar = r.bars()[0];
  assert.equal(bar.classList.contains('barMerged'), true);
  assert.equal(bar.getAttribute('data-count'), '100');
  assert.equal(bar.getAttribute('data-span-id'), 's0');
  assert.equal(bar.textContent, '');

  r.controller.setState({ generation: 1, t0: 0, t1: 50, scrollTop: 0, laneModes: {} });
  r.draw(LanesDirty.Camera);
  assert.ok(r.bars().length > 1, 'zooming in splits the run');
  assert.ok(r.bars().every((b) => !b.classList.contains('barMerged')));
  assert.ok(r.bars().every((b) => b.getAttribute('data-count') === null));
});

test('a 50K span trace fully zoomed out keeps the DOM within the bar budget plus chrome', () => {
  const r = rig(largeTrace(50_000), 1000, 2400);
  const { controller } = r;
  assert.ok(controller.state.stack.count >= 6);

  const bars = r.bars().length;
  assert.ok(bars > 100, `many bars (${bars})`);
  assert.ok(bars <= MAX_BARS, `${bars} bars are within the budget of ${MAX_BARS}`);
  const nodes = countNodes(r.layer());
  assert.ok(nodes <= MAX_BARS + 64 * 12, `${nodes} elements in the DOM stay at the budget plus a few per lane`);

  // expanding every lane and zooming around never grows the document past the budget
  for (const [t0, t1] of [[0, 30_000], [10_000, 12_000], [0, 60_000], [20_000, 20_050], [0, 60_000]]) {
    controller.setState({ generation: 1, t0, t1, scrollTop: 0, laneModes: Object.fromEntries(controller.model.names.map((name) => [name, 'full'])) });
    r.draw(LanesDirty.Camera | LanesDirty.Lanes);
    assert.ok(r.painter.stats.barElements <= MAX_BARS, `${r.painter.stats.barElements} bar elements after zooming to ${t0}..${t1}`);
    assert.ok(r.bars().length <= MAX_BARS);
  }

  // the document is also counted by what is in it, not by the painter's own books
  assert.ok(r.layer().findAll('bar').length <= MAX_BARS);
});

test('bar elements are reused: a pan rewrites positions, not elements or labels', () => {
  const r = rig();
  r.controller.setState({ generation: 1, t0: 40, t1: 540, scrollTop: 0, laneModes: {} });
  r.draw(LanesDirty.Camera);
  const stats = { ...r.painter.stats };
  const before = r.bars();
  r.controller.setState({ generation: 1, t0: 60, t1: 560, scrollTop: 0, laneModes: {} });
  r.draw(LanesDirty.Camera);

  const after = r.bars();
  const same = after.filter((bar) => before.includes(bar));
  assert.ok(same.length >= after.length - 3, 'the bars still in view keep their elements');
  assert.equal(r.painter.stats.barElements, stats.barElements, 'no element was created');
  assert.ok(r.painter.stats.classWrites - stats.classWrites <= 4, 'a pan toggles classes only for bars that enter or change width class');
  assert.ok(r.painter.stats.geometryWrites > stats.geometryWrites);

  const moved = r.painter.stats.geometryWrites;
  r.draw(LanesDirty.Camera);
  assert.equal(r.painter.stats.geometryWrites, moved, 'a frame that changed nothing writes nothing');
});

test('a hover toggles one class and plans nothing; a selection fades the rest without moving a bar', () => {
  const r = rig();
  const scenes = r.painter.stats.scenes;
  const overlays = r.painter.stats.overlays;
  const geometry = r.painter.stats.geometryWrites;
  const barCount = r.bars().length;

  r.store.setHover(['a-db'], { origin: 'api' });
  r.sync();
  assert.equal(r.painter.stats.scenes, scenes, 'a hover does not plan the frame again');
  assert.equal(r.painter.stats.overlays, overlays + 1);
  const hovered = r.bars().filter((bar) => bar.classList.contains('barHovered'));
  assert.deepEqual(hovered.map((bar) => bar.getAttribute('data-span-id')), ['a-db', 'a-db'], 'the span and its ghost');
  assert.equal(r.painter.stats.geometryWrites, geometry);

  r.store.setHover(null, { origin: 'api' });
  r.sync();
  assert.equal(r.bars().filter((bar) => bar.classList.contains('barHovered')).length, 0);

  r.store.setSelection(['a'], { origin: 'api' });
  r.sync();
  assert.equal(r.painter.stats.geometryWrites, geometry, 'no bar moved');
  assert.equal(r.bars().length, barCount);
  const selected = r.barOf('a');
  assert.ok(selected?.classList.contains('barSelected'));
  assert.ok(selected?.classList.contains('barRelated'));
  assert.equal(r.barOf('w')?.classList.contains('barRelated'), true, 'an ancestor is related');
  assert.equal(r.barOf('b1')?.classList.contains('barFaded'), true, 'a span outside the tree fades');
  assert.equal(r.barOf('b1')?.classList.contains('barRelated'), false);

  r.store.setSelection([], { origin: 'api' });
  r.sync();
  assert.equal(r.bars().filter((bar) => bar.classList.contains('barFaded') || bar.classList.contains('barSelected')).length, 0);
});

test('spans that do not match the filter are dimmed, not removed', () => {
  const r = rig();
  const count = r.bars().length;
  r.store.setMatched(SpanMask.of(r.controller.index, ['b2']), { origin: 'api' });
  r.sync();
  assert.equal(r.bars().length, count);
  assert.equal(r.barOf('b2')?.classList.contains('barDimmed'), false);
  assert.equal(r.barOf('b1')?.classList.contains('barDimmed'), true);
  assert.equal(r.barOf('w')?.classList.contains('barDimmed'), true);
});

test('a collapsed lane is one summary row with an area path; its bars are gone', () => {
  const r = rig();
  assert.equal(r.summaries().filter((row) => row.getAttribute('data-summary') === 'collapsed').length, 0);
  const web = laneId(r, 'web');
  const result = r.controller.input({ type: 'laneMode', lane: web, mode: LaneMode.Collapsed });
  r.draw(result.dirty);

  const rows = r.summaries().filter((row) => row.getAttribute('data-summary') === 'collapsed');
  assert.equal(rows.length, 1);
  const paths = rows[0].children[0].children;
  assert.equal(paths.length, 2, 'an area path and a path of error ticks');
  assert.match(paths[0].getAttribute('d') ?? '', /^M0 \d+/, 'the area has path data');
  assert.equal(paths[0].classList.contains('summaryArea'), true);
  assert.equal(paths[1].classList.contains('summaryErrors'), true);
  assert.equal(rows[0].children[0].getAttribute('width'), '756');
  assert.equal(rows[0].children[1].classList.contains('hidden'), true, 'a collapsed lane has no "+N rows" button');

  assert.equal(r.barOf('w'), undefined);
  assert.equal(r.headers()[0].getAttribute('aria-expanded'), 'false');
  assert.equal(r.headers()[0].findAll('chevron')[0].classList.contains('chevronState.collapsed'), true);

  const back = r.controller.input({ type: 'laneMode', lane: web, mode: LaneMode.Capped });
  r.draw(back.dirty);
  assert.equal(r.summaries().filter((row) => row.getAttribute('data-summary') === 'collapsed').length, 0);
  assert.ok(r.barOf('w'));
  assert.equal(r.headers()[0].getAttribute('aria-expanded'), 'true');
});

test('the errors of a collapsed lane are ticks in the second path', () => {
  const r = rig();
  const bg = laneId(r, 'bg');
  r.draw(r.controller.input({ type: 'laneMode', lane: bg, mode: LaneMode.Collapsed }).dirty);
  const row = r.summaries().find((s) => s.getAttribute('data-summary') === 'collapsed');
  assert.ok(row);
  assert.match(row.children[0].children[1].getAttribute('d') ?? '', /^M\d+ 0V8/);
});

test('a capped lane with more levels than the cap has an overflow row with a "+N rows" button', () => {
  const r = rig();
  const rows = r.summaries().filter((row) => row.getAttribute('data-summary') === 'overflow');
  assert.equal(rows.length, 1);
  const button = rows[0].children[1];
  assert.equal(button.classList.contains('hidden'), false);
  assert.equal(button.textContent, '+5 rows');
  assert.equal(rows[0].children[0].children[0].classList.contains('summaryOverflowArea'), true);
  assert.match(rows[0].children[0].children[0].getAttribute('d') ?? '', /^M0 /);

  const api = laneId(r, 'api');
  r.draw(r.controller.input({ type: 'laneMode', lane: api, mode: LaneMode.Full }).dirty);
  assert.equal(r.summaries().filter((row) => row.getAttribute('data-summary') === 'overflow').length, 0, 'a full lane has no overflow row');
});

test('scrolling moves the lanes; a lane scrolled partly under the ruler keeps its name in view', () => {
  const r = rig(wideTrace(), 1000, 200);
  const api = () => r.headers().find((header) => nameOf(header) === 'api');
  assert.ok(api());
  const contentOf = (header: FakeElement | undefined): string => String(header?.findAll('headerContent')[0].style.transform);
  assert.equal(contentOf(api()), 'translateY(0px)');

  const apiTop = r.controller.state.stack.top[r.controller.state.stack.positionOfLane[laneId(r, 'api')]];
  const result = r.controller.input({ type: 'scroll', top: apiTop + 40 });
  r.draw(result.dirty);
  assert.equal(contentOf(api()), 'translateY(40px)', 'the header follows the top of the viewport inside its lane');
  assert.equal(api()?.style.transform, 'translateY(-40px)');

  // a lane that scrolled out of view returns its header to the pool
  const web = r.headers().find((header) => nameOf(header) === 'web');
  assert.equal(web, undefined);
});

test('the ruler draws ticks as grid lines and labels, and updates them with the camera', () => {
  const r = rig();
  const labels = (): string[] => r.layer().findAll('rulerLabel').filter(shown).map((label) => label.textContent);
  const before = labels();
  assert.ok(before.length >= 4);
  assert.equal(r.layer().findAll('gridLine').filter(shown).length, before.length);

  r.controller.setState({ generation: 1, t0: 100, t1: 140, scrollTop: 0, laneModes: {} });
  r.draw(LanesDirty.Camera);
  assert.notDeepEqual(labels(), before);
  assert.ok(labels().length >= 4);
});

test('the hover box outlines an idle stretch and nothing else on the plot; a header gets a class', () => {
  const r = rig();
  const box = r.layer().findAll('hoverBox')[0];
  assert.equal(box.classList.contains('hidden'), true);

  // bg is busy only at the end (900 ms on), so the middle of its lane is an idle stretch
  const stack = r.controller.state.stack;
  const k = stack.positionOfLane[laneId(r, 'bg')];
  const y = 40 + stack.top[k] + 9;
  r.controller.input({ type: 'hover', x: 220 + 700, y });
  r.draw(LanesDirty.Hover);
  assert.equal(r.controller.state.hover?.part, HitPart.IdleGap);
  assert.equal(box.classList.contains('hidden'), false, 'the idle stretch is outlined');

  r.controller.input({ type: 'hover', x: 60, y });
  r.draw(LanesDirty.Hover);
  assert.equal(box.classList.contains('hidden'), true, 'a header has a class instead');
  const header = r.headers().find((h) => nameOf(h) === 'bg');
  assert.equal(header?.findAll('gutter')[0].classList.contains('headerHover'), true);

  r.controller.input({ type: 'leave' });
  r.draw(LanesDirty.Hover);
  assert.equal(header?.findAll('gutter')[0].classList.contains('headerHover'), false);
});

test('a new trace does not leave a reused lane header highlighted', () => {
  const r = rig();
  const stack = r.controller.state.stack;
  // lane 0 is lane 0 in any trace, so its slot is reused for the new trace's first lane under the resting pointer
  const k = stack.positionOfLane[0];
  r.controller.input({ type: 'hover', x: 60, y: 40 + stack.top[k] + 9 });
  r.draw(LanesDirty.Hover);
  assert.equal(r.controller.state.hover?.part, HitPart.Header);
  assert.equal(r.controller.state.hover.lane, 0);
  const header = r.headers().find((h) => h.getAttribute('data-lane') === r.controller.model.names[0]);
  assert.equal(header?.findAll('gutter')[0].classList.contains('headerHover'), true);

  r.store.setData(buildSpanIndex(trace(['bg', [span('only', undefined, 0, 100)]])));
  r.sync();
  assert.equal(r.controller.state.hover, null);
  assert.deepEqual(r.headers().map(nameOf), ['bg']);
  for (const gutter of r.layer().findAll('gutter')) {
    assert.equal(gutter.classList.contains('headerHover'), false, 'no header is highlighted');
  }
});

test('the stats of a collapsed lane follow the row height, though the lane keeps its height', () => {
  const r = rig();
  const web = laneId(r, 'web');
  r.draw(r.controller.input({ type: 'laneMode', lane: web, mode: LaneMode.Collapsed }).dirty);
  const header = (): FakeElement => {
    const found = r.headers().find((h) => nameOf(h) === 'web');
    assert.ok(found);
    return found;
  };
  const stats = (): FakeElement => header().findAll('stats')[0];
  const { rowHeight, summaryHeight } = r.controller.layout;
  assert.ok(summaryHeight < 2 * rowHeight);
  assert.equal(stats().classList.contains('statsHidden'), true, 'a collapsed lane is too short for stats');

  // rows get so low that the (unchanged) summary row is two rows tall
  r.draw(r.controller.setMetrics({ rowHeight: summaryHeight / 2 }).dirty);
  assert.equal(r.controller.layout.rowHeight, summaryHeight / 2);
  assert.equal(header().style.height, `${summaryHeight}px`, 'the lane did not change height');
  assert.equal(stats().classList.contains('statsHidden'), false);

  r.draw(r.controller.setMetrics({ rowHeight }).dirty);
  assert.equal(stats().classList.contains('statsHidden'), true);
});

test('nothing is drawn before the host has a size', () => {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSpanIndex(wideTrace()));
  const controller = new LanesController({ store, origin: 'lanes-none' });
  const clock = createFakeClock();
  const host = new FakeElement('div');
  const painter = createDomPainter(
    { controller, host: host as unknown as HTMLElement, meter: createTextMeter({ measure: (t) => t.length }), fontFamily: FONT_FAMILY, scheduler: createFrameScheduler(clock), onSize: () => undefined },
    fakeClasses(),
  );
  clock.frame();
  assert.equal(host.children[0].findAll('bar').length, 0);
  assert.equal(painter.stats.scenes, 0);
});

test('a new trace replaces the lanes and returns the old bars to the pool', () => {
  const r = rig();
  const elements = r.painter.stats.barElements;
  r.store.setData(buildSpanIndex(trace(['solo', [span('only', undefined, 0, 100)]])));
  r.sync();
  assert.equal(r.bars().length, 1);
  assert.equal(r.barOf('only')?.getAttribute('data-span-id'), 'only');
  assert.deepEqual(r.headers().map(nameOf), ['solo']);
  assert.equal(r.painter.stats.barElements, elements, 'the elements stay in the pool');
});

test('refreshTheme re-reads the computed font and plans again', () => {
  const original = globalThis.getComputedStyle;
  let activeFont = 'Initial Sans';
  const queried: unknown[] = [];
  (globalThis as Record<string, unknown>).getComputedStyle = (el: unknown) => {
    queried.push(el);
    return { fontFamily: activeFont };
  };
  try {
    const fonts: string[] = [];
    const store = createTraceStore({ schedule: () => undefined });
    store.setData(buildSpanIndex(wideTrace()));
    const controller = new LanesController({ store, origin: 'lanes-font' });
    const clock = createFakeClock();
    const host = new FakeElement('div');
    const painter = createDomPainter(
      {
        controller,
        host: host as unknown as HTMLElement,
        meter: createTextMeter({ measure: (text, font) => { fonts.push(font); return text.length * 6; } }),
        scheduler: createFrameScheduler(clock),
        onSize: (w, h) => { controller.resize(w, h); },
      },
      fakeClasses(),
    );
    const layer = host.children[0];
    assert.deepEqual(queried, [layer]);

    FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1].fire(1000, 600);
    clock.frame();
    assert.ok(fonts.includes('11px Initial Sans'));

    fonts.length = 0;
    activeFont = 'Updated Mono';
    painter.refreshTheme();
    clock.frame();
    assert.deepEqual(queried, [layer, layer]);
    assert.ok(fonts.includes('11px Updated Mono'));
    painter.dispose();
  } finally {
    (globalThis as Record<string, unknown>).getComputedStyle = original;
  }
});
