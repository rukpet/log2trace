import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpanKind,
  SpanMask,
  buildSpanIndex,
  createTraceStore,
  type ChangeSet,
  type SpanIndex,
  type TraceStore,
} from '../../../src/core.ts';
import { SequenceController } from '../../../src/views/sequence/controller.ts';
import { HitKind, NO_SEQUENCE_HIT, type SequenceHit } from '../../../src/views/sequence/model/hit.ts';
import { SequenceDirty } from '../../../src/views/sequence/model/interaction.ts';
import { GATE_NAME } from '../../../src/views/sequence/model/participants.ts';
import { StepKind } from '../../../src/views/sequence/model/steps.ts';
import { event, kv, span, trace } from '../../support/trace-builder.ts';

const DUMMY_ANCHOR = Object.freeze({ x: 10, y: 20, w: 30, h: 20 });

function makeHit(
  kind: HitKind,
  index: number,
  row = -1,
  eventIdx = -1,
): SequenceHit {
  return {
    kind,
    index,
    row,
    eventIdx,
    anchor: DUMMY_ANCHOR,
  };
}

/**
 * Multi-service trace with:
 * - Entry: Gate -> api-gw (`gw-root`, SERVER, 0..500)
 *   - Internal child inside api-gw (`gw-internal`, INTERNAL, 5..15)
 *   - Sync call: api-gw (`gw-to-order`, CLIENT, 20..300) -> order-svc (`order-srv`, SERVER, 25..290)
 *     - 4 consecutive DB queries from order-svc (`db-1`..`db-4`, CLIENT, peer `postgres`, 30..70) -> folded into loop ×4
 *     - Error call: order-svc (`order-to-pay`, CLIENT, 100..200) -> payment-svc (`pay-srv`, SERVER, status=2 Error, 105..195)
 */
function buildSampleTrace(): SpanIndex {
  return buildSpanIndex(
    trace(
      [
        'api-gw',
        [
          span('gw-root', undefined, 0, 500, {
            name: 'POST /checkout',
            kind: SpanKind.Server,
            events: [event('auth.verified', 3, [kv('user', 'u-1')])],
          }),
          span('gw-internal', 'gw-root', 5, 15, {
            name: 'validatePayload',
            kind: SpanKind.Internal,
          }),
          span('gw-to-order', 'gw-root', 20, 300, {
            name: 'OrderService/Create',
            kind: SpanKind.Client,
          }),
        ],
      ],
      [
        'order-svc',
        [
          span('order-srv', 'gw-to-order', 25, 290, {
            name: 'CreateOrder',
            kind: SpanKind.Server,
          }),
          span('db-1', 'order-srv', 30, 38, {
            name: 'SELECT item',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgresql'), kv('server.address', 'postgres')],
          }),
          span('db-2', 'order-srv', 40, 48, {
            name: 'SELECT item',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgresql'), kv('server.address', 'postgres')],
          }),
          span('db-3', 'order-srv', 50, 58, {
            name: 'SELECT item',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgresql'), kv('server.address', 'postgres')],
          }),
          span('db-4', 'order-srv', 60, 68, {
            name: 'SELECT item',
            kind: SpanKind.Client,
            attributes: [kv('db.system', 'postgresql'), kv('server.address', 'postgres')],
          }),
          span('order-to-pay', 'order-srv', 100, 200, {
            name: 'PaymentService/Charge',
            kind: SpanKind.Client,
          }),
        ],
      ],
      [
        'payment-svc',
        [
          span('pay-srv', 'order-to-pay', 105, 195, {
            name: 'ChargeCard',
            kind: SpanKind.Server,
            status: { code: 2, message: 'Card declined' },
          }),
        ],
      ],
    ),
  );
}

interface TestHarness {
  readonly store: TraceStore;
  readonly controller: SequenceController;
  readonly index: SpanIndex;
  readonly hoveredHits: Array<SequenceHit | null>;
  readonly scrolledPositions: Array<{ scrollTop: number; scrollLeft?: number }>;
  flush(): number;
}

