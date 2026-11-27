/**
 * LanesView against a fake DOM and a real store: what it mounts, how input becomes selection, hover,
 * camera and lane modes, what a screen reader is told, and how it lives and dies.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setFileScope } from '@vanilla-extract/css/fileScope';
import { SpanMask, buildSpanIndex, createTraceStore, type ChangeSet, type TraceData, type TraceStore } from '../../../src/core/index.ts';
import type { ViewCommand } from '../../../src/kit/commands.ts';
import { createFrameScheduler } from '../../../src/kit/scheduler.ts';
import { createTextMeter } from '../../../src/kit/text-cache.ts';
import type { ViewContext, ViewHit } from '../../../src/kit/view.ts';
import type { ViewOptions } from '../../../src/kit/view-options.ts';
import { LaneMode } from '../../../src/views/lanes/model/layout.ts';
import { createFakeClock, type FakeClock } from '../../support/fake-frame.ts';
import { FakeElement, FakeResizeObserver, installFakeDom } from '../../support/fake-dom-tree.ts';
import { wideTrace } from '../../support/lanes-scene.ts';
import { span, trace } from '../../support/trace-builder.ts';

// the stylesheets are modules of the bundler; give them a file scope so that their class names exist here
setFileScope('src/views/lanes/view.css.ts');
const { LanesView, lanesDefinition } = await import('../../../src/views/lanes/view.ts');
const viewStyles = await import('../../../src/views/lanes/view.css.ts');
const domStyles = await import('../../../src/views/lanes/paint/dom.css.ts');
const a11yStyles = await import('../../../src/kit/a11y.css.ts');

/** An element that keeps its listeners, can be fired at, and answers what the input binding asks of a scroller. */
class InteractiveElement extends FakeElement {
  scrollTop = 0;
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 0;
  clientHeight = 0;
  /** `true` after the code under test took the focus. */
  focused = false;
  /** Where `hidden` is a property of the element. */
  hidden = false;
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();

  override addEventListener(type?: string, listener?: (event: never) => void): void {
    if (type === undefined || listener === undefined) return;
    const list = this.handlers.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.handlers.set(type, list);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    const list = this.handlers.get(type);
    const at = list?.indexOf(listener as (event: unknown) => void) ?? -1;
    if (at >= 0) list?.splice(at, 1);
  }

  /** How many listeners are registered. */
  listenerCount(): number {
    let total = 0;
    for (const list of this.handlers.values()) total += list.length;
    return total;
  }

  /** Deliver an event to the listeners of its type; the result tells whether one cancelled it. */
  fire(type: string, fields: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of [...(this.handlers.get(type) ?? [])]) listener(event);
    return event;
  }

  getBoundingClientRect(): { readonly left: number; readonly top: number } {
    return { left: 0, top: 0 };
  }

  setPointerCapture(): void {
    // nothing to capture
  }

  releasePointerCapture(): void {
    // nothing to release
  }

  focus(): void {
    this.focused = true;
  }
}

let restoreDom: () => void;
before(() => {
  restoreDom = installFakeDom();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = {
    createElement: (tag: string) => new InteractiveElement(tag),
    createElementNS: (_namespace: string, tag: string) => new InteractiveElement(tag),
  };
});
after(() => restoreDom());

const WIDTH = 1000;
const HEIGHT = 600;
const PLOT_LEFT = 220;
const RULER = 40;
const SCALE = 756 / 1000;

interface Harness {
  readonly store: TraceStore;
  readonly view: InstanceType<typeof LanesView>;
  readonly surface: InteractiveElement;
  readonly plot: InteractiveElement;
  readonly clock: FakeClock;
  readonly hovers: Array<ViewHit | null>;
  readonly attributes: Map<string, string>;
  config: Record<string, unknown>;
  refreshed: number;
  /** Deliver the store's pending changes to the view and draw the frame. */
  flush(): void;
  /** A press and release at a point of the view. */
  click(x: number, y: number, extra?: Record<string, unknown>): void;
  hover(x: number, y: number): void;
  key(key: string, extra?: Record<string, unknown>): { defaultPrevented: boolean };
  command(id: string): ViewCommand;
  /** The live region's text. */
  live(): string;
}

function pointer(x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { pointerId: 1, clientX: x, clientY: y, button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra };
}

