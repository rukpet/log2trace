import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SPAN_SET,
  SpanKind,
  SpanMask,
  buildSpanIndex,
  spanSetOf,
} from '../../../src/core.ts';
import {
  ACT_W,
  CANVAS_PAD_X,
  SELF_LOOP_W,
  activationBoxX,
  computeSequenceLayout,
  lifelineCenterX,
  stepRowY,
} from '../../../src/views/sequence/model/layout.ts';
import { buildSequenceModel } from '../../../src/views/sequence/model/messages.ts';
import { GATE_NAME } from '../../../src/views/sequence/model/participants.ts';
import { projectSteps } from '../../../src/views/sequence/model/steps.ts';
import {
  ArrowHeadKind,
  PlanStateFlag,
  SequencePlan,
  buildSequencePlan,
} from '../../../src/views/sequence/model/plan.ts';
import {
  HitKind,
  NO_SEQUENCE_HIT,
  hitTestSequence,
} from '../../../src/views/sequence/model/hit.ts';
import { event, span, trace } from '../../support/trace-builder.ts';

test('buildSequencePlan populates columns, visible steps, activations, and span event ticks', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-srv', undefined, 0, 320, {
            name: 'GET /checkout',
            kind: SpanKind.Server,
            parentSpanId: 'missing-parent',
            events: [event('cache.lookup', 20)],
          }),
          span('a-self', 'a-srv', 10, 15, {
            name: 'validateCart',
            kind: SpanKind.Internal,
          }),
          span('a-cli', 'a-srv', 20, 60, {
            name: 'RPC Charge',
            kind: SpanKind.Client,
          }),
          span('a-async-prod', 'a-srv', 250, 255, {
            name: 'PublishOrder',
            kind: SpanKind.Producer,
          }),
        ],
      ],
      [
        'svc-b',
        [
          span('b-srv', 'a-cli', 18, 58, {
            name: 'ChargeCard',
            kind: SpanKind.Server,
            status: { code: 2, message: 'declined' },
            events: [event('exception', 38)],
          }),
        ],
      ],
      [
        'svc-c',
        [
          span('c-cons', 'a-async-prod', 252, 265, {
            name: 'ConsumeOrder',
            kind: SpanKind.Consumer,
          }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model, null, null, null, { internal: 'show' });
  const layout = computeSequenceLayout({
    viewWidth: 900,
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
    selection: spanSetOf(['b-srv']),
    hover: spanSetOf(['a-self']),
  });

  // 1. Columns
  assert.equal(plan.columnCount, model.participants.count);
  const pGate = model.participants.names.indexOf(GATE_NAME);
  const pA = model.participants.names.indexOf('svc-a');
  const pB = model.participants.names.indexOf('svc-b');
  const pC = model.participants.names.indexOf('svc-c');

  for (let c = 0; c < plan.columnCount; c++) {
    assert.equal(plan.colParticipant[c], model.participants.atColumn[c]);
    assert.equal(plan.colCenterX[c], lifelineCenterX(layout, c));
  }

  const colB = model.participants.column[pB];
  const colA = model.participants.column[pA];
  assert.ok((plan.colState[colB] & PlanStateFlag.Selected) !== 0);
  assert.ok((plan.colState[colB] & PlanStateFlag.Error) !== 0);
  assert.ok((plan.colState[colA] & PlanStateFlag.Hovered) !== 0);

  // 2. Visible Steps
  assert.equal(plan.firstStep, 0);
  assert.equal(plan.lastStep, steps.count);
  assert.equal(plan.stepCount, steps.count);

  // Step 0: Found (Gate -> A, orphan)
  assert.equal(plan.stepIndex[0], 0);
  assert.equal(plan.arrowX0[0], lifelineCenterX(layout, model.participants.column[pGate]));
  assert.equal(plan.arrowX1[0], lifelineCenterX(layout, colA));
  assert.equal(plan.arrowHead[0], ArrowHeadKind.Filled);
  assert.equal(plan.arrowDashed[0], 0);
  assert.equal(plan.arrowSelfLoop[0], 0);
  assert.equal(plan.stepLabel[0], 'GET /checkout');
  assert.equal(plan.stepBadge[0], 'orphan');
  assert.equal(plan.gutterText[0], '+0µs');

  // Step 1: SelfCall on A ('validateCart')
  assert.equal(plan.arrowSelfLoop[1], 1);
  assert.equal(plan.arrowDashed[1], 0);
  assert.equal(plan.arrowHead[1], ArrowHeadKind.Filled);
  assert.equal(plan.arrowX0[1], lifelineCenterX(layout, colA) + ACT_W / 2);
  assert.equal(plan.arrowX1[1], lifelineCenterX(layout, colA) + ACT_W / 2 + SELF_LOOP_W);
  assert.equal(plan.stepLabel[1], 'validateCart');
  assert.ok((plan.stepState[1] & PlanStateFlag.Hovered) !== 0);

  // Step 2: Call A -> B ('ChargeCard', error + skew since 18 < 20)
  assert.equal(plan.arrowX0[2], lifelineCenterX(layout, colA));
  assert.equal(plan.arrowX1[2], lifelineCenterX(layout, colB));
  assert.equal(plan.arrowHead[2], ArrowHeadKind.Filled);
  assert.equal(plan.arrowDashed[2], 0);
  assert.equal(plan.arrowSelfLoop[2], 0);
  assert.equal(plan.stepLabel[2], 'ChargeCard');
  assert.equal(plan.stepBadge[2], '✖ ⚠');
  assert.ok((plan.stepState[2] & PlanStateFlag.Selected) !== 0);
  assert.ok((plan.stepState[2] & PlanStateFlag.Error) !== 0);

  // Step 3: Return B -> A
  assert.equal(plan.arrowX0[3], lifelineCenterX(layout, colB));
  assert.equal(plan.arrowX1[3], lifelineCenterX(layout, colA));
  assert.equal(plan.arrowHead[3], ArrowHeadKind.Open);
  assert.equal(plan.arrowDashed[3], 1);
  assert.equal(plan.stepLabel[3], '40.00ms');

  // Step 4: Async A -> C ('ConsumeOrder', preceded by gap from 58ms to 252ms = 194ms)
  const colC = model.participants.column[pC];
  assert.equal(plan.arrowX0[4], lifelineCenterX(layout, colA));
  assert.equal(plan.arrowX1[4], lifelineCenterX(layout, colC));
  assert.equal(plan.arrowHead[4], ArrowHeadKind.Open);
  assert.equal(plan.arrowDashed[4], 0);
  assert.equal(plan.stepLabel[4], 'ConsumeOrder');
  assert.equal(plan.gapText[4], '≈ +194.00ms');

  // 3. Visible Activations & Ticks
  assert.ok(plan.actCount >= 4);
  assert.equal(plan.tickCount, 2);

  // Tick 0: 'cache.lookup' on a-srv (non-exception)
  assert.equal(plan.tickIsException[0], 0);
  // Tick 1: 'exception' on b-srv (exception)
  assert.equal(plan.tickIsException[1], 1);
  const bActSlot = plan.tickActSlot[1];
  assert.equal(plan.tickX[1], plan.actX[bActSlot] + plan.actW[bActSlot] / 2);
  // 38ms is halfway through [18, 58]
  const expectedTickY = plan.actY[bActSlot] + 0.5 * plan.actH[bActSlot];
  assert.ok(Math.abs(plan.tickY[1] - expectedTickY) < 1e-6);
});