function createHarness(index: SpanIndex = buildSampleTrace()): TestHarness {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(index);
  store.flushSync();

  const hoveredHits: Array<SequenceHit | null> = [];
  const scrolledPositions: Array<{ scrollTop: number; scrollLeft?: number }> = [];

  const controller = new SequenceController({
    store,
    origin: 'seq-view',
    onHover: (hit) => hoveredHits.push(hit),
    onScrollTo: (scrollTop, scrollLeft) => scrolledPositions.push({ scrollTop, scrollLeft }),
  });
  controller.handleInput({ type: 'resize', width: 900, height: 400 });
  controller.buildPlan();

  const pendingChanges: ChangeSet[] = [];
  store.subscribe((change) => pendingChanges.push(change));

  return {
    store,
    controller,
    index,
    hoveredHits,
    scrolledPositions,
    flush(): number {
      store.flushSync();
      let dirty = SequenceDirty.None;
      for (const change of pendingChanges.splice(0)) {
        dirty |= controller.handleStoreChange(change);
      }
      return dirty;
    },
  };
}

test('clicking a step selects {via, row} in the store with primary = row and key = "msg:<row>"', () => {
  const h = createHarness();
  const steps = h.controller.steps;
  assert.ok(steps !== null);

  const rowOrderSrv = h.index.spans.get('order-srv')?.idx ?? -1;
  const rowGwToOrder = h.index.spans.get('gw-to-order')?.idx ?? -1;
  assert.ok(rowOrderSrv >= 0 && rowGwToOrder >= 0);

  // Step 1 is the synchronous call gw-to-order -> order-srv
  const callStep = steps.stepOfRow[rowOrderSrv];
  assert.equal(callStep, 1);
  assert.equal(steps.row[callStep], rowOrderSrv);
  assert.equal(steps.via[callStep], rowGwToOrder);

  const res = h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Step, callStep, rowOrderSrv),
  });

  assert.equal(res.handled, true);
  assert.ok((res.dirty & SequenceDirty.Overlay) !== 0);
  assert.equal(h.controller.viewState.focusStep, callStep);

  const sel = h.store.state.selection;
  assert.equal(sel.primary, 'order-srv');
  assert.equal(sel.key, `msg:${rowOrderSrv}`);
  assert.equal(sel.origin, 'seq-view');
  assert.deepEqual([...sel.ids].sort(), ['gw-to-order', 'order-srv']);
});

test('clicking a participant header selects all spans of that participant', () => {
  const h = createHarness();
  const steps = h.controller.steps;
  assert.ok(steps !== null);

  const orderPartIdx = steps.model.participants.names.indexOf('order-svc');
  assert.ok(orderPartIdx >= 0);

  const res = h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Participant, orderPartIdx),
  });

  assert.equal(res.handled, true);
  const sel = h.store.state.selection;
  assert.equal(sel.key, `p:${orderPartIdx}`);
  assert.deepEqual(
    [...sel.ids].sort(),
    ['db-1', 'db-2', 'db-3', 'db-4', 'order-srv', 'order-to-pay'],
  );
  // Longest span on order-svc is order-srv (duration 265ms)
  assert.equal(sel.primary, 'order-srv');

  // Clicking Gate participant selects gw-root
  const gatePartIdx = steps.model.participants.names.indexOf(GATE_NAME);
  assert.ok(gatePartIdx >= 0);
  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Participant, gatePartIdx),
  });
  assert.deepEqual([...h.store.state.selection.ids], ['gw-root']);
  assert.equal(h.store.state.selection.key, `p:${gatePartIdx}`);
});