function harness(data: TraceData = wideTrace(), height = HEIGHT): Harness {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSpanIndex(data));
  const changes: ChangeSet[] = [];
  store.subscribe((change) => changes.push(change));
  store.flushSync();
  changes.length = 0;

  const clock = createFakeClock();
  const view = new LanesView({ scheduler: createFrameScheduler(clock), meter: createTextMeter({ measure: (text) => text.length * 6 }) });
  const surface = new InteractiveElement('div');
  const hovers: Array<ViewHit | null> = [];
  const attributes = new Map<string, string>();
  const h: Harness = {
    store, view, surface, clock, hovers, attributes,
    plot: undefined as unknown as InteractiveElement,
    config: {},
    refreshed: 0,
    flush() {
      store.flushSync();
      for (const change of changes.splice(0)) view.update(change);
      clock.frame();
    },
    click(x, y, extra = {}) {
      h.plot.fire('pointerdown', pointer(x, y, extra));
      h.plot.fire('pointerup', pointer(x, y, extra));
      h.flush();
    },
    hover(x, y) {
      h.plot.fire('pointermove', pointer(x, y));
      h.flush();
    },
    key(key, extra = {}) {
      const event = h.plot.fire('keydown', { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...extra });
      h.flush();
      return event;
    },
    command(id) {
      const found = view.commands().find((command) => command.id === id);
      assert.ok(found !== undefined, `expected command ${id}`);
      return found;
    },
    live: () => surface.findAll(a11yStyles.visuallyHidden)[0]?.textContent ?? '',
  };

  const ctx: ViewContext = {
    origin: 'lanes-view-test',
    store,
    options: (): ViewOptions => ({ config: h.config, attribute: (name) => attributes.get(name) ?? null }),
    hover: (hit) => hovers.push(hit),
    refreshCommands: () => {
      h.refreshed++;
    },
  };
  view.mount(surface as unknown as HTMLElement, ctx);
  (h as { plot: InteractiveElement }).plot = view.internals?.plot as unknown as InteractiveElement;
  h.plot.clientWidth = WIDTH;
  h.plot.clientHeight = height;
  FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1].fire(WIDTH, height);
  clock.frame();
  return h;
}

/** View coordinates of a bar by its place: the plot x of a time, the row of a lane. */
const xOf = (ms: number): number => PLOT_LEFT + ms * SCALE;
/** `wideTrace`: `web` has two rows at y 40 and 58, so its second row is at 58. */
const WEB_ROW_1 = RULER + 9;
const WEB_ROW_2 = RULER + 18 + 9;

test('lanesDefinition describes the view for the element', () => {
  assert.equal(lanesDefinition.id, 'lanes');
  assert.equal(lanesDefinition.label, 'Lanes');
  assert.deepEqual(lanesDefinition.capabilities, { legend: true });
  assert.ok(lanesDefinition.create() instanceof LanesView);
});

test('mounting builds a native scroller with a spacer, the painter layer, an empty note and a live region', () => {
  const h = harness();
  assert.equal(h.surface.children.length, 4);
  assert.equal(h.surface.children[0].classList.contains(domStyles.layer), true, 'the painter layer is under the scroller');
  assert.equal(h.surface.children[1], h.plot);
  assert.equal(h.plot.getAttribute('part'), 'plot');
  assert.equal(h.plot.getAttribute('role'), 'application');
  assert.equal(h.plot.getAttribute('aria-label'), 'Trace lanes');
  assert.equal(h.plot.getAttribute('tabindex'), '0');

  const { controller } = h.view.internals ?? assert.fail('mounted');
  const spacer = h.plot.children[0];
  assert.equal(spacer.style.height, `${40 + controller.state.stack.contentHeight}px`);

  const [note] = h.surface.findAll(viewStyles.empty) as InteractiveElement[];
  assert.equal(note?.hidden, true, 'the note is for empty traces');
  assert.equal(h.surface.findAll(a11yStyles.visuallyHidden)[0].getAttribute('aria-live'), 'polite');
  assert.ok((h.view.painterStats?.scenes ?? 0) > 0);
});

test('an empty trace shows the note, and a loaded one hides it', () => {
  const h = harness(trace(['svc', []]));
  const note = h.surface.findAll(viewStyles.empty)[0] as InteractiveElement;
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'No spans to show.');

  h.store.setData(buildSpanIndex(wideTrace()));
  h.flush();
  assert.equal(note.hidden, true);
  assert.ok((h.view.internals?.controller.state.stack.count ?? 0) > 0);
});

