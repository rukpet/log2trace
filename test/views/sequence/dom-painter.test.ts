/**
 * Sequence Diagram DOM painter unit tests against the fake DOM.
 *
 * Verifies header cards, lifelines, activations, event ticks, modulo-indexed
 * step row pooling (`s mod P`), bounded pool growth across 500+ steps,
 * zero-rewrite slot reuse on vertical scroll, selection/hover class toggling,
 * and `destroy()` cleanup.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SPAN_SET,
  SpanKind,
  buildSpanIndex,
  spanSetOf,
  type SpanSet,
} from '../../../src/core.ts';
import { SequenceDirty } from '../../../src/views/sequence/model/interaction.ts';
import { computeSequenceLayout } from '../../../src/views/sequence/model/layout.ts';
import { buildSequenceModel } from '../../../src/views/sequence/model/messages.ts';
import { GATE_NAME } from '../../../src/views/sequence/model/participants.ts';
import { SequencePlan, buildSequencePlan } from '../../../src/views/sequence/model/plan.ts';
import { projectSteps, type SequenceSteps } from '../../../src/views/sequence/model/steps.ts';
import {
  createSequenceDomPainter,
  type SequenceDomClasses,
} from '../../../src/views/sequence/paint/dom.ts';
import { FakeElement, installFakeDom } from '../../support/fake-dom-tree.ts';
import { event, kv, span, trace } from '../../support/trace-builder.ts';

let restoreDom: () => void;
before(() => {
  restoreDom = installFakeDom();
});
after(() => {
  restoreDom();
});

/** Proxy class names that spell what they are (`styles.rowHover` -> `'rowHover'`, `styles.activationKind.server` -> `'activationKind.server'`). */
function fakeSequenceClasses(): SequenceDomClasses {
  const group = (prefix: string): unknown =>
    new Proxy(
      {},
      { get: (_target, key) => (typeof key === 'string' ? `${prefix}.${key}` : undefined) },
    );
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== 'string') return undefined;
        if (key === 'activationKind') return group(key);
        return key;
      },
    },
  ) as SequenceDomClasses;
}

function parseTranslateY(el: FakeElement): number {
  const match = /translateY\((-?[\d.]+)px\)/.exec(String(el.style.transform ?? ''));
  return Number(match?.[1] ?? 0);
}

function visibleRowElements(host: FakeElement): FakeElement[] {
  return host
    .findAll('row')
    .filter((row) => row.style.display !== 'none')
    .sort((a, b) => parseTranslateY(a) - parseTranslateY(b));
}