test('clicking an activation, event tick, and empty area updates selection and focusStep', () => {
  const h = createHarness();
  const steps = h.controller.steps;
  assert.ok(steps !== null);

  // Collapse order-srv so its activation has hiddenCount > 0
  h.store.toggleCollapse('order-srv');
  h.flush();

  const collapsedSteps = h.controller.steps;
  assert.ok(collapsedSteps !== null);
  const rowOrderSrv = h.index.spans.get('order-srv')?.idx ?? -1;
  const orderStep = collapsedSteps.stepOfRow[rowOrderSrv];
  const actIdx = collapsedSteps.actIndex[orderStep];
  assert.ok(actIdx >= 0);
  assert.ok(collapsedSteps.act.hiddenCount[actIdx] > 0);

  // Clicking collapsed activation still selects spansOfActivation and sets focusStep = startStep
  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Activation, actIdx, rowOrderSrv),
  });
  assert.equal(h.controller.viewState.focusStep, collapsedSteps.act.startStep[actIdx]);
  assert.equal(h.store.state.selection.primary, 'order-srv');
  assert.equal(h.store.state.selection.key, `act:${rowOrderSrv}`);
  assert.deepEqual([...h.store.state.selection.ids].sort(), ['gw-to-order', 'order-srv']);

  // Clicking an EventTick selects the span row with key "ev:<row>:<eventIdx>"
  const rowGwRoot = h.index.spans.get('gw-root')?.idx ?? -1;
  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.EventTick, 0, rowGwRoot, 0),
  });
  assert.deepEqual([...h.store.state.selection.ids], ['gw-root']);
  assert.equal(h.store.state.selection.primary, 'gw-root');
  assert.equal(h.store.state.selection.key, `ev:${rowGwRoot}:0`);

  // Clicking HitKind.None clears selection
  h.controller.handleInput({
    type: 'click',
    hit: NO_SEQUENCE_HIT,
  });
  assert.equal(h.store.state.selection.ids.size, 0);
  assert.equal(h.store.state.selection.primary, null);
});

test('double-clicking or pressing Enter on a folded loop expands it; pressing Enter on a collapsible step toggles collapse in the store', () => {
  const h = createHarness();
  const initialSteps = h.controller.steps;
  assert.ok(initialSteps !== null);

  const rowDb1 = h.index.spans.get('db-1')?.idx ?? -1;
  const foldStep = initialSteps.stepOfRow[rowDb1];
  assert.ok(foldStep >= 0);
  assert.equal(initialSteps.kind[foldStep], StepKind.Fold);
  assert.equal(initialSteps.foldCount[foldStep], 4);
  const countBeforeExpand = initialSteps.count;

  // Double-click the Fold step to expand it
  const dblRes = h.controller.handleInput({
    type: 'dblclick',
    hit: makeHit(HitKind.Fold, foldStep, rowDb1),
  });
  assert.equal(dblRes.handled, true);
  assert.ok((dblRes.dirty & SequenceDirty.Rows) !== 0);
  assert.equal(h.controller.viewState.expandedFolds.has(`fold:${rowDb1}`), true);

  const expandedSteps = h.controller.steps;
  assert.ok(expandedSteps !== null);
  assert.ok(expandedSteps.count > countBeforeExpand);
  // Each DB call now has its own Call + Return steps instead of a single Fold step
  assert.equal(expandedSteps.kind[expandedSteps.stepOfRow[rowDb1]], StepKind.Call);

  // Double-click again to re-fold, then use Enter key to expand
  h.controller.handleInput({
    type: 'dblclick',
    hit: makeHit(HitKind.Fold, foldStep, rowDb1),
  });
  assert.equal(h.controller.viewState.expandedFolds.has(`fold:${rowDb1}`), false);

  // Focus the fold step and press Enter
  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Fold, foldStep, rowDb1),
  });
  assert.equal(h.controller.viewState.focusStep, foldStep);

  const enterFoldRes = h.controller.handleInput({
    type: 'key',
    key: 'Enter',
  });
  assert.equal(enterFoldRes.handled, true);
  assert.ok((enterFoldRes.dirty & SequenceDirty.Rows) !== 0);
  assert.equal(h.controller.viewState.expandedFolds.has(`fold:${rowDb1}`), true);

  // Now focus a collapsible step (`order-srv`, which has children) and press Enter
  const rowOrderSrv = h.index.spans.get('order-srv')?.idx ?? -1;
  const currentSteps = h.controller.steps;
  assert.ok(currentSteps !== null);
  const orderStep = currentSteps.stepOfRow[rowOrderSrv];

  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Step, orderStep, rowOrderSrv),
  });
  assert.equal(h.store.state.collapsed.has('order-srv'), false);

  const enterCollapseRes = h.controller.handleInput({
    type: 'key',
    key: 'Enter',
  });
  assert.equal(enterCollapseRes.handled, true);
  assert.equal(h.store.state.collapsed.has('order-srv'), true);

  // Pressing Enter again expands `order-srv` in the store
  h.controller.handleInput({
    type: 'key',
    key: 'Enter',
  });
  assert.equal(h.store.state.collapsed.has('order-srv'), false);
});