test('a click on a bar selects its span, announces it and does not select twice', () => {
  const h = harness();
  h.click(xOf(500), WEB_ROW_1);
  assert.deepEqual([...h.store.state.selection.ids], ['w']);
  assert.equal(h.store.state.selection.primary, 'w');
  assert.match(h.live(), /^w, web, 1\.00s$/);

  h.click(xOf(500), WEB_ROW_2);
  assert.deepEqual([...h.store.state.selection.ids], ['w-call']);
  assert.match(h.live(), /^w-call, web, /);

  h.click(xOf(500), WEB_ROW_2, { ctrlKey: true });
  assert.equal(h.store.state.selection.ids.size, 1, 'the click on the same span adds nothing');
  h.click(xOf(500), WEB_ROW_1, { shiftKey: true });
  assert.deepEqual([...h.store.state.selection.ids].sort(), ['w', 'w-call']);
  assert.match(h.live(), /, 2 spans selected$/);
});

test('Escape clears the selection and is left to the page when there is none', () => {
  const h = harness();
  assert.equal(h.key('Escape').defaultPrevented, false, 'nothing to clear: the key keeps its default');
  h.click(xOf(500), WEB_ROW_1);
  assert.equal(h.store.state.selection.ids.size, 1);
  assert.equal(h.key('Escape').defaultPrevented, true);
  assert.equal(h.store.state.selection.ids.size, 0);
  assert.equal(h.live(), '');
});

test('arrow keys move the selection: down to the first child, up to the parent, right to the next on the track', () => {
  const h = harness();
  h.click(xOf(500), WEB_ROW_1);
  assert.equal(h.key('ArrowDown').defaultPrevented, true);
  assert.equal(h.store.state.selection.primary, 'w-call');
  h.key('ArrowUp');
  assert.equal(h.store.state.selection.primary, 'w');

  // bg has two spans on one track
  const { controller } = h.view.internals ?? assert.fail('mounted');
  h.store.setSelection(['b1'], { origin: 'test' });
  h.flush();
  h.key('ArrowRight');
  assert.equal(h.store.state.selection.primary, 'b2');
  h.key('ArrowLeft');
  assert.equal(h.store.state.selection.primary, 'b1');
  assert.ok(controller.selectedRow >= 0);
});

test('E and G expand and collapse all lanes, Enter toggles the lane of the selection', () => {
  const h = harness();
  const { controller } = h.view.internals ?? assert.fail('mounted');
  const modes = (): number[] => [...controller.state.stack.modes];

  h.key('g');
  assert.ok(modes().every((mode) => mode === LaneMode.Collapsed));
  assert.equal(h.view.painterStats?.summaries, controller.state.stack.count);
  h.key('e');
  assert.ok(modes().every((mode) => mode === LaneMode.Capped));

  h.click(xOf(500), WEB_ROW_1);
  h.key('Enter');
  assert.equal(controller.state.stack.modes[controller.model.names.indexOf('web')], LaneMode.Collapsed);
});

test('a click on a lane header collapses the lane; a click on the "+N rows" button opens it', () => {
  const h = harness();
  const { controller } = h.view.internals ?? assert.fail('mounted');
  const webLane = controller.model.names.indexOf('web');
  h.click(60, RULER + 5);
  assert.equal(controller.state.stack.modes[webLane], LaneMode.Collapsed);
  h.click(60, RULER + 5);
  assert.equal(controller.state.stack.modes[webLane], LaneMode.Capped);

  const apiLane = controller.model.names.indexOf('api');
  const k = controller.state.stack.positionOfLane[apiLane];
  const overflowY = RULER + controller.state.stack.top[k] + 16 * 18 + 12;
  h.click(PLOT_LEFT + 30, overflowY);
  assert.equal(controller.state.stack.modes[apiLane], LaneMode.Full);
});

test('hovering a bar tells the page, with a stable key, the bar box and what to say; leaving clears it', () => {
  const h = harness();
  h.hover(xOf(500), WEB_ROW_1);
  const hit = h.hovers.at(-1);
  assert.ok(hit);
  assert.match(hit.key, /:run:/);
  assert.equal(hit.anchor.x, PLOT_LEFT);
  assert.equal(hit.anchor.y, RULER + 1);
  assert.ok(Math.abs(hit.anchor.w - 756) < 0.01);
  assert.equal(hit.anchor.h, 16);
  assert.deepEqual(hit.bounds, { width: WIDTH, height: HEIGHT });
  assert.equal(hit.info()?.title, 'w');
  assert.deepEqual([...(h.store.state.hover?.ids ?? [])], ['w']);

  const count = h.hovers.length;
  h.hover(xOf(600), WEB_ROW_1);
  assert.equal(h.hovers.length, count, 'the same bar reports once');

  h.hover(xOf(500), WEB_ROW_2);
  assert.notEqual(h.hovers.at(-1)?.key, hit.key);

  h.plot.fire('pointerleave', { pointerId: 1 });
  h.flush();
  assert.equal(h.hovers.at(-1), null);
  assert.equal(h.store.state.hover, null);
});