test('painting a multi-service trace populates header cards, lifelines, activations, event ticks, and visible step rows', () => {
  const index = buildSpanIndex(
    trace(
      [
        'api-gw',
        [
          span('gw-srv', undefined, 0, 300, {
            name: 'POST /orders',
            kind: SpanKind.Server,
            parentSpanId: 'external-caller',
            events: [event('auth.ok', 10)],
          }),
          span('gw-self', 'gw-srv', 15, 25, {
            name: 'validatePayload',
            kind: SpanKind.Internal,
          }),
          span('gw-cli', 'gw-srv', 30, 90, {
            name: 'ChargePayment',
            kind: SpanKind.Client,
          }),
          span('gw-db', 'gw-srv', 220, 250, {
            name: 'INSERT orders',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgresql'), kv('server.address', 'orders-db')],
          }),
        ],
      ],
      [
        'billing',
        [
          span('bill-srv', 'gw-cli', 35, 85, {
            name: 'ProcessCharge',
            kind: SpanKind.Server,
            status: { code: 2, message: 'card declined' },
            events: [event('exception', 60)],
          }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model, null, null, null, { internal: 'show' });
  const layout = computeSequenceLayout({
    viewWidth: 960,
    viewHeight: 600,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });

  const plan = new SequencePlan();
  buildSequencePlan(plan, {
    steps,
    layout,
    scrollTop: 0,
    scrollLeft: 0,
    selection: EMPTY_SPAN_SET,
    hover: null,
  });

  const host = new FakeElement('div');
  const painter = createSequenceDomPainter(
    { host: host as unknown as HTMLElement },
    fakeSequenceClasses(),
  );

  painter.paint(plan, SequenceDirty.All);

  // Stage structure
  assert.equal(host.children.length, 1);
  const stage = host.children[0];
  assert.equal(stage?.classList.contains('stage'), true);

  // Header cards & lifelines (Gate + api-gw + billing + orders-db = 4 columns)
  const cards = stage.findAll('headerCard').filter((el) => el.style.display !== 'none');
  const lifelines = stage.findAll('lifeline').filter((el) => el.style.display !== 'none');
  assert.equal(cards.length, 4);
  assert.equal(lifelines.length, 4);

  const gateCard = cards[0];
  assert.equal(gateCard?.findAll('headerTitle')[0]?.textContent, GATE_NAME);
  assert.equal(gateCard?.findAll('headerSubtitle')[0]?.textContent, 'entry');
  assert.equal(gateCard?.classList.contains('headerCardGate'), true);

  const inferredCard = cards.find((c) => c.classList.contains('headerCardInferred'));
  assert.ok(inferredCard);
  assert.equal(inferredCard.findAll('headerSubtitle')[0]?.textContent, 'external');
  assert.equal(inferredCard.findAll('headerTitle')[0]?.textContent, 'postgresql');

  const billingCard = cards.find((c) => c.findAll('headerTitle')[0]?.textContent === 'billing');
  assert.ok(billingCard);
  assert.equal(billingCard.findAll('headerSubtitle')[0]?.textContent, 'service');
  assert.equal(billingCard.classList.contains('headerCardError'), true);

  // Activations
  const acts = stage.findAll('activation').filter((el) => el.style.display !== 'none');
  assert.equal(acts.length, plan.actCount);
  assert.equal(painter.stats().activeActs, plan.actCount);
  assert.ok(acts.some((el) => el.classList.contains('activationKind.server')));
  assert.ok(acts.some((el) => el.classList.contains('activationError')));

  // Event ticks (1 normal + 1 exception)
  const ticks = stage.findAll('eventTick').filter((el) => el.style.display !== 'none');
  assert.equal(ticks.length, 2);
  assert.equal(painter.stats().activeTicks, 2);
  assert.equal(
    ticks.filter((el) => el.classList.contains('eventTickException')).length,
    1,
  );

  // Visible step rows
  const rows = visibleRowElements(host);
  assert.equal(rows.length, steps.count);
  assert.equal(painter.stats().activeRows, steps.count);
  assert.equal(painter.stats().rowSlots, steps.count + 2);

  // Check self-call row has selfLoop visible and straight arrowLine hidden
  const selfRow = rows.find((r) =>
    r.findAll('arrowLabel')[0]?.textContent.includes('validatePayload'),
  );
  assert.ok(selfRow);
  assert.equal(selfRow.findAll('arrowSelfLoop')[0]?.style.display, '');
  assert.equal(selfRow.findAll('arrowLine')[0]?.style.display, 'none');

  // Check error call row has error classes and badge
  const chargeRow = rows.find((r) =>
    r.findAll('arrowLabel')[0]?.textContent.includes('ProcessCharge'),
  );
  assert.ok(chargeRow);
  assert.equal(chargeRow.classList.contains('rowError'), true);
  assert.equal(chargeRow.findAll('arrowLine')[0]?.classList.contains('arrowLineError'), true);
  assert.equal(chargeRow.findAll('arrowBadge')[0]?.style.display, '');

  // Check return arrow row has dashed line and open arrowhead
  const returnRow = rows.find((r) =>
    (r.findAll('arrowLabel')[0]?.textContent ?? '').startsWith('50.00ms'),
  );
  assert.ok(returnRow);
  assert.equal(returnRow.findAll('arrowLine')[0]?.classList.contains('arrowLineDashed'), true);

  // Check gap banner on 'INSERT orders' step after idle gap
  const dbRow = rows.find((r) =>
    r.findAll('arrowLabel')[0]?.textContent.includes('INSERT orders'),
  );
  assert.ok(dbRow);
  assert.equal(dbRow.findAll('gapBanner')[0]?.style.display, '');
  assert.ok((dbRow.findAll('gapBanner')[0]?.textContent ?? '').startsWith('≈ +'));
});

test('pool size stays bounded and scrolling reuses modulo slots without reallocating or rewriting still-visible rows', () => {
  // Build a trace with 260 distinct cross-service calls -> 520 steps (Call + Return)
  const clientSpans = [
    span('root-srv', undefined, 0, 6000, { name: 'Root', kind: SpanKind.Server }),
  ];
  const workerSpans = [];
  for (let i = 0; i < 260; i++) {
    const t0 = 10 + i * 20;
    clientSpans.push(
      span(`cli-${i}`, 'root-srv', t0, t0 + 10, {
        name: `StepCall-${i}`,
        kind: SpanKind.Client,
      }),
    );
    workerSpans.push(
      span(`wrk-${i}`, `cli-${i}`, t0 + 1, t0 + 9, {
        name: `StepWork-${i}`,
        kind: SpanKind.Server,
      }),
    );
  }

  const index = buildSpanIndex(
    trace(['frontend', clientSpans], ['backend', workerSpans]),
  );
  const model = buildSequenceModel(index);
  const steps: SequenceSteps = projectSteps(model, null, null, null, { foldMin: 0 });
  assert.ok(steps.count >= 500, `expected >= 500 steps, got ${steps.count}`);

  // Viewport: headerHeight=44, bodyViewportHeight=280 -> 10 visible rows + overscan (4 each side) -> at most 19 visible rows
  const layout = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 44 + 28 * 10,
    columnCount: model.participants.count,
    rowCount: steps.count,
    rowHeight: 28,
  });

  const host = new FakeElement('div');
  const painter = createSequenceDomPainter(
    { host: host as unknown as HTMLElement },
    fakeSequenceClasses(),
  );
  const plan = new SequencePlan();

  function scrollAt(scrollTop: number): void {
    buildSequencePlan(plan, {
      steps,
      layout,
      scrollTop,
      scrollLeft: 0,
      selection: EMPTY_SPAN_SET,
      hover: null,
      overscanRows: 2,
    });
    painter.paint(plan, SequenceDirty.Scroll);
  }

  scrollAt(0);
  const initialPoolSize = painter.stats().rowSlots;
  assert.ok(initialPoolSize <= 20, `pool size at top: ${initialPoolSize}`);

  // Scroll to step 100
  scrollAt(28 * 100);
  const midPoolSize = painter.stats().rowSlots;
  assert.ok(
    midPoolSize <= plan.stepCount + 2,
    `pool size (${midPoolSize}) must stay <= visible (${plan.stepCount}) + 2`,
  );

  // Record the exact FakeElement reference for step 105 and spy on its style.transform writes
  const poolElementsBefore = [...host.findAll('row')];
  const step105El = poolElementsBefore.find((el) => el.getAttribute('id') === 'l2t-seq-step-105');
  assert.ok(step105El, 'step 105 should be in view');
  const step105Gutter = step105El.findAll('gutterCell')[0];
  assert.ok(step105Gutter);

  let transformWrites = 0;
  let currentTransform = String(step105El.style.transform ?? '');
  Object.defineProperty(step105El.style, 'transform', {
    configurable: true,
    get() {
      return currentTransform;
    },
    set(v: string) {
      transformWrites++;
      currentTransform = v;
    },
  });

  // Scroll by 1 row (to step 101): step 105 remains in view at the exact same modulo slot and Y!
  scrollAt(28 * 101);

  const poolElementsAfter = [...host.findAll('row')];
  assert.equal(poolElementsAfter.length, poolElementsBefore.length, 'no new row elements allocated');
  for (let k = 0; k < poolElementsAfter.length; k++) {
    assert.equal(poolElementsAfter[k], poolElementsBefore[k], 'same pooled FakeElement instances');
  }

  const step105ElAfter = poolElementsAfter.find(
    (el) => el.getAttribute('id') === 'l2t-seq-step-105',
  );
  assert.equal(step105ElAfter, step105El, 'step 105 stayed in the same modulo slot element');
  assert.equal(transformWrites, 0, 'step 105 transform was not rewritten on vertical scroll');

  // Scroll all the way through the 500+ step trace and verify pool stays bounded
  for (let s = 150; s < steps.count; s += 50) {
    scrollAt(28 * s);
    assert.ok(
      painter.stats().rowSlots <= 20,
      `pool size stayed bounded at ${painter.stats().rowSlots}`,
    );
  }
});

test('selection and hover toggle rowSelected / rowHover and activationSelected / activationHover classes', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-srv', undefined, 0, 100, { name: 'EntryA', kind: SpanKind.Server }),
          span('a-cli-1', 'a-srv', 10, 40, { name: 'CallB1', kind: SpanKind.Client }),
          span('a-cli-2', 'a-srv', 50, 80, { name: 'CallB2', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [
          span('b-srv-1', 'a-cli-1', 12, 38, { name: 'WorkB1', kind: SpanKind.Server }),
          span('b-srv-2', 'a-cli-2', 52, 78, { name: 'WorkB2', kind: SpanKind.Server }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model);
  const layout = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 500,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });

  const host = new FakeElement('div');
  const painter = createSequenceDomPainter(
    { host: host as unknown as HTMLElement },
    fakeSequenceClasses(),
  );
  const plan = new SequencePlan();

  function renderOverlay(selection: SpanSet, hover: SpanSet | null): void {
    buildSequencePlan(plan, {
      steps,
      layout,
      scrollTop: 0,
      scrollLeft: 0,
      selection,
      hover,
    });
    painter.paint(plan, SequenceDirty.Overlay);
  }

  // Initial paint with no selection or hover
  renderOverlay(EMPTY_SPAN_SET, null);
  assert.equal(
    visibleRowElements(host).filter((r) => r.classList.contains('rowSelected')).length,
    0,
  );
  assert.equal(
    visibleRowElements(host).filter((r) => r.classList.contains('rowHover')).length,
    0,
  );

  // Select 'b-srv-1' and hover 'b-srv-2'
  renderOverlay(spanSetOf(['b-srv-1']), spanSetOf(['b-srv-2']));

  const selectedRows = visibleRowElements(host).filter((r) =>
    r.classList.contains('rowSelected'),
  );
  const hoveredRows = visibleRowElements(host).filter((r) => r.classList.contains('rowHover'));
  // Call + Return rows for b-srv-1 are selected, Call + Return rows for b-srv-2 are hovered
  assert.equal(selectedRows.length, 2);
  assert.equal(selectedRows[0]?.getAttribute('aria-selected'), 'true');
  assert.equal(hoveredRows.length, 2);

  const acts = host.findAll('activation').filter((el) => el.style.display !== 'none');
  assert.equal(acts.filter((a) => a.classList.contains('activationSelected')).length, 1);
  assert.equal(acts.filter((a) => a.classList.contains('activationHover')).length, 1);

  // Move selection to 'b-srv-2' and clear hover
  renderOverlay(spanSetOf(['b-srv-2']), null);
  assert.equal(
    visibleRowElements(host).filter((r) => r.classList.contains('rowHover')).length,
    0,
  );
  assert.equal(acts.filter((a) => a.classList.contains('activationHover')).length, 0);
  assert.equal(acts.filter((a) => a.classList.contains('activationSelected')).length, 1);
});

test('destroy() removes stage from host and resets pool stats', () => {
  const index = buildSpanIndex(
    trace(['svc-a', [span('a-1', undefined, 0, 50, { name: 'Op', kind: SpanKind.Server })]]),
  );
  const model = buildSequenceModel(index);
  const steps = projectSteps(model);
  const layout = computeSequenceLayout({
    viewWidth: 600,
    viewHeight: 400,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });
  const plan = new SequencePlan();
  buildSequencePlan(plan, {
    steps,
    layout,
    scrollTop: 0,
    scrollLeft: 0,
    selection: EMPTY_SPAN_SET,
    hover: null,
  });

  const host = new FakeElement('div');
  const painter = createSequenceDomPainter(
    { host: host as unknown as HTMLElement },
    fakeSequenceClasses(),
  );
  painter.paint(plan, SequenceDirty.All);
  assert.equal(host.children.length, 1);
  assert.ok(painter.stats().rowSlots > 0);

  painter.destroy();
  assert.equal(host.children.length, 0);
  assert.deepEqual(painter.stats(), {
    rowSlots: 0,
    activeRows: 0,
    actSlots: 0,
    activeActs: 0,
    tickSlots: 0,
    activeTicks: 0,
  });
});