test('external selection in the store updates focusStep via stepOfRow and revealSpan(id) expands folds and scrolls to the step', () => {
  const h = createHarness();
  // Make the viewport short so lower steps require scrolling
  h.controller.handleInput({ type: 'resize', width: 900, height: 120 });

  // External selection (from waterfall or span table)
  h.store.setSelection(['pay-srv'], { origin: 'waterfall' });
  const dirty = h.flush();
  assert.ok((dirty & SequenceDirty.Overlay) !== 0);

  const steps = h.controller.steps;
  assert.ok(steps !== null);
  const rowPaySrv = h.index.spans.get('pay-srv')?.idx ?? -1;
  assert.equal(h.controller.viewState.focusStep, steps.stepOfRow[rowPaySrv]);

  // Now test revealSpan on a span inside a folded loop ('db-3')
  const rowDb1 = h.index.spans.get('db-1')?.idx ?? -1;
  const rowDb3 = h.index.spans.get('db-3')?.idx ?? -1;
  assert.equal(h.controller.viewState.expandedFolds.has(`fold:${rowDb1}`), false);

  h.scrolledPositions.length = 0;
  const revealDirty = h.controller.revealSpan('db-3');
  assert.ok((revealDirty & SequenceDirty.Rows) !== 0);
  assert.ok((revealDirty & SequenceDirty.Scroll) !== 0);

  // The fold containing 'db-3' was automatically expanded
  assert.equal(h.controller.viewState.expandedFolds.has(`fold:${rowDb1}`), true);

  const unfoldedSteps = h.controller.steps;
  assert.ok(unfoldedSteps !== null);
  const db3Step = unfoldedSteps.stepOfRow[rowDb3];
  assert.ok(db3Step >= 0);
  assert.equal(unfoldedSteps.row[db3Step], rowDb3);
  assert.equal(h.controller.viewState.focusStep, db3Step);
  assert.ok(h.controller.viewState.scrollTop > 0);
  assert.equal(h.scrolledPositions.length, 1);
  assert.equal(h.scrolledPositions[0]?.scrollTop, h.controller.viewState.scrollTop);
});

