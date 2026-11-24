/**
 * Sequence diagram pooled DOM painter.
 *
 * Turns a `SequencePlan` into pooled DOM elements (sticky header participant cards,
 * vertical lifeline guides, pooled activation bars, pooled span event ticks, and
 * pooled step rows where step `s` uses slot `s mod P`).
 *
 * Styles are injected (`SequenceDomClasses`) so this module never imports a `*.css.ts` file
 * at runtime and can be unit-tested in Node against the fake DOM.
 */

import { h } from '../../../kit/dom.ts';
import { SequenceDirty } from '../model/interaction.ts';
import { ParticipantKind } from '../model/participants.ts';
import { ArrowHeadKind, PlanStateFlag, type SequencePlan } from '../model/plan.ts';
import type * as DomStyles from './dom.css.ts';

export type SequenceDomClasses = typeof DomStyles;

export interface SequencePainterContext {
  readonly host: HTMLElement;
}

export interface SequencePainterStats {
  readonly rowSlots: number;
  readonly activeRows: number;
  readonly actSlots: number;
  readonly activeActs: number;
  readonly tickSlots: number;
  readonly activeTicks: number;
}

export interface SequenceDomPainter {
  /** Paint the current frame plan according to dirty bits (`SequenceDirty`). */
  paint(plan: SequencePlan, dirty: number): void;
  /** Inspect pool sizes for tests and diagnostics. */
  stats(): SequencePainterStats;
  /** Remove all DOM elements created by the painter. */
  destroy(): void;
}

/** Extra row slots beyond the visible step count so scrolling reuses modulo slots cleanly. */
const SPARE_ROW_SLOTS = 2;

interface ColSlot {
  readonly cardEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly subtitleEl: HTMLElement;
  readonly lifelineEl: HTMLElement;
  hidden: boolean;
  left: number;
  width: number;
  centerX: number;
  title: string;
  subtitle: string;
  kind: number;
  state: number;
}

interface ActSlot {
  readonly el: HTMLElement;
  readonly badgeEl: HTMLElement;
  hidden: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: number;
  state: number;
  badge: string;
}

interface TickSlot {
  readonly el: HTMLElement;
  hidden: boolean;
  x: number;
  y: number;
  isException: number;
}

interface RowSlot {
  readonly rowEl: HTMLElement;
  readonly gutterCell: HTMLElement;
  readonly arrowLineEl: HTMLElement;
  readonly selfLoopEl: HTMLElement;
  readonly arrowHeadEl: HTMLElement;
  readonly arrowLabelEl: HTMLElement;
  readonly labelTextEl: HTMLElement;
  readonly badgeEl: HTMLElement;
  readonly gapBannerEl: HTMLElement;
  usedFrame: number;
  hidden: boolean;
  step: number;
  y: number;
  rowHeight: number;
  gutterWidth: number;
  depth: number;
  state: number;
  x0: number;
  x1: number;
  head: number;
  dashed: number;
  selfLoop: number;
  label: string;
  badge: string;
  gutterText: string;
  gapText: string;
}

function createColSlot(styles: SequenceDomClasses): ColSlot {
  const titleEl = h('span', { class: styles.headerTitle });
  const subtitleEl = h('span', { class: styles.headerSubtitle });
  const cardEl = h('div', { class: styles.headerCard, role: 'columnheader' }, titleEl, subtitleEl);
  const lifelineEl = h('div', { class: styles.lifeline });
  return {
    cardEl,
    titleEl,
    subtitleEl,
    lifelineEl,
    hidden: false,
    left: Number.NaN,
    width: Number.NaN,
    centerX: Number.NaN,
    title: '',
    subtitle: '',
    kind: -1,
    state: -1,
  };
}

function createActSlot(styles: SequenceDomClasses, kindClass: string): ActSlot {
  const badgeEl = h('span', { class: styles.activationBadge });
  badgeEl.style.display = 'none';
  const el = h('div', { class: [styles.activation, kindClass] }, badgeEl);
  return {
    el,
    badgeEl,
    hidden: false,
    x: Number.NaN,
    y: Number.NaN,
    w: Number.NaN,
    h: Number.NaN,
    kind: 0,
    state: -1,
    badge: '',
  };
}

