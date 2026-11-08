/**
 * SequenceView and sequenceDefinition unit tests: registration, toolbar commands,
 * readouts, refreshCommands(), state persistence, and view lifecycle.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setFileScope } from '@vanilla-extract/css/fileScope';
import {
  SpanKind,
  buildSpanIndex,
  createTraceStore,
  type SpanIndex,
  type TraceStore,
} from '../../../src/core.ts';
import type { ViewCommand } from '../../../src/kit/commands.ts';
import { createFrameScheduler } from '../../../src/kit/scheduler.ts';
import {
  getView,
  registerView,
  type ViewContext,
  type ViewHit,
} from '../../../src/kit/view.ts';
import type { ViewOptions } from '../../../src/kit/view-options.ts';
import { createFakeClock, type FakeClock } from '../../support/fake-frame.ts';
import { FakeElement, FakeResizeObserver, installFakeDom } from '../../support/fake-dom-tree.ts';
import { span, trace } from '../../support/trace-builder.ts';

setFileScope('src/views/sequence/view.css.ts');
const { SequenceView, sequenceDefinition } = await import(
  '../../../src/views/sequence/view.ts'
);

class InteractiveFakeElement extends FakeElement {
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 800;
  clientHeight = 400;
  scrollTop = 0;
  scrollLeft = 0;
  focused = false;
  readonly listeners = new Map<string, Set<(event: Event) => void>>();

  override addEventListener(type?: string, listener?: (event: Event) => void): void {
    if (type === undefined || listener === undefined) return;
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect(): { readonly left: number; readonly top: number } {
    return { left: 0, top: 0 };
  }

  setPointerCapture(): void {}

  releasePointerCapture(): void {}

  focus(): void {
    this.focused = true;
  }
}

let restoreDom: () => void;
let savedRaf: unknown;
let savedCaf: unknown;

before(() => {
  restoreDom = installFakeDom();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = {
    createElement: (tag: string) => new InteractiveFakeElement(tag),
  };
  savedRaf = globals.requestAnimationFrame;
  savedCaf = globals.cancelAnimationFrame;
  globals.requestAnimationFrame = () => 1;
  globals.cancelAnimationFrame = () => undefined;
});

after(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame = savedRaf;
  globals.cancelAnimationFrame = savedCaf;
  restoreDom();
});

function buildSampleIndex(): SpanIndex {
  return buildSpanIndex(
    trace(
      [
        'api-gw',
        [
          span('gw-root', undefined, 0, 200, {
            name: 'GET /orders',
            kind: SpanKind.Server,
          }),
          span('gw-internal', 'gw-root', 10, 20, {
            name: 'parseHeaders',
            kind: SpanKind.Internal,
          }),
          span('gw-client', 'gw-root', 30, 180, {
            name: 'OrderService/List',
            kind: SpanKind.Client,
          }),
        ],
      ],
      [
        'order-svc',
        [
          span('order-srv', 'gw-client', 35, 175, {
            name: 'ListOrders',
            kind: SpanKind.Server,
            status: { code: 2, message: 'DB timeout' },
          }),
        ],
      ],
    ),
  );
}

interface ViewHarness {
  readonly store: TraceStore;
  readonly view: InstanceType<typeof SequenceView>;
  readonly surface: InteractiveFakeElement;
  readonly clock: FakeClock;
  readonly hovers: Array<ViewHit | null>;
  refreshCount: number;
  config: Record<string, unknown>;
  attributes: Map<string, string>;
  command(id: string): ViewCommand;
}

function createViewHarness(): ViewHarness {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSampleIndex());
  store.flushSync();

  const clock = createFakeClock();
  const scheduler = createFrameScheduler(clock);
  const view = new SequenceView(scheduler);
  const surface = new InteractiveFakeElement('div');
  const hovers: Array<ViewHit | null> = [];
  const attributes = new Map<string, string>();

  const harness: ViewHarness = {
    store,
    view,
    surface,
    clock,
    hovers,
    refreshCount: 0,
    config: {},
    attributes,
    command(id: string): ViewCommand {
      const found = view.commands().find((cmd) => cmd.id === id);
      assert.ok(found !== undefined, `Expected command ${id}`);
      return found;
    },
  };

  const ctx: ViewContext = {
    origin: 'sequence-test',
    store,
    options: (): ViewOptions => ({
      config: harness.config,
      attribute: (name: string) => attributes.get(name) ?? null,
    }),
    hover: (hit) => hovers.push(hit),
    refreshCommands: () => {
      harness.refreshCount++;
    },
  };

  view.mount(surface as unknown as HTMLElement, ctx);
  clock.frame();
  return harness;
}

test('sequenceDefinition describes the sequence view and resolves via getView when registered', () => {
  assert.equal(sequenceDefinition.id, 'sequence');
  assert.equal(sequenceDefinition.label, 'Sequence');
  assert.deepEqual(sequenceDefinition.renderers, ['dom']);
  assert.deepEqual(sequenceDefinition.capabilities, { legend: true });

  registerView(sequenceDefinition);
  const registered = getView('sequence');
  assert.equal(registered, sequenceDefinition);

  const created = sequenceDefinition.create();
  assert.equal(created.renderer, 'dom');
});

test('SequenceView commands toggle internal, returns, matchesOnly, hideUnaffectedColumns, fitColumns, and density zoom, calling refreshCommands()', () => {
  const h = createViewHarness();
  const internals = h.view.internals;
  assert.ok(internals !== null);
  const { controller } = internals;

  const cmds = h.view.commands();
  assert.deepEqual(
    cmds.map((c) => c.id),
    [
      'sequence.internal',
      'sequence.returns',
      'sequence.matches-only',
      'sequence.hide-unaffected',
      'sequence.fit-columns',
      'sequence.density-out',
      'sequence.density-in',
    ],
  );

  // 1. sequence.internal cycles 'auto' -> 'show' -> 'hide' -> 'auto'
  const internalCmd = h.command('sequence.internal');
  assert.equal(internalCmd.label, 'Internal spans');
  assert.deepEqual(internalCmd.keys, ['i', 'I']);
  assert.equal(internalCmd.readout?.(), 'auto');

  const beforeRefresh1 = h.refreshCount;
  internalCmd.run();
  assert.equal(controller.viewState.internal, 'show');
  assert.equal(internalCmd.readout?.(), 'show');
  assert.equal(h.refreshCount, beforeRefresh1 + 1);

  internalCmd.run();
  assert.equal(controller.viewState.internal, 'hide');
  assert.equal(internalCmd.readout?.(), 'hide');
  assert.equal(h.refreshCount, beforeRefresh1 + 2);

  internalCmd.run();
  assert.equal(controller.viewState.internal, 'auto');
  assert.equal(internalCmd.readout?.(), 'auto');
  assert.equal(h.refreshCount, beforeRefresh1 + 3);

  // 2. sequence.returns cycles 'all' -> 'errors' -> 'none' -> 'all'
  const returnsCmd = h.command('sequence.returns');
  assert.equal(returnsCmd.label, 'Returns');
  assert.equal(returnsCmd.readout?.(), 'all');

  const beforeRefresh2 = h.refreshCount;
  returnsCmd.run();
  assert.equal(controller.viewState.returns, 'errors');
  assert.equal(returnsCmd.readout?.(), 'errors');
  assert.equal(h.refreshCount, beforeRefresh2 + 1);

  returnsCmd.run();
  assert.equal(controller.viewState.returns, 'none');
  assert.equal(returnsCmd.readout?.(), 'none');
  assert.equal(h.refreshCount, beforeRefresh2 + 2);

  returnsCmd.run();
  assert.equal(controller.viewState.returns, 'all');
  assert.equal(returnsCmd.readout?.(), 'all');
  assert.equal(h.refreshCount, beforeRefresh2 + 3);

  // 3. sequence.matches-only toggles 'off' <-> 'on'
  const matchesCmd = h.command('sequence.matches-only');
  assert.equal(matchesCmd.label, 'Matches only');
  assert.equal(matchesCmd.readout?.(), 'off');

  const beforeRefresh3 = h.refreshCount;
  matchesCmd.run();
  assert.equal(controller.viewState.matchesOnly, true);
  assert.equal(matchesCmd.readout?.(), 'on');
  assert.equal(h.refreshCount, beforeRefresh3 + 1);

  matchesCmd.run();
  assert.equal(controller.viewState.matchesOnly, false);
  assert.equal(matchesCmd.readout?.(), 'off');
  assert.equal(h.refreshCount, beforeRefresh3 + 2);

  // 4. sequence.hide-unaffected toggles 'all' <-> 'active'
  const hideCmd = h.command('sequence.hide-unaffected');
  assert.equal(hideCmd.label, 'Active lifelines');
  assert.equal(hideCmd.readout?.(), 'all');

  const beforeRefresh4 = h.refreshCount;
  hideCmd.run();
  assert.equal(controller.viewState.hideUnaffectedColumns, true);
  assert.equal(hideCmd.readout?.(), 'active');
  assert.equal(h.refreshCount, beforeRefresh4 + 1);

  hideCmd.run();
  assert.equal(controller.viewState.hideUnaffectedColumns, false);
  assert.equal(hideCmd.readout?.(), 'all');
  assert.equal(h.refreshCount, beforeRefresh4 + 2);

  // 5. sequence.fit-columns toggles 'fixed' <-> 'fit'
  const fitCmd = h.command('sequence.fit-columns');
  assert.equal(fitCmd.label, 'Fit columns');
  assert.deepEqual(fitCmd.keys, ['f', 'F']);
  assert.equal(fitCmd.readout?.(), 'fixed');

  const beforeRefresh5 = h.refreshCount;
  fitCmd.run();
  assert.equal(controller.viewState.fitColumns, true);
  assert.equal(fitCmd.readout?.(), 'fit');
  assert.equal(h.refreshCount, beforeRefresh5 + 1);

  fitCmd.run();
  assert.equal(controller.viewState.fitColumns, false);
  assert.equal(fitCmd.readout?.(), 'fixed');
  assert.equal(h.refreshCount, beforeRefresh5 + 2);

  // 6. sequence.density-in and sequence.density-out adjust rowHeight and call refreshCommands()
  const densityInCmd = h.command('sequence.density-in');
  const densityOutCmd = h.command('sequence.density-out');
  assert.equal(densityInCmd.label, 'Density +');
  assert.deepEqual(densityInCmd.keys, ['=', '+']);
  assert.equal(densityOutCmd.label, 'Density −');
  assert.deepEqual(densityOutCmd.keys, ['-']);

  const initialRowHeight = controller.viewState.rowHeight;
  const beforeRefresh6 = h.refreshCount;
  densityInCmd.run();
  assert.ok(controller.viewState.rowHeight > initialRowHeight);
  assert.equal(h.refreshCount, beforeRefresh6 + 1);

  const zoomedInRowHeight = controller.viewState.rowHeight;
  densityOutCmd.run();
  assert.ok(controller.viewState.rowHeight < zoomedInRowHeight);
  assert.equal(h.refreshCount, beforeRefresh6 + 2);

  h.view.unmount();
});

test('SequenceView lifecycle: mount, optionsChanged, reveal, aria-activedescendant, state round-trip, and unmount', () => {
  const h = createViewHarness();
  assert.equal(h.surface.children.length, 1);

  const scroller = h.surface.children[0] as unknown as InteractiveFakeElement;
  assert.equal(scroller.getAttribute('part'), 'plot');
  assert.equal(scroller.getAttribute('role'), 'treegrid');
  assert.equal(scroller.getAttribute('aria-label'), 'Sequence diagram');
  assert.equal(scroller.getAttribute('aria-activedescendant'), '');

  // Resize via ResizeObserver
  const observer = FakeResizeObserver.instances.at(-1);
  assert.ok(observer !== undefined);
  observer.fire(1000, 500);
  h.clock.frame();
  assert.equal(h.view.internals?.controller.viewState.viewWidth, 1000);
  assert.equal(h.view.internals?.controller.viewState.viewHeight, 500);

  // Reveal a span updates focusStep and aria-activedescendant on paint
  h.view.reveal('order-srv');
  h.clock.frame();
  const focusStep = h.view.internals?.controller.viewState.focusStep ?? -1;
  assert.ok(focusStep >= 0);
  assert.equal(
    scroller.getAttribute('aria-activedescendant'),
    `l2t-seq-step-${focusStep}`,
  );

  // optionsChanged re-reads settings and refreshes commands
  h.attributes.set('sequence-internal', 'show');
  h.attributes.set('sequence-returns', 'errors');
  const beforeOptionsRefresh = h.refreshCount;
  h.view.optionsChanged();
  h.clock.frame();
  assert.equal(h.view.internals?.controller.viewState.internal, 'show');
  assert.equal(h.view.internals?.controller.viewState.returns, 'errors');
  assert.equal(h.refreshCount, beforeOptionsRefresh + 1);

  // Save and restore state
  const saved = h.view.getState();
  h.command('sequence.fit-columns').run();
  assert.equal(h.view.internals?.controller.viewState.fitColumns, true);
  h.view.setState(saved);
  assert.equal(h.view.internals?.controller.viewState.fitColumns, false);

  // Focus and unmount
  h.view.focus();
  assert.equal(scroller.focused, true);

  h.view.unmount();
  assert.equal(h.surface.children.length, 0);
  assert.deepEqual(h.view.commands(), []);
});