test('keyboard navigation: ArrowDown, ArrowUp, ArrowRight, ArrowLeft, R, E, I, Escape', () => {
  const h = createHarness();
  const steps = h.controller.steps;
  assert.ok(steps !== null);
  // Steps in sample trace (with internal='auto', foldMin=3, returns='all'):
  // 0: Found (Gate -> api-gw, gw-root, depth=1, pair=6)
  // 1: Call (api-gw -> order-svc, order-srv via gw-to-order, depth=2, pair=5)
  // 2: Fold (order-svc -> postgres, db-1..db-4, depth=3)
  // 3: Call (order-svc -> payment-svc, pay-srv via order-to-pay, depth=3, Error, pair=4)
  // 4: Return (payment-svc -> order-svc, pay-srv, depth=3, Error, pair=3)
  // 5: Return (order-svc -> api-gw, order-srv, depth=2, pair=1)
  // 6: Return (api-gw -> Gate, gw-root, depth=1, pair=0)
  assert.equal(steps.count, 7);

  // 1. ArrowDown from focusStep = -1 selects step 0
  h.controller.handleInput({ type: 'key', key: 'ArrowDown' });
  assert.equal(h.controller.viewState.focusStep, 0);
  assert.equal(h.store.state.selection.primary, 'gw-root');

  // 2. ArrowRight (step into): step 1 has depth 2 > step 0 depth 1 -> moves to step 1
  h.controller.handleInput({ type: 'key', key: 'ArrowRight' });
  assert.equal(h.controller.viewState.focusStep, 1);
  assert.equal(h.store.state.selection.primary, 'order-srv');

  // 3. ArrowDown moves to step 2 (the Fold step)
  h.controller.handleInput({ type: 'key', key: 'ArrowDown' });
  assert.equal(h.controller.viewState.focusStep, 2);
  assert.equal(steps.kind[2], StepKind.Fold);

  // 4. ArrowUp moves back to step 1
  h.controller.handleInput({ type: 'key', key: 'ArrowUp' });
  assert.equal(h.controller.viewState.focusStep, 1);

  // 5. R jumps from Call (step 1) to paired Return (step 5), and R again jumps back to step 1
  h.controller.handleInput({ type: 'key', key: 'R' });
  assert.equal(h.controller.viewState.focusStep, 5);
  h.controller.handleInput({ type: 'key', key: 'r' });
  assert.equal(h.controller.viewState.focusStep, 1);

  // 6. E jumps to next error step (step 3: Call to pay-srv), then next error step (step 4: Return from pay-srv), then wraps to step 3
  h.controller.handleInput({ type: 'key', key: 'E' });
  assert.equal(h.controller.viewState.focusStep, 3);
  assert.equal(h.store.state.selection.primary, 'pay-srv');

  h.controller.handleInput({ type: 'key', key: 'e' });
  assert.equal(h.controller.viewState.focusStep, 4);

  // Shift+E jumps to previous error step (step 3)
  h.controller.handleInput({ type: 'key', key: 'E', shiftKey: true });
  assert.equal(h.controller.viewState.focusStep, 3);

  // 7. ArrowLeft (step out):
  // From step 4 (Return of pay-srv, where act.startStep === 3 < 4), ArrowLeft jumps to step 3 (startStep of pay-srv activation)
  h.controller.handleInput({ type: 'key', key: 'ArrowDown' });
  assert.equal(h.controller.viewState.focusStep, 4);
  h.controller.handleInput({ type: 'key', key: 'ArrowLeft' });
  assert.equal(h.controller.viewState.focusStep, 3);

  // From step 3 (startStep of pay-srv activation), ArrowLeft jumps to parent activation's startStep (step 1: order-srv)
  h.controller.handleInput({ type: 'key', key: 'ArrowLeft' });
  assert.equal(h.controller.viewState.focusStep, 1);

  // From step 1 (startStep of order-srv activation), ArrowLeft jumps to parent activation's startStep (step 0: gw-root)
  h.controller.handleInput({ type: 'key', key: 'ArrowLeft' });
  assert.equal(h.controller.viewState.focusStep, 0);

  // 8. 'I' cycles internal mode: 'auto' -> 'show' -> 'hide' -> 'auto'
  assert.equal(h.controller.viewState.internal, 'auto');
  h.controller.handleInput({ type: 'key', key: 'I' });
  assert.equal(h.controller.viewState.internal, 'show');
  // In 'show' mode, 'gw-internal' is now projected as a SelfCall step (total steps = 8)
  assert.equal(h.controller.steps?.count, 8);

  h.controller.handleInput({ type: 'key', key: 'i' });
  assert.equal(h.controller.viewState.internal, 'hide');
  assert.equal(h.controller.steps?.count, 7);

  h.controller.handleInput({ type: 'key', key: 'I' });
  assert.equal(h.controller.viewState.internal, 'auto');

  // 9. Escape clears selection in the store
  assert.ok(h.store.state.selection.ids.size > 0);
  h.controller.handleInput({ type: 'key', key: 'Escape' });
  assert.equal(h.store.state.selection.ids.size, 0);
  assert.equal(h.store.state.selection.primary, null);

  // 10. Unrecognized key returns handled: false
  const unhandled = h.controller.handleInput({ type: 'key', key: 'x' });
  assert.equal(unhandled.handled, false);
});