function createTickSlot(styles: SequenceDomClasses): TickSlot {
  const el = h('div', { class: styles.eventTick });
  return {
    el,
    hidden: false,
    x: Number.NaN,
    y: Number.NaN,
    isException: -1,
  };
}

function resetRowSlotCache(slot: RowSlot): void {
  slot.step = -1;
  slot.y = Number.NaN;
  slot.rowHeight = Number.NaN;
  slot.gutterWidth = Number.NaN;
  slot.depth = -1;
  slot.state = -1;
  slot.x0 = Number.NaN;
  slot.x1 = Number.NaN;
  slot.head = -1;
  slot.dashed = -1;
  slot.selfLoop = -1;
  slot.label = '';
  slot.badge = '';
  slot.gutterText = '';
  slot.gapText = '';
}

function createRowSlot(styles: SequenceDomClasses): RowSlot {
  const gutterCell = h('div', { class: styles.gutterCell });
  const gapBannerEl = h('div', { class: styles.gapBanner });
  gapBannerEl.style.display = 'none';
  const arrowLineEl = h('div', { class: styles.arrowLine });
  const selfLoopEl = h('div', { class: styles.arrowSelfLoop });
  selfLoopEl.style.display = 'none';
  const arrowHeadEl = h('div');
  const labelTextEl = h('span');
  const badgeEl = h('span', { class: styles.arrowBadge });
  badgeEl.style.display = 'none';
  const arrowLabelEl = h('div', { class: styles.arrowLabel }, labelTextEl, badgeEl);
  const rowEl = h(
    'div',
    { class: styles.row, role: 'row' },
    gutterCell,
    gapBannerEl,
    arrowLineEl,
    selfLoopEl,
    arrowHeadEl,
    arrowLabelEl,
  );
  return {
    rowEl,
    gutterCell,
    arrowLineEl,
    selfLoopEl,
    arrowHeadEl,
    arrowLabelEl,
    labelTextEl,
    badgeEl,
    gapBannerEl,
    usedFrame: -1,
    hidden: false,
    step: -1,
    y: Number.NaN,
    rowHeight: Number.NaN,
    gutterWidth: Number.NaN,
    depth: -1,
    state: -1,
    x0: Number.NaN,
    x1: Number.NaN,
    head: -1,
    dashed: -1,
    selfLoop: -1,
    label: '',
    badge: '',
    gutterText: '',
    gapText: '',
  };
}