test('buildSequencePlan handles Fold, Elided, Parallel/Backwards gutter prefixes, Dimmed filter state, and open activation chain before firstStep', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-root', undefined, 0, 500, { name: 'RootOp', kind: SpanKind.Server }),
          span('a-c1', 'a-root', 10, 20, { name: 'CallB', kind: SpanKind.Client }),
          span('a-c2', 'a-root', 25, 35, { name: 'CallB', kind: SpanKind.Client }),
          span('a-c3', 'a-root', 40, 50, { name: 'CallB', kind: SpanKind.Client }),
          span('a-p1', 'a-root', 100, 150, { name: 'Par1', kind: SpanKind.Client }),
          span('a-p2', 'a-root', 120, 140, { name: 'Par2', kind: SpanKind.Client }),
          span('a-late', 'a-root', 400, 450, { name: 'LateCall', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [
          span('b-1', 'a-c1', 11, 19, { name: 'DoItem', kind: SpanKind.Server }),
          span('b-2', 'a-c2', 26, 34, { name: 'DoItem', kind: SpanKind.Server }),
          span('b-3', 'a-c3', 41, 49, { name: 'DoItem', kind: SpanKind.Server }),
          span('b-p1', 'a-p1', 102, 148, { name: 'Work1', kind: SpanKind.Server }),
          span('b-p2', 'a-p2', 122, 138, { name: 'Work2', kind: SpanKind.Server }),
        ],
      ],
      [
        'svc-c',
        [
          span('c-late', 'a-late', 405, 445, { name: 'LateWork', kind: SpanKind.Server }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  // Match only 'b-p2' so other steps are Context (Dimmed) and svc-c has no matched spans
  const bits = new Uint8Array(index.table.length);
  const rowBp2 = index.spans.get('b-p2')?.idx ?? 0;
  bits[rowBp2] = 1;
  const matched = new SpanMask(index, bits);

  // Time window [0, 200] elides 'c-late' (400..450)
  const steps = projectSteps(model, null, matched, { t0: 0, t1: 200 }, { foldMin: 3 });
  const layout = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 44 + 28 * 2, // small viewport (2 rows tall) to test scrolling & open activation chain
    columnCount: model.participants.count,
    rowCount: steps.count,
  });

  const plan = new SequencePlan();
  // Scroll down so firstStep > 0 while root activation (started at step 0) is still open
  buildSequencePlan(plan, {
    steps,
    layout,
    scrollTop: 28 * 3 + 12,
    scrollLeft: 0,
    selection: spanSetOf(['b-2']),
    hover: EMPTY_SPAN_SET,
    overscanRows: 0,
  });

  assert.ok(plan.firstStep > 0);
  // Root activation (index 0, startStep 0, endStep steps.count - 1) must be included via openChain walk
  const visibleActs = [...plan.actIndex.subarray(0, plan.actCount)];
  assert.ok(visibleActs.includes(0));

  // Now build full plan with overscan to inspect all steps
  const fullLayout = computeSequenceLayout({
    viewWidth: 800,
    viewHeight: 1000,
    columnCount: model.participants.count,
    rowCount: steps.count,
  });
  buildSequencePlan(plan, {
    steps,
    layout: fullLayout,
    scrollTop: 0,
    scrollLeft: 0,
    selection: spanSetOf(['b-2']),
    hover: EMPTY_SPAN_SET,
  });

  // svc-c had no match while filter is active -> Dimmed
  const pC = model.participants.names.indexOf('svc-c');
  const colC = model.participants.column[pC];
  assert.ok((plan.colState[colC] & PlanStateFlag.Dimmed) !== 0);

  // Step 1 is Fold (3 calls of 'DoItem', total duration 24ms, selected via 'b-2')
  assert.equal(plan.stepLabel[1], 'DoItem');
  assert.equal(plan.stepBadge[1], '×3 (24.00ms)');
  assert.ok((plan.stepState[1] & PlanStateFlag.Selected) !== 0);
  assert.ok((plan.stepState[1] & PlanStateFlag.Dimmed) !== 0);

  // Parallel steps ('Work1' and 'Work2') have '‖ ' gutter prefix
  const parSlot = [0, 1, 2, 3, 4, 5, 6].find((i) => plan.stepLabel[i] === 'Work1') ?? -1;
  assert.ok(parSlot >= 0);
  assert.ok(plan.gutterText[parSlot].startsWith('‖ '));

  // Elided step spans across all columns with dashed line and no arrowhead
  const elidedSlot =
    [0, 1, 2, 3, 4, 5, 6].find((i) =>
      plan.stepLabel[i].includes('interactions outside window'),
    ) ?? -1;
  assert.ok(elidedSlot >= 0);
  assert.equal(plan.arrowX0[elidedSlot], fullLayout.gutterWidth + CANVAS_PAD_X);
  assert.equal(plan.arrowX1[elidedSlot], fullLayout.contentWidth - CANVAS_PAD_X);
  assert.equal(plan.arrowDashed[elidedSlot], 1);
  assert.equal(plan.arrowHead[elidedSlot], ArrowHeadKind.None);
});

test('hitTestSequence hits participant header cards, gutter rows, and prioritizes EventTick > Step/Fold > nested Activation > outer Activation > NO_SEQUENCE_HIT', () => {
  const index = buildSpanIndex(
    trace(
      [
        'svc-a',
        [
          span('a-outer', undefined, 0, 200, { name: 'OuterA', kind: SpanKind.Server }),
          span('a-to-b', 'a-outer', 10, 190, { name: 'CallB', kind: SpanKind.Client }),
          span('a-inner', 'b-to-a', 30, 150, {
            name: 'CallbackA',
            kind: SpanKind.Server,
            events: [event('exception', 30)],
          }),
          span('a-inner-to-b', 'a-inner', 40, 130, { name: 'InnerCallB', kind: SpanKind.Client }),
        ],
      ],
      [
        'svc-b',
        [
          span('b-srv', 'a-to-b', 15, 185, { name: 'HandleB', kind: SpanKind.Server }),
          span('b-to-a', 'b-srv', 20, 160, { name: 'CallBackA', kind: SpanKind.Client }),
          span('b-inner', 'a-inner-to-b', 45, 125, { name: 'InnerB', kind: SpanKind.Server }),
          span('b-work', 'b-inner', 50, 60, { name: 'LocalWorkB', kind: SpanKind.Internal }),
          span('b-f1', 'b-srv', 162, 165, { name: 'FoldLeaf', kind: SpanKind.Internal }),
          span('b-f2', 'b-srv', 166, 169, { name: 'FoldLeaf', kind: SpanKind.Internal }),
          span('b-f3', 'b-srv', 170, 173, { name: 'FoldLeaf', kind: SpanKind.Internal }),
        ],
      ],
    ),
  );

  const model = buildSequenceModel(index);
  const steps = projectSteps(model, null, null, null, { internal: 'show', foldMin: 3 });
  const layout = computeSequenceLayout({
    viewWidth: 900,
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

  // 1. Invalid coordinates or empty plan -> NO_SEQUENCE_HIT
  assert.equal(hitTestSequence(new SequencePlan(), 100, 100), NO_SEQUENCE_HIT);
  assert.equal(hitTestSequence(plan, Number.NaN, 100), NO_SEQUENCE_HIT);
  assert.equal(hitTestSequence(plan, -5, 10), NO_SEQUENCE_HIT);

  // 2. Sticky Header Card hit test
  const pA = model.participants.names.indexOf('svc-a');
  const colA = model.participants.column[pA];
  const centerA = plan.colCenterX[colA];
  const headerHit = hitTestSequence(plan, centerA, layout.headerHeight / 2);
  assert.equal(headerHit.kind, HitKind.Participant);
  assert.equal(headerHit.index, plan.colParticipant[colA]);
  assert.equal(headerHit.row, -1);
  assert.equal(headerHit.anchor.y, 4);
  assert.equal(headerHit.anchor.w, layout.columnWidth - 12);
  assert.equal(headerHit.anchor.h, layout.headerHeight - 8);

  // Gap between header cards (6px margin on each side of column) returns NO_SEQUENCE_HIT
  const headerGapX = centerA + layout.columnWidth / 2 - 2;
  assert.equal(hitTestSequence(plan, headerGapX, layout.headerHeight / 2), NO_SEQUENCE_HIT);

  // 3. Gutter hit test for a Step and a Fold row
  const step0ViewY = layout.headerHeight + stepRowY(layout, 0).centerY;
  const gutterStepHit = hitTestSequence(plan, 20, step0ViewY);
  assert.equal(gutterStepHit.kind, HitKind.Step);
  assert.equal(gutterStepHit.index, 0);

  const allStepIndices = Array.from({ length: steps.count }, (_, idx) => idx);
  const foldStepIdx = allStepIndices.find((s) => steps.kind[s] === 6) ?? -1;
  assert.ok(foldStepIdx >= 0);
  const foldViewY = layout.headerHeight + stepRowY(layout, foldStepIdx).centerY;
  const gutterFoldHit = hitTestSequence(plan, 20, foldViewY);
  assert.equal(gutterFoldHit.kind, HitKind.Fold);
  assert.equal(gutterFoldHit.index, foldStepIdx);

  // 4. Priority 1: EventTick wins over Activation and Step
  assert.equal(plan.tickCount, 1);
  const tickViewX = plan.tickX[0] - plan.scrollLeft;
  const tickViewY = plan.tickY[0] - plan.scrollTop + layout.headerHeight;
  const tickHit = hitTestSequence(plan, tickViewX + 3, tickViewY - 3);
  assert.equal(tickHit.kind, HitKind.EventTick);
  assert.equal(tickHit.index, 0);
  assert.equal(tickHit.row, plan.tickRow[0]);
  assert.equal(tickHit.eventIdx, plan.tickEventIdx[0]);

  // 5. Priority 2: Step / Fold arrow wins over Activation
  // Step 2 is Call B -> A ('CallbackA'), where arrow endpoint lands right on A's activation
  const step2ViewY = layout.headerHeight + plan.stepCenterY[2];
  const step2MidX = (plan.arrowX0[2] + plan.arrowX1[2]) / 2;
  const arrowHit = hitTestSequence(plan, step2MidX, step2ViewY);
  assert.equal(arrowHit.kind, HitKind.Step);
  assert.equal(arrowHit.index, 2);

  // Hitting the Fold step arrow on B returns HitKind.Fold
  const foldArrowX = (plan.arrowX0[foldStepIdx] + plan.arrowX1[foldStepIdx]) / 2;
  const foldHit = hitTestSequence(plan, foldArrowX, foldViewY);
  assert.equal(foldHit.kind, HitKind.Fold);
  assert.equal(foldHit.index, foldStepIdx);

  // 6. Priority 3: Nested Activation wins over outer Activation on same lifeline
  const outerBox = activationBoxX(layout, colA, 0);
  const innerBox = activationBoxX(layout, colA, 1);

  // Find the step for 'LocalWorkB' (SelfCall on svc-b while BOTH OuterA and CallbackA are open on svc-a)
  const bWorkStepIdx = allStepIndices.find((s) => plan.stepLabel[s] === 'LocalWorkB') ?? -1;
  assert.ok(bWorkStepIdx >= 0);
  const bWorkViewY = layout.headerHeight + stepRowY(layout, bWorkStepIdx).centerY;

  // At `bWorkViewY`, the step arrow is a self-loop on svc-b, so svc-a has NO arrow at this row.
  // Both `OuterA` (act 0, nest=0, `[centerA - 5, centerA + 5]`) and `CallbackA` (act 2, nest=1, `[centerA, centerA + 10]`)
  // overlap horizontally at `centerA + 2` (`innerBox.x + 2`):
  const overlapHit = hitTestSequence(plan, innerBox.x + 2, bWorkViewY);
  assert.equal(overlapHit.kind, HitKind.Activation);
  assert.equal(overlapHit.index, 2); // deeper nested activation (nest=1) wins over outer activation (nest=0)

  // At `outerBox.x - 1` (`centerA - 6`), we are inside outerBox's +3px tolerance (`[centerA - 8, centerA + 8]`)
  // but outside innerBox's +3px tolerance (`[centerA - 3, centerA + 13]`):
  const outerEdgeHit = hitTestSequence(plan, outerBox.x - 1, bWorkViewY);
  assert.equal(outerEdgeHit.kind, HitKind.Activation);
  assert.equal(outerEdgeHit.index, 0); // outer activation (nest=0) is hit

  // And at `foldViewY` (after CallbackA has returned), only outer activation 0 is open on colA:
  const outerOnlyHit = hitTestSequence(plan, outerBox.x + outerBox.w / 2, foldViewY);
  assert.equal(outerOnlyHit.kind, HitKind.Activation);
  assert.equal(outerOnlyHit.index, 0);

  // 7. Empty canvas space returns NO_SEQUENCE_HIT
  assert.equal(hitTestSequence(plan, layout.viewWidth - 5, layout.viewHeight - 5), NO_SEQUENCE_HIT);
});