test('getState() and setState() round-trip view state across tab switches', () => {
  const h = createHarness();
  // Configure non-default state
  h.controller.setInternalMode('show');
  h.controller.setReturnsMode('errors');
  h.controller.toggleMatchesOnly();
  h.controller.toggleHideUnaffectedColumns();
  h.controller.toggleFitColumns();
  h.controller.zoomDensity(1.25);

  const rowDb1 = h.index.spans.get('db-1')?.idx ?? -1;
  const foldStep = h.controller.steps?.stepOfRow[rowDb1] ?? -1;
  h.controller.handleInput({
    type: 'dblclick',
    hit: makeHit(HitKind.Fold, foldStep, rowDb1),
  });
  h.controller.handleInput({
    type: 'scroll',
    scrollTop: 42,
    scrollLeft: 18,
  });
  h.controller.handleInput({
    type: 'key',
    key: 'ArrowDown',
  });

  const snapshot = h.controller.getState();

  // Create a fresh controller and restore the saved state
  const restored = new SequenceController({
    store: h.store,
    origin: 'seq-view-2',
  });
  restored.handleInput({ type: 'resize', width: 900, height: 400 });
  restored.setState(snapshot);

  assert.equal(restored.viewState.scrollTop, h.controller.viewState.scrollTop);
  assert.equal(restored.viewState.scrollLeft, h.controller.viewState.scrollLeft);
  assert.equal(restored.viewState.rowHeight, h.controller.viewState.rowHeight);
  assert.equal(restored.viewState.fitColumns, true);
  assert.equal(restored.viewState.internal, 'show');
  assert.equal(restored.viewState.returns, 'errors');
  assert.equal(restored.viewState.matchesOnly, true);
  assert.equal(restored.viewState.hideUnaffectedColumns, true);
  assert.deepEqual(
    [...restored.viewState.expandedFolds],
    [...h.controller.viewState.expandedFolds],
  );
  assert.equal(restored.viewState.focusStep, h.controller.viewState.focusStep);
});

test('echo suppression: selection and hover changes originating from the controller itself do not redundantly trigger work', () => {
  const h = createHarness();
  const steps = h.controller.steps;
  assert.ok(steps !== null);

  // Clicking aReturn step (step 5: Return of order-srv) sets focusStep = 5,
  // even though stepOfRow[order-srv] is 1 (the Call step).
  const returnStep = 5;
  assert.equal(steps.kind[returnStep], StepKind.Return);
  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Step, returnStep, steps.row[returnStep]),
  });
  assert.equal(h.controller.viewState.focusStep, returnStep);

  // Flushing the store delivers the ChangeSet with origin === 'seq-view'.
  // Echo suppression ensures handleStoreChange returns 0 dirty and preserves focusStep === 5!
  const echoDirty = h.flush();
  assert.equal(echoDirty, SequenceDirty.None);
  assert.equal(h.controller.viewState.focusStep, returnStep);

  // Hovering from the controller also suppresses its own store echo
  h.controller.handleInput({
    type: 'hover',
    hit: makeHit(HitKind.Step, 1, steps.row[1]),
  });
  assert.equal(h.hoveredHits.length, 1);
  const hoverEchoDirty = h.flush();
  assert.equal(hoverEchoDirty, SequenceDirty.None);

  // Leaving clears hover in store and notifies onHover(null)
  h.controller.handleInput({ type: 'leave' });
  assert.equal(h.store.state.hover, null);
  assert.equal(h.hoveredHits.at(-1), null);
  assert.equal(h.flush(), SequenceDirty.None);
});

test('hideUnaffectedColumns filters columns in layout and describeHit describes participants, steps, activations, and events', () => {
  const h = createHarness();

  // Filter to only 'gw-root' and enable matchesOnly + hideUnaffectedColumns
  h.store.setMatched(SpanMask.of(h.index, ['gw-root']));
  h.flush();
  h.controller.toggleMatchesOnly();
  h.controller.toggleHideUnaffectedColumns();
  const plan = h.controller.buildPlan();

  // Only Gate and api-gw participate in gw-root's Found and Return steps
  assert.equal(plan.layout?.columnCount, 2);

  // Verify describeHit for each HitKind
  const partInfo = h.controller.describeHit(makeHit(HitKind.Participant, 1));
  assert.ok(partInfo !== null);
  assert.equal(partInfo.title, 'api-gw');

  const stepInfo = h.controller.describeHit(makeHit(HitKind.Step, 0));
  assert.ok(stepInfo !== null);
  assert.equal(stepInfo.title, 'POST /checkout');

  const actInfo = h.controller.describeHit(makeHit(HitKind.Activation, 0));
  assert.ok(actInfo !== null);
  assert.equal(actInfo.title, 'POST /checkout');

  const rowGwRoot = h.index.spans.get('gw-root')?.idx ?? -1;
  const evInfo = h.controller.describeHit(makeHit(HitKind.EventTick, 0, rowGwRoot, 0));
  assert.ok(evInfo !== null);
  assert.equal(evInfo.title, 'auth.verified');

  assert.equal(h.controller.describeHit(NO_SEQUENCE_HIT), null);
});