export function createSequenceDomPainter(
  context: SequencePainterContext,
  styles: SequenceDomClasses,
): SequenceDomPainter {
  const actKindClasses: readonly string[] = [
    styles.activationKind.unspecified,
    styles.activationKind.internal,
    styles.activationKind.server,
    styles.activationKind.client,
    styles.activationKind.producer,
    styles.activationKind.consumer,
  ];

  const stage = h('div', { class: styles.stage });
  const headerBand = h('div', { class: styles.headerBand, role: 'row' });
  const headerCorner = h('div', { class: styles.headerCorner, role: 'columnheader' }, 'time');
  const headerTrack = h('div', { class: styles.headerTrack });
  headerBand.append(headerCorner, headerTrack);
  const bodyLayer = h('div', { class: styles.bodyLayer });
  stage.append(headerBand, bodyLayer);
  context.host.append(stage);

  const colSlots: ColSlot[] = [];
  const actSlots: ActSlot[] = [];
  const tickSlots: TickSlot[] = [];
  const rowSlots: RowSlot[] = [];

  let activeRows = 0;
  let activeActs = 0;
  let activeTicks = 0;
  let frame = 0;

  let cachedContentWidth = Number.NaN;
  let cachedHeaderHeight = Number.NaN;
  let cachedBodyHeight = Number.NaN;
  let cachedGutterWidth = Number.NaN;

  function hideAllPools(): void {
    activeRows = 0;
    activeActs = 0;
    activeTicks = 0;
    for (let c = 0; c < colSlots.length; c++) {
      const slot = colSlots[c];
      if (!slot.hidden) {
        slot.cardEl.style.display = 'none';
        slot.lifelineEl.style.display = 'none';
        slot.hidden = true;
      }
    }
    for (let a = 0; a < actSlots.length; a++) {
      const slot = actSlots[a];
      if (!slot.hidden) {
        slot.el.style.display = 'none';
        slot.hidden = true;
      }
    }
    for (let t = 0; t < tickSlots.length; t++) {
      const slot = tickSlots[t];
      if (!slot.hidden) {
        slot.el.style.display = 'none';
        slot.hidden = true;
      }
    }
    for (let r = 0; r < rowSlots.length; r++) {
      const slot = rowSlots[r];
      if (!slot.hidden) {
        slot.rowEl.style.display = 'none';
        slot.hidden = true;
        resetRowSlotCache(slot);
      }
    }
  }

  function paintColumns(plan: SequencePlan): void {
    const { layout, steps } = plan;
    if (layout === null || steps === null) return;
    const { participants } = steps.model;
    const count = plan.columnCount;

    while (colSlots.length < count) {
      const slot = createColSlot(styles);
      colSlots.push(slot);
      headerTrack.append(slot.cardEl);
      bodyLayer.append(slot.lifelineEl);
    }

    const cardW = Math.max(48, layout.columnWidth - 12);

    for (let c = 0; c < colSlots.length; c++) {
      const slot = colSlots[c];
      if (c >= count) {
        if (!slot.hidden) {
          slot.cardEl.style.display = 'none';
          slot.lifelineEl.style.display = 'none';
          slot.hidden = true;
        }
        continue;
      }

      if (slot.hidden) {
        slot.cardEl.style.display = '';
        slot.lifelineEl.style.display = '';
        slot.hidden = false;
      }

      const centerX = plan.colCenterX[c];
      const left = centerX - layout.gutterWidth - cardW / 2;
      if (left !== slot.left) {
        slot.cardEl.style.left = `${left}px`;
        slot.left = left;
      }
      if (cardW !== slot.width) {
        slot.cardEl.style.width = `${cardW}px`;
        slot.width = cardW;
      }
      if (centerX !== slot.centerX) {
        slot.lifelineEl.style.left = `${centerX}px`;
        slot.centerX = centerX;
      }

      const pId = plan.colParticipant[c];
      const pName =
        pId >= 0 && pId < participants.names.length ? (participants.names[pId] ?? '') : '';
      const pKind =
        pId >= 0 && pId < participants.kind.length
          ? participants.kind[pId]
          : ParticipantKind.Service;
      const subtitle =
        pKind === ParticipantKind.Gate
          ? 'entry'
          : pKind === ParticipantKind.Inferred
            ? 'external'
            : 'service';

      if (pName !== slot.title) {
        slot.titleEl.textContent = pName;
        slot.title = pName;
      }
      if (subtitle !== slot.subtitle) {
        slot.subtitleEl.textContent = subtitle;
        slot.subtitle = subtitle;
      }
      if (pKind !== slot.kind) {
        slot.cardEl.classList.toggle(styles.headerCardGate, pKind === ParticipantKind.Gate);
        slot.cardEl.classList.toggle(
          styles.headerCardInferred,
          pKind === ParticipantKind.Inferred,
        );
        slot.kind = pKind;
      }

      const state = plan.colState[c];
      if (state !== slot.state) {
        slot.cardEl.classList.toggle(
          styles.headerCardSelected,
          (state & PlanStateFlag.Selected) !== 0,
        );
        slot.cardEl.classList.toggle(
          styles.headerCardHover,
          (state & PlanStateFlag.Hovered) !== 0,
        );
        slot.cardEl.classList.toggle(
          styles.headerCardDimmed,
          (state & PlanStateFlag.Dimmed) !== 0,
        );
        slot.cardEl.classList.toggle(styles.headerCardError, (state & PlanStateFlag.Error) !== 0);
        slot.lifelineEl.classList.toggle(
          styles.lifelineDimmed,
          (state & PlanStateFlag.Dimmed) !== 0,
        );
        slot.state = state;
      }
    }
  }

  function paintActivations(plan: SequencePlan): void {
    const count = plan.actCount;
    activeActs = count;

    while (actSlots.length < count) {
      const slot = createActSlot(styles, actKindClasses[0]);
      actSlots.push(slot);
      bodyLayer.append(slot.el);
    }

    for (let a = 0; a < actSlots.length; a++) {
      const slot = actSlots[a];
      if (a >= count) {
        if (!slot.hidden) {
          slot.el.style.display = 'none';
          slot.hidden = true;
        }
        continue;
      }

      if (slot.hidden) {
        slot.el.style.display = '';
        slot.hidden = false;
      }

      const x = plan.actX[a];
      const y = plan.actY[a];
      const w = plan.actW[a];
      const h = plan.actH[a];

      if (x !== slot.x || y !== slot.y) {
        slot.el.style.transform = `translate(${x}px, ${y}px)`;
        slot.x = x;
        slot.y = y;
      }
      if (w !== slot.w) {
        slot.el.style.width = `${w}px`;
        slot.w = w;
      }
      if (h !== slot.h) {
        slot.el.style.height = `${h}px`;
        slot.h = h;
      }

      const rawKind = plan.actSpanKind[a];
      const kind = rawKind < actKindClasses.length ? rawKind : 0;
      if (kind !== slot.kind) {
        slot.el.classList.remove(actKindClasses[slot.kind]);
        slot.el.classList.add(actKindClasses[kind]);
        slot.kind = kind;
      }

      const state = plan.actState[a];
      if (state !== slot.state) {
        slot.el.classList.toggle(
          styles.activationSelected,
          (state & PlanStateFlag.Selected) !== 0,
        );
        slot.el.classList.toggle(styles.activationHover, (state & PlanStateFlag.Hovered) !== 0);
        slot.el.classList.toggle(styles.activationDimmed, (state & PlanStateFlag.Dimmed) !== 0);
        slot.el.classList.toggle(styles.activationError, (state & PlanStateFlag.Error) !== 0);
        slot.state = state;
      }

      const badge = plan.actBadge[a];
      if (badge !== slot.badge) {
        if (badge !== '') {
          slot.badgeEl.style.display = '';
          slot.badgeEl.textContent = badge;
        } else {
          slot.badgeEl.style.display = 'none';
          slot.badgeEl.textContent = '';
        }
        slot.badge = badge;
      }
    }
  }

  function paintTicks(plan: SequencePlan): void {
    const count = plan.tickCount;
    activeTicks = count;

    while (tickSlots.length < count) {
      const slot = createTickSlot(styles);
      tickSlots.push(slot);
      bodyLayer.append(slot.el);
    }

    for (let t = 0; t < tickSlots.length; t++) {
      const slot = tickSlots[t];
      if (t >= count) {
        if (!slot.hidden) {
          slot.el.style.display = 'none';
          slot.hidden = true;
        }
        continue;
      }

      if (slot.hidden) {
        slot.el.style.display = '';
        slot.hidden = false;
      }

      const x = plan.tickX[t];
      const y = plan.tickY[t];
      const isEx = plan.tickIsException[t];

      if (x !== slot.x) {
        slot.el.style.left = `${x}px`;
        slot.x = x;
      }
      if (y !== slot.y) {
        slot.el.style.top = `${y}px`;
        slot.y = y;
      }
      if (isEx !== slot.isException) {
        slot.el.classList.toggle(styles.eventTickException, isEx === 1);
        slot.isException = isEx;
      }
    }
  }

  function ensureRowSlots(stepCount: number): void {
    if (stepCount <= 0) return;
    const needed = stepCount + SPARE_ROW_SLOTS;
    if (rowSlots.length >= needed) return;
    while (rowSlots.length < needed) {
      const slot = createRowSlot(styles);
      rowSlots.push(slot);
      bodyLayer.append(slot.rowEl);
    }
    // Modulo index assignment changes when pool size grows; invalidate cached slot steps.
    for (let k = 0; k < rowSlots.length; k++) {
      resetRowSlotCache(rowSlots[k]);
    }
  }

  function paintRows(plan: SequencePlan): void {
    const { layout, steps } = plan;
    if (layout === null || steps === null) return;

    const stepCount = plan.stepCount;
    activeRows = stepCount;
    ensureRowSlots(stepCount);

    const currentFrame = ++frame;
    const poolSize = rowSlots.length;
    const rowHeight = layout.rowHeight;
    const gutterWidth = layout.gutterWidth;

    for (let i = 0; i < stepCount; i++) {
      const s = plan.stepIndex[i];
      const slot = rowSlots[s % poolSize];
      slot.usedFrame = currentFrame;

      if (slot.hidden) {
        slot.rowEl.style.display = '';
        slot.hidden = false;
      }

      const stepChanged = slot.step !== s;
      const y = plan.stepTopY[i];
      if (y !== slot.y) {
        slot.rowEl.style.transform = `translateY(${y}px)`;
        slot.y = y;
      }
      const rowHeightChanged = rowHeight !== slot.rowHeight;
      if (rowHeightChanged) {
        slot.rowEl.style.height = `${rowHeight}px`;
        slot.rowHeight = rowHeight;
      }

      if (stepChanged) {
        const rowId = `l2t-seq-step-${s}`;
        slot.rowEl.id = rowId;
        slot.rowEl.setAttribute('id', rowId);
        slot.step = s;
      }

      const depth = s >= 0 && s < steps.depth.length ? steps.depth[s] : 1;
      if (stepChanged || depth !== slot.depth) {
        slot.rowEl.setAttribute('aria-level', String(depth));
        slot.depth = depth;
      }

      const gutterText = plan.gutterText[i];
      if (stepChanged || gutterText !== slot.gutterText) {
        slot.gutterCell.textContent = gutterText;
        slot.gutterText = gutterText;
      }
      if (gutterWidth !== slot.gutterWidth) {
        slot.gutterCell.style.width = `${gutterWidth}px`;
        slot.gutterWidth = gutterWidth;
      }

      const state = plan.stepState[i];
      const stateChanged = stepChanged || state !== slot.state;
      const isErr = (state & PlanStateFlag.Error) !== 0;
      if (stateChanged) {
        const isSel = (state & PlanStateFlag.Selected) !== 0;
        const isHov = (state & PlanStateFlag.Hovered) !== 0;
        const isDim = (state & PlanStateFlag.Dimmed) !== 0;
        slot.rowEl.classList.toggle(styles.rowSelected, isSel);
        slot.rowEl.classList.toggle(styles.rowHover, isHov);
        slot.rowEl.classList.toggle(styles.rowDimmed, isDim);
        slot.rowEl.classList.toggle(styles.rowError, isErr);
        slot.rowEl.setAttribute('aria-selected', String(isSel));
        slot.badgeEl.classList.toggle(styles.arrowBadgeError, isErr);
      }

      const x0 = plan.arrowX0[i];
      const x1 = plan.arrowX1[i];
      const head = plan.arrowHead[i];
      const dashed = plan.arrowDashed[i];
      const selfLoop = plan.arrowSelfLoop[i];

      const arrowChanged =
        stepChanged ||
        rowHeightChanged ||
        stateChanged ||
        x0 !== slot.x0 ||
        x1 !== slot.x1 ||
        head !== slot.head ||
        dashed !== slot.dashed ||
        selfLoop !== slot.selfLoop;

      if (arrowChanged) {
        const midY = rowHeight / 2;
        if (selfLoop === 1) {
          slot.arrowLineEl.style.display = 'none';
          slot.selfLoopEl.style.display = '';
          slot.selfLoopEl.style.left = `${x0}px`;
          slot.selfLoopEl.style.width = `${Math.max(12, x1 - x0)}px`;
          slot.selfLoopEl.style.top = `${midY - 4}px`;

          slot.arrowHeadEl.style.display = '';
          slot.arrowHeadEl.style.left = `${x0}px`;
          slot.arrowHeadEl.style.top = `${midY + 8}px`;
          slot.arrowHeadEl.classList.toggle(styles.arrowHeadFilledLeft, true);
          slot.arrowHeadEl.classList.toggle(styles.arrowHeadFilledRight, false);
          slot.arrowHeadEl.classList.toggle(styles.arrowHeadOpenLeft, false);
          slot.arrowHeadEl.classList.toggle(styles.arrowHeadOpenRight, false);
          slot.arrowHeadEl.classList.toggle(styles.arrowHeadError, isErr);
        } else {
          slot.selfLoopEl.style.display = 'none';
          slot.arrowLineEl.style.display = '';
          slot.arrowLineEl.style.left = `${Math.min(x0, x1)}px`;
          slot.arrowLineEl.style.width = `${Math.max(2, Math.abs(x1 - x0))}px`;
          slot.arrowLineEl.style.top = `${midY}px`;
          slot.arrowLineEl.classList.toggle(styles.arrowLineDashed, dashed === 1);
          slot.arrowLineEl.classList.toggle(styles.arrowLineError, isErr);

          if (head === ArrowHeadKind.None) {
            slot.arrowHeadEl.style.display = 'none';
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadFilledLeft, false);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadFilledRight, false);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadOpenLeft, false);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadOpenRight, false);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadError, false);
          } else {
            slot.arrowHeadEl.style.display = '';
            slot.arrowHeadEl.style.left = `${x1}px`;
            slot.arrowHeadEl.style.top = `${midY}px`;
            const right = x1 >= x0;
            const filled = head === ArrowHeadKind.Filled;
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadFilledRight, filled && right);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadFilledLeft, filled && !right);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadOpenRight, !filled && right);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadOpenLeft, !filled && !right);
            slot.arrowHeadEl.classList.toggle(styles.arrowHeadError, isErr);
          }
        }

        slot.arrowLabelEl.style.left = `${Math.min(x0, x1) + 6}px`;
        slot.arrowLabelEl.style.top = `${midY - 2}px`;
        slot.arrowLabelEl.style.maxWidth = `${Math.max(60, Math.abs(x1 - x0) - 12)}px`;

        slot.x0 = x0;
        slot.x1 = x1;
        slot.head = head;
        slot.dashed = dashed;
        slot.selfLoop = selfLoop;
      }

      slot.state = state;

      const label = plan.stepLabel[i];
      if (stepChanged || label !== slot.label) {
        slot.labelTextEl.textContent = label;
        slot.label = label;
      }

      const badge = plan.stepBadge[i];
      if (stepChanged || badge !== slot.badge) {
        slot.badgeEl.textContent = badge;
        slot.badgeEl.style.display = badge !== '' ? '' : 'none';
        slot.badge = badge;
      }

      const gapText = plan.gapText[i];
      if (stepChanged || gapText !== slot.gapText) {
        slot.gapBannerEl.textContent = gapText;
        slot.gapBannerEl.style.display = gapText !== '' ? '' : 'none';
        slot.gapText = gapText;
      }
    }

    for (let k = 0; k < poolSize; k++) {
      const slot = rowSlots[k];
      if (slot.usedFrame !== currentFrame && !slot.hidden) {
        slot.rowEl.style.display = 'none';
        slot.hidden = true;
        resetRowSlotCache(slot);
      }
    }
  }

  return {
    paint(plan: SequencePlan, dirty: number): void {
      if (dirty === SequenceDirty.None && frame > 0) return;
      const { layout, steps } = plan;
      if (layout === null || steps === null) {
        hideAllPools();
        return;
      }

      const totalHeight = layout.headerHeight + layout.bodyHeight;
      if (layout.contentWidth !== cachedContentWidth) {
        stage.style.width = `${layout.contentWidth}px`;
        headerBand.style.width = `${layout.contentWidth}px`;
        bodyLayer.style.width = `${layout.contentWidth}px`;
        cachedContentWidth = layout.contentWidth;
      }
      if (
        layout.headerHeight !== cachedHeaderHeight ||
        layout.bodyHeight !== cachedBodyHeight
      ) {
        stage.style.height = `${totalHeight}px`;
        headerBand.style.height = `${layout.headerHeight}px`;
        bodyLayer.style.height = `${layout.bodyHeight}px`;
        cachedHeaderHeight = layout.headerHeight;
        cachedBodyHeight = layout.bodyHeight;
      }
      if (layout.gutterWidth !== cachedGutterWidth) {
        headerCorner.style.width = `${layout.gutterWidth}px`;
        cachedGutterWidth = layout.gutterWidth;
      }

      paintColumns(plan);
      paintActivations(plan);
      paintTicks(plan);
      paintRows(plan);
    },

    stats(): SequencePainterStats {
      return {
        rowSlots: rowSlots.length,
        activeRows,
        actSlots: actSlots.length,
        activeActs,
        tickSlots: tickSlots.length,
        activeTicks,
      };
    },

    destroy(): void {
      stage.remove();
      colSlots.length = 0;
      actSlots.length = 0;
      tickSlots.length = 0;
      rowSlots.length = 0;
      activeRows = 0;
      activeActs = 0;
      activeTicks = 0;
    },
  };
}