test('hovering a lane header and an idle stretch reports them with their own descriptions', () => {
  const h = harness();
  h.hover(60, RULER + 5);
  assert.equal(h.hovers.at(-1)?.info()?.title, 'web');
  assert.equal(h.hovers.at(-1)?.info()?.subtitle, 'Service lane');

  const { controller } = h.view.internals ?? assert.fail('mounted');
  const k = controller.state.stack.positionOfLane[controller.model.names.indexOf('bg')];
  h.hover(xOf(930), RULER + controller.state.stack.top[k] + 9);
  assert.match(h.hovers.at(-1)?.info()?.title ?? '', /^Idle /);
});

test('ctrl+wheel zooms around the pointer, shift+wheel and a drag pan, a plain wheel is left to the scroller', () => {
  const h = harness();
  const { controller } = h.view.internals ?? assert.fail('mounted');
  const whole = { ...controller.state.camera };

  const zoom = h.plot.fire('wheel', { clientX: xOf(500), clientY: 200, deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  h.flush();
  assert.equal(zoom.defaultPrevented, true, 'the page does not zoom');
  const zoomed = controller.state.camera;
  assert.ok(zoomed.t1 - zoomed.t0 < whole.t1 - whole.t0);
  assert.ok(zoomed.t0 < 500 && zoomed.t1 > 500, 'the time under the pointer stays in view');
  assert.ok(h.refreshed > 0, 'the zoom readout is read again');

  const t0 = zoomed.t0;
  h.plot.fire('pointerdown', pointer(xOf(300), 200));
  h.plot.fire('pointermove', pointer(xOf(300) - 5, 200));
  h.plot.fire('pointermove', pointer(xOf(300) - 80, 200));
  h.plot.fire('pointerup', pointer(xOf(300) - 80, 200));
  h.flush();
  assert.ok(controller.state.camera.t0 > t0, 'dragging left moves the window later');

  const scrollBefore = h.plot.scrollTop;
  const plain = h.plot.fire('wheel', { clientX: 400, clientY: 200, deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  assert.equal(plain.defaultPrevented, false);
  assert.equal(h.plot.scrollTop, scrollBefore);
});

test('a vertical drag scrolls the lanes through the scroller', () => {
  const h = harness();
  h.plot.fire('pointerdown', pointer(500, 300));
  h.plot.fire('pointermove', pointer(500, 295));
  h.plot.fire('pointermove', pointer(500, 200));
  h.plot.fire('pointerup', pointer(500, 200));
  assert.equal(h.plot.scrollTop, 100, 'dragging up scrolls down by the distance dragged (the scroller clamps it)');
});

test('the scroller reports its scroll position, which moves the painted lanes', () => {
  const h = harness(wideTrace(), 200);
  const { controller } = h.view.internals ?? assert.fail('mounted');
  const max = controller.state.stack.contentHeight - controller.layout.bodyHeight;
  assert.ok(max > 0, 'the wide trace is taller than the view');
  h.plot.scrollTop = 50;
  h.plot.fire('scroll');
  h.flush();
  assert.equal(controller.state.scrollTop, 50);
});

test('commands: zoom in, out and reset with a readout; expand and collapse all', () => {
  const h = harness();
  const { controller } = h.view.internals ?? assert.fail('mounted');
  assert.deepEqual(h.view.commands().map((command) => command.id), ['zoom-in', 'zoom-out', 'zoom-reset', 'expand-all', 'collapse-all']);
  assert.equal(h.command('zoom-reset').readout?.(), '100%');

  h.command('zoom-in').run();
  h.clock.frame();
  assert.ok(controller.state.camera.t1 - controller.state.camera.t0 < 1000);
  assert.notEqual(h.command('zoom-reset').readout?.(), '100%');
  h.command('zoom-reset').run();
  assert.equal(h.command('zoom-reset').readout?.(), '100%');

  assert.equal(h.command('expand-all').enabled?.(), false);
  h.command('collapse-all').run();
  assert.equal(h.command('expand-all').enabled?.(), true);
  assert.equal(h.command('collapse-all').enabled?.(), false);
});

test('options changed: peers, order and rows are read again and the spacer follows', () => {
  const h = harness();
  const { controller } = h.view.internals ?? assert.fail('mounted');
  const spacer = h.plot.children[0];
  const withPeers = controller.state.stack.count;
  const height = spacer.style.height;

  h.attributes.set('lane-peers', 'false');
  h.view.optionsChanged();
  h.clock.frame();
  assert.ok(controller.state.stack.count < withPeers, 'the peer lane is gone');
  assert.notEqual(spacer.style.height, height);

  h.attributes.delete('lane-peers');
  h.config = { laneMaxRows: 4 };
  h.view.optionsChanged();
  assert.equal(controller.settings.maxRows, 4);
  assert.equal(controller.state.stack.count, withPeers);
});

test('the filter dims through the store and the view redraws', () => {
  const h = harness();
  const scenes = h.view.painterStats?.scenes ?? 0;
  h.store.setMatched(SpanMask.of(h.view.internals?.controller.index ?? assert.fail('mounted'), ['b2']), { origin: 'test' });
  h.flush();
  assert.ok((h.view.painterStats?.scenes ?? 0) > scenes);
  const dimmed = h.surface.findAll(domStyles.barDimmed).filter((bar) => !bar.classList.contains(domStyles.hidden));
  assert.ok(dimmed.length > 0);
});

test('state round trip: the camera, the scroll position and the lane modes come back in a new view', () => {
  const h = harness();
  h.key('g');
  h.command('zoom-in').run();
  h.flush();
  const saved = h.view.getState();
  assert.ok(saved);

  const other = harness();
  other.view.setState(saved);
  const a = h.view.internals?.controller.getState();
  const b = other.view.internals?.controller.getState();
  assert.deepEqual(b?.laneModes, a?.laneModes);
  assert.equal(b?.t0, a?.t0);
  assert.equal(b?.t1, a?.t1);

  other.view.setState({ nonsense: true });
  other.view.setState(null);
  assert.equal(other.view.internals?.controller.getState().t0, a?.t0, 'a malformed state is ignored');
});

test('reveal opens a collapsed lane, pans to the span and scrolls it into view', () => {
  const h = harness();
  const { controller } = h.view.internals ?? assert.fail('mounted');
  h.key('g');
  h.command('zoom-in').run();
  h.command('zoom-in').run();
  h.command('zoom-in').run();
  h.command('zoom-in').run();
  h.flush();
  const camera = controller.state.camera;
  assert.ok(camera.t1 < 900, 'the window no longer shows bg');

  h.view.reveal('b2');
  h.flush();
  const bg = controller.model.names.indexOf('bg');
  assert.notEqual(controller.state.stack.modes[bg], LaneMode.Collapsed, 'its lane opened');
  assert.ok(controller.state.camera.t1 > 950 && controller.state.camera.t0 < 960, 'the window pans to the span');
  h.view.reveal('no-such-span');
});

test('a new trace resets the view and the live region', () => {
  const h = harness();
  h.click(xOf(500), WEB_ROW_1);
  assert.notEqual(h.live(), '');
  h.store.setData(buildSpanIndex(trace(['solo', [span('only', undefined, 0, 100)]])));
  h.flush();
  assert.equal(h.live(), '', 'the old selection is gone with the old trace');
  assert.equal(h.view.internals?.controller.model.names[0], 'solo');
  assert.equal(h.hovers.at(-1) ?? null, null);
});

test('theme changes and focus are passed on to the painter and the scroller', () => {
  const h = harness();
  const scenes = h.view.painterStats?.scenes ?? 0;
  h.view.themeChanged();
  h.clock.frame();
  assert.ok((h.view.painterStats?.scenes ?? 0) > scenes);
  h.view.focus();
  assert.equal(h.plot.focused, true);
});

test('unmount removes everything, stops listening, clears the hover and is safe to repeat', () => {
  const h = harness();
  h.hover(xOf(500), WEB_ROW_1);
  assert.ok(h.store.state.hover);
  assert.ok(h.plot.listenerCount() > 0);

  h.view.unmount();
  assert.equal(h.surface.children.length, 0);
  assert.equal(h.plot.listenerCount(), 0);
  assert.equal(h.store.state.hover, null);
  assert.equal(h.hovers.at(-1), null);
  assert.equal(h.view.internals, null);
  assert.equal(h.view.getState(), null);
  assert.deepEqual(h.view.commands(), []);
  h.view.unmount();
  h.view.update({ mask: 1, origin: 'x', prev: h.store.state });
  h.view.reveal('w');
});

test('mounting twice builds nothing twice', () => {
  const h = harness();
  const children = h.surface.children.length;
  h.view.mount(new InteractiveElement('div') as unknown as HTMLElement, { origin: 'again', store: h.store, options: () => ({ config: {}, attribute: () => null }), hover: () => undefined, refreshCommands: () => undefined });
  assert.equal(h.surface.children.length, children);
});