test('pan, zoom-density anchoring, Home/End/PageDown/PageUp, ArrowRight expand fold/collapse, dblclick collapse, and applySettings', () => {
  const h = createHarness();
  h.controller.handleInput({ type: 'resize', width: 300, height: 140 });

  // Panning adjusts scrollTop / scrollLeft and emits scroll-to
  h.scrolledPositions.length = 0;
  const panRes = h.controller.handleInput({ type: 'pan', dx: -40, dy: -30 });
  assert.equal(panRes.handled, true);
  assert.ok((panRes.dirty & SequenceDirty.Scroll) !== 0);
  assert.equal(h.controller.viewState.scrollTop, 30);
  assert.equal(h.controller.viewState.scrollLeft, 40);
  assert.equal(h.scrolledPositions.length, 1);

  // zoom-density scales rowHeight within [18, 48] and keeps step under anchorY anchored
  const zRes = h.controller.handleInput({
    type: 'zoom-density',
    factor: 1.5,
    anchorY: 80,
  });
  assert.equal(zRes.handled, true);
  assert.equal(h.controller.viewState.rowHeight, 42);
  assert.ok((zRes.dirty & (SequenceDirty.Layout | SequenceDirty.Rows)) !== 0);

  // Home and End jump to first and last steps
  h.controller.handleInput({ type: 'key', key: 'End' });
  assert.equal(h.controller.viewState.focusStep, 6);
  h.controller.handleInput({ type: 'key', key: 'Home' });
  assert.equal(h.controller.viewState.focusStep, 0);

  // PageDown and PageUp jump by viewport page steps
  h.controller.handleInput({ type: 'key', key: 'PageDown' });
  assert.ok(h.controller.viewState.focusStep > 0);
  h.controller.handleInput({ type: 'key', key: 'PageUp' });
  assert.equal(h.controller.viewState.focusStep, 0);

  // Focus Fold step (step 2) and press ArrowRight to expand fold
  h.controller.handleInput({ type: 'key', key: 'ArrowDown' }); // step 1
  h.controller.handleInput({ type: 'key', key: 'ArrowDown' }); // step 2 (Fold)
  assert.equal(h.controller.steps?.kind[2], StepKind.Fold);
  h.controller.handleInput({ type: 'key', key: 'ArrowRight' });
  const rowDb1 = h.index.spans.get('db-1')?.idx ?? -1;
  assert.equal(h.controller.viewState.expandedFolds.has(`fold:${rowDb1}`), true);

  // Double-click on collapsible step (step 1: order-srv) collapses it in store
  const rowOrderSrv = h.index.spans.get('order-srv')?.idx ?? -1;
  h.controller.handleInput({
    type: 'dblclick',
    hit: makeHit(HitKind.Step, 1, rowOrderSrv),
  });
  assert.equal(h.store.state.collapsed.has('order-srv'), true);

  // Focus collapsed step 1 and press ArrowRight to expand it in store
  h.controller.handleInput({
    type: 'click',
    hit: makeHit(HitKind.Step, 1, rowOrderSrv),
  });
  h.controller.handleInput({ type: 'key', key: 'ArrowRight' });
  assert.equal(h.store.state.collapsed.has('order-srv'), false);

  // applySettings updates settings and marks dirty
  const settingsDirty = h.controller.applySettings({
    internal: 'hide',
    returns: 'none',
    foldMin: 0,
    rowHeight: 24,
    wheelZoom: true,
  });
  assert.ok((settingsDirty & SequenceDirty.Rows) !== 0);
  assert.equal(h.controller.viewState.rowHeight, 24);
  assert.equal(h.controller.viewState.returns, 'none');
  assert.equal(h.controller.wheelZoom, true);
});

