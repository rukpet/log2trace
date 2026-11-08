/**
 * SequenceController: headless controller joining the shared TraceStore to the
 * sequence diagram's view-local state, step projection, layout, frame plan,
 * hit testing, and tooltip descriptions.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  Slice,
  describeSpan,
  extractAnyValue,
  formatOffset,
  touches,
  type ChangeSet,
  type InfoModel,
  type InfoRow,
  type Origin,
  type SpanId,
  type TraceStore,
} from '../../core.ts';
import {
  describeActivation,
  describeParticipant,
  describeStep,
} from './model/describe.ts';
import { HitKind, hitTestSequence, type SequenceHit } from './model/hit.ts';
import {
  SequenceDirty,
  clampSequenceScrollLeft,
  clampSequenceScrollTop,
  createInitialSequenceViewState,
  reduceSequenceInteraction,
  revealStepScrollTop,
  type SequenceEffect,
  type SequenceInput,
  type SequenceViewState,
} from './model/interaction.ts';
import {
  ROW_H_MAX,
  ROW_H_MIN,
  computeSequenceLayout,
  type SequenceLayout,
} from './model/layout.ts';
import { sequenceModel, type SequenceModel } from './model/messages.ts';
import { SequencePlan, buildSequencePlan } from './model/plan.ts';
import { StepKind, projectSteps, type SequenceSteps } from './model/steps.ts';
import {
  DEFAULT_SEQUENCE_SETTINGS,
  type InternalSpanMode,
  type ReturnArrowMode,
  type SequenceSettings,
} from './settings.ts';

export interface SequenceControllerOptions {
  readonly store: TraceStore;
  readonly origin: Origin;
  readonly settings?: Partial<SequenceSettings>;
  readonly onHover?: (hit: SequenceHit | null) => void;
  readonly onScrollTo?: (scrollTop: number, scrollLeft?: number) => void;
}

interface SavedSequenceViewState {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowHeight: number;
  readonly fitColumns: boolean;
  readonly internal: InternalSpanMode;
  readonly returns: ReturnArrowMode;
  readonly matchesOnly: boolean;
  readonly hideUnaffectedColumns: boolean;
  readonly expandedFolds: readonly string[];
  readonly focusStep: number;
}

export class SequenceController {
  readonly store: TraceStore;
  readonly origin: Origin;
  viewState: SequenceViewState;
  dirty: number;
  readonly plan: SequencePlan;
  steps: SequenceSteps | null = null;
  layout: SequenceLayout | null = null;
  wheelZoom: boolean;

  private readonly onHover?: (hit: SequenceHit | null) => void;
  private readonly onScrollTo?: (scrollTop: number, scrollLeft?: number) => void;
  private activeColumns: readonly number[] | undefined = undefined;

  constructor(options: SequenceControllerOptions) {
    this.store = options.store;
    this.origin = options.origin;
    this.onHover = options.onHover;
    this.onScrollTo = options.onScrollTo;
    this.wheelZoom = options.settings?.wheelZoom ?? DEFAULT_SEQUENCE_SETTINGS.wheelZoom;
    this.viewState = createInitialSequenceViewState(options.settings);
    this.dirty = SequenceDirty.All;
    this.plan = new SequencePlan();

    this.recomputeStepsAndLayout(true);
    this.syncFocusFromSelection();
  }

  private computeSteps(model: SequenceModel): SequenceSteps {
    const { collapsed, matched, window } = this.store.state;
    const steps = projectSteps(model, collapsed, matched, window, {
      internal: this.viewState.internal,
      returns: this.viewState.returns,
      foldMin: this.viewState.foldMin,
      expandedFolds: this.viewState.expandedFolds,
      matchesOnly: this.viewState.matchesOnly,
    });
    this.steps = steps;
    return steps;
  }

  private computeActiveColumns(steps: SequenceSteps): readonly number[] | undefined {
    if (!this.viewState.hideUnaffectedColumns) {
      this.activeColumns = undefined;
      return undefined;
    }
    const { participants } = steps.model;
    const used = new Uint8Array(participants.count);
    for (let s = 0; s < steps.count; s++) {
      const f = steps.from[s];
      const t = steps.to[s];
      if (f >= 0 && f < participants.count) used[f] = 1;
      if (t >= 0 && t < participants.count) used[t] = 1;
    }
    const cols: number[] = [];
    for (let c = 0; c < participants.count; c++) {
      const pId = participants.atColumn[c];
      if (used[pId] === 1) {
        cols.push(pId);
      }
    }
    this.activeColumns = cols;
    return cols;
  }

  private computeLayoutFor(steps: SequenceSteps): SequenceLayout {
    const activeCols = this.computeActiveColumns(steps);
    const columnCount =
      activeCols !== undefined ? activeCols.length : steps.model.participants.count;
    const nextLayout = computeSequenceLayout({
      viewWidth: this.viewState.viewWidth,
      viewHeight: this.viewState.viewHeight,
      columnCount,
      rowCount: steps.count,
      rowHeight: this.viewState.rowHeight,
      fitColumns: this.viewState.fitColumns,
    });
    this.layout = nextLayout;
    const scrollTop = clampSequenceScrollTop(nextLayout, this.viewState.scrollTop);
    const scrollLeft = clampSequenceScrollLeft(nextLayout, this.viewState.scrollLeft);
    const focusStep =
      this.viewState.focusStep >= steps.count
        ? steps.count - 1
        : this.viewState.focusStep;
    if (
      scrollTop !== this.viewState.scrollTop ||
      scrollLeft !== this.viewState.scrollLeft ||
      focusStep !== this.viewState.focusStep
    ) {
      this.viewState = {
        ...this.viewState,
        scrollTop,
        scrollLeft,
        focusStep,
      };
    }
    return nextLayout;
  }

  private recomputeStepsAndLayout(reprojectSteps: boolean): {
    readonly steps: SequenceSteps;
    readonly layout: SequenceLayout;
  } {
    const model = this.store.derive(sequenceModel);
    const steps =
      reprojectSteps || this.steps === null || this.steps.model !== model
        ? this.computeSteps(model)
        : this.steps;
    const layout = this.computeLayoutFor(steps);
    return { steps, layout };
  }

  private syncFocusFromSelection(): void {
    const steps = this.steps ?? this.recomputeStepsAndLayout(true).steps;
    const primary = this.store.state.selection.primary;
    if (primary === null) {
      if (this.viewState.focusStep !== -1) {
        this.viewState = { ...this.viewState, focusStep: -1 };
      }
      return;
    }
    const indexed = this.store.state.data.index.spans.get(primary);
    const focusStep =
      indexed !== undefined && indexed.idx < steps.stepOfRow.length
        ? steps.stepOfRow[indexed.idx]
        : -1;
    if (focusStep !== this.viewState.focusStep) {
      this.viewState = { ...this.viewState, focusStep };
    }
  }

  /**
   * Handle a store notification.
   * Updates dirty flags, ignores own origin echoes for selection/hover, and maps
   * external selection to `focusStep = steps.stepOfRow[idx]`.
   */
  handleStoreChange(change: ChangeSet): number {
    const isOwnEcho = change.origin === this.origin;
    let dirty = SequenceDirty.None;

    if (touches(change, Slice.Data)) {
      this.viewState = {
        ...this.viewState,
        scrollTop: 0,
        scrollLeft: 0,
        expandedFolds: new Set<string>(),
        focusStep: -1,
      };
      this.recomputeStepsAndLayout(true);
      this.syncFocusFromSelection();
      dirty |= SequenceDirty.All;
      this.dirty |= dirty;
      return dirty;
    }

    if (touches(change, Slice.Collapse | Slice.Filter | Slice.Window)) {
      this.recomputeStepsAndLayout(true);
      dirty |=
        SequenceDirty.Rows |
        SequenceDirty.Layout |
        (this.viewState.hideUnaffectedColumns ? SequenceDirty.Columns : SequenceDirty.None);
    }

    if (touches(change, Slice.Selection) && !isOwnEcho) {
      this.syncFocusFromSelection();
      dirty |= SequenceDirty.Overlay;
    }

    if (touches(change, Slice.Hover) && !isOwnEcho) {
      dirty |= SequenceDirty.Overlay;
    }

    if (touches(change, Slice.Theme)) {
      dirty |= SequenceDirty.Theme;
    }

    if (touches(change, Slice.Config)) {
      this.recomputeStepsAndLayout(true);
      dirty |= SequenceDirty.Layout | SequenceDirty.Rows | SequenceDirty.Theme;
    }

    this.dirty |= dirty;
    return dirty;
  }

  /**
   * Run `reduceSequenceInteraction` and apply resulting `SequenceEffect`s to the store.
   */
  handleInput(input: SequenceInput): { handled: boolean; dirty: number } {
    const { steps, layout } = this.recomputeStepsAndLayout(false);
    const transition = reduceSequenceInteraction(this.viewState, input, steps, layout);
    this.viewState = transition.state;
    let dirty = transition.dirty;

    if ((dirty & (SequenceDirty.Rows | SequenceDirty.Layout | SequenceDirty.Columns)) !== 0) {
      this.recomputeStepsAndLayout((dirty & SequenceDirty.Rows) !== 0);
    }

    for (const effect of transition.effects) {
      dirty |= this.applyEffect(effect);
    }

    this.dirty |= dirty;
    return { handled: transition.handled, dirty };
  }

  private applyEffect(effect: SequenceEffect): number {
    const originOpts = { origin: this.origin };
    switch (effect.type) {
      case 'select': {
        this.store.setSelection(effect.ids, {
          ...originOpts,
          primary: effect.primary ?? undefined,
          key: effect.key || undefined,
        });
        return SequenceDirty.Overlay;
      }
      case 'hover': {
        if (effect.ids === null || effect.ids.length === 0) {
          this.store.setHover(null, originOpts);
        } else {
          this.store.setHover(effect.ids, {
            ...originOpts,
            primary: effect.primary ?? undefined,
            key: effect.key || undefined,
          });
        }
        this.onHover?.(effect.hit);
        return SequenceDirty.Overlay;
      }
      case 'toggle-collapse': {
        this.store.toggleCollapse(effect.id, originOpts);
        this.recomputeStepsAndLayout(true);
        return (
          SequenceDirty.Rows |
          SequenceDirty.Layout |
          (this.viewState.hideUnaffectedColumns ? SequenceDirty.Columns : SequenceDirty.None)
        );
      }
      case 'scroll-to': {
        this.onScrollTo?.(effect.scrollTop, effect.scrollLeft ?? this.viewState.scrollLeft);
        return SequenceDirty.Scroll;
      }
    }
  }

  /** Apply updated `SequenceSettings`. */
  applySettings(settings: SequenceSettings): number {
    const rowHeight = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, settings.rowHeight));
    this.wheelZoom = settings.wheelZoom;
    this.viewState = {
      ...this.viewState,
      internal: settings.internal,
      returns: settings.returns,
      foldMin: settings.foldMin,
      rowHeight,
    };
    this.recomputeStepsAndLayout(true);
    const dirty =
      SequenceDirty.Rows |
      SequenceDirty.Layout |
      (this.viewState.hideUnaffectedColumns ? SequenceDirty.Columns : SequenceDirty.None);
    this.dirty |= dirty;
    return dirty;
  }

  /** Set the internal span display mode (`'auto' | 'hide' | 'show'`). */
  setInternalMode(mode: InternalSpanMode): number {
    if (this.viewState.internal === mode) return SequenceDirty.None;
    this.viewState = { ...this.viewState, internal: mode };
    this.recomputeStepsAndLayout(true);
    const dirty =
      SequenceDirty.Rows |
      SequenceDirty.Layout |
      (this.viewState.hideUnaffectedColumns ? SequenceDirty.Columns : SequenceDirty.None);
    this.dirty |= dirty;
    return dirty;
  }

  /** Set the synchronous return arrow display mode (`'all' | 'errors' | 'none'`). */
  setReturnsMode(mode: ReturnArrowMode): number {
    if (this.viewState.returns === mode) return SequenceDirty.None;
    this.viewState = { ...this.viewState, returns: mode };
    this.recomputeStepsAndLayout(true);
    const dirty = SequenceDirty.Rows | SequenceDirty.Layout;
    this.dirty |= dirty;
    return dirty;
  }

  /** Toggle showing only filter-matching subtrees. */
  toggleMatchesOnly(): number {
    this.viewState = { ...this.viewState, matchesOnly: !this.viewState.matchesOnly };
    this.recomputeStepsAndLayout(true);
    const dirty =
      SequenceDirty.Rows |
      SequenceDirty.Layout |
      (this.viewState.hideUnaffectedColumns ? SequenceDirty.Columns : SequenceDirty.None);
    this.dirty |= dirty;
    return dirty;
  }

  /** Toggle hiding lifeline columns that have no visible messages in the projected steps. */
  toggleHideUnaffectedColumns(): number {
    this.viewState = {
      ...this.viewState,
      hideUnaffectedColumns: !this.viewState.hideUnaffectedColumns,
    };
    this.recomputeStepsAndLayout(false);
    const dirty = SequenceDirty.Columns | SequenceDirty.Layout;
    this.dirty |= dirty;
    return dirty;
  }

  /** Toggle fitting lifeline columns into the available viewport width. */
  toggleFitColumns(): number {
    this.viewState = { ...this.viewState, fitColumns: !this.viewState.fitColumns };
    this.recomputeStepsAndLayout(false);
    const dirty = SequenceDirty.Columns | SequenceDirty.Layout;
    this.dirty |= dirty;
    return dirty;
  }

  /** Scale step row height by `factor`, anchored at the vertical center of the body viewport. */
  zoomDensity(factor: number): number {
    const { layout } = this.recomputeStepsAndLayout(false);
    const anchorY = layout.headerHeight + layout.bodyViewportHeight / 2;
    return this.handleInput({ type: 'zoom-density', factor, anchorY }).dirty;
  }

  /**
   * Reveal a span by ID: expands any containing fold if `id` is inside a folded step,
   * finds `step = steps.stepOfRow[idx]`, updates `focusStep = step`, and scrolls to reveal `step`.
   */
  revealSpan(id: SpanId): number {
    const index = this.store.state.data.index;
    const indexed = index.spans.get(id);
    if (indexed === undefined) return SequenceDirty.None;

    let dirty = SequenceDirty.None;

    if (this.store.state.collapsed.size > 0) {
      const beforeCollapsed = this.store.state.collapsed;
      this.store.expandAncestors(id, { origin: this.origin });
      if (this.store.state.collapsed !== beforeCollapsed) {
        dirty |= SequenceDirty.Rows | SequenceDirty.Layout;
        this.recomputeStepsAndLayout(true);
      }
    }

    let { steps, layout } = this.recomputeStepsAndLayout((dirty & SequenceDirty.Rows) !== 0);
    let step = indexed.idx < steps.stepOfRow.length ? steps.stepOfRow[indexed.idx] : -1;

    while (step >= 0 && step < steps.count && steps.kind[step] === StepKind.Fold) {
      const foldKey = `fold:${steps.row[step]}`;
      if (this.viewState.expandedFolds.has(foldKey)) break;
      const nextFolds = new Set(this.viewState.expandedFolds);
      nextFolds.add(foldKey);
      this.viewState = { ...this.viewState, expandedFolds: nextFolds };
      dirty |= SequenceDirty.Rows | SequenceDirty.Layout;
      const updated = this.recomputeStepsAndLayout(true);
      steps = updated.steps;
      layout = updated.layout;
      step = indexed.idx < steps.stepOfRow.length ? steps.stepOfRow[indexed.idx] : -1;
    }

    if (step < 0 || step >= steps.count) {
      this.dirty |= dirty;
      return dirty;
    }

    const scrollTop = revealStepScrollTop(layout, this.viewState.scrollTop, step);
    this.viewState = {
      ...this.viewState,
      focusStep: step,
      scrollTop,
    };
    this.onScrollTo?.(scrollTop, this.viewState.scrollLeft);
    dirty |= SequenceDirty.Scroll | SequenceDirty.Overlay;
    this.dirty |= dirty;
    return dirty;
  }

  /**
   * Recompute `steps` and `layout` when needed and build the current `SequencePlan`.
   */
  buildPlan(): SequencePlan {
    const currentModel = this.store.derive(sequenceModel);
    const modelChanged = this.steps === null || this.steps.model !== currentModel;
    const rowsDirty = (this.dirty & SequenceDirty.Rows) !== 0;
    const layoutDirty =
      (this.dirty & (SequenceDirty.Layout | SequenceDirty.Columns)) !== 0 ||
      this.layout === null;

    if (modelChanged || rowsDirty || this.steps === null) {
      this.computeSteps(currentModel);
    }
    const steps = this.steps ?? this.computeSteps(currentModel);

    if (modelChanged || rowsDirty || layoutDirty || this.layout === null) {
      this.computeLayoutFor(steps);
      this.plan.sceneStamp++;
    }
    const layout = this.layout ?? this.computeLayoutFor(steps);

    buildSequencePlan(this.plan, {
      steps,
      layout,
      scrollTop: this.viewState.scrollTop,
      scrollLeft: this.viewState.scrollLeft,
      selection: this.store.state.selection.ids,
      hover: this.store.state.hover?.ids ?? null,
      activeColumns: this.activeColumns,
    });

    this.dirty = SequenceDirty.None;
    return this.plan;
  }

  /** Geometric hit test at `(viewX, viewY)` in surface viewport coordinates. */
  hitTest(viewX: number, viewY: number): SequenceHit {
    if (this.plan.steps === null || this.plan.layout === null) {
      this.buildPlan();
    }
    return hitTestSequence(this.plan, viewX, viewY);
  }

  /** Build a tooltip `InfoModel` for a `SequenceHit`. */
  describeHit(hit: SequenceHit): InfoModel | null {
    const { steps } = this.recomputeStepsAndLayout(false);
    switch (hit.kind) {
      case HitKind.Participant:
        return describeParticipant(steps.model, hit.index);
      case HitKind.Step:
      case HitKind.Fold:
        return describeStep(steps, hit.index);
      case HitKind.Activation:
        return describeActivation(steps, hit.index);
      case HitKind.EventTick:
        return this.describeEventTick(steps, hit.row, hit.eventIdx);
      case HitKind.None:
      default:
        return null;
    }
  }

  private describeEventTick(
    steps: SequenceSteps,
    row: number,
    eventIdx: number,
  ): InfoModel | null {
    const { index } = steps.model;
    const { table } = index;
    if (row < 0 || row >= table.length) return null;
    const indexed = index.ordered[row];
    if (!indexed) return null;

    const evStart = table.evOff[row];
    const evEnd = table.evOff[row + 1];
    let k = -1;
    if (eventIdx >= evStart && eventIdx < evEnd) {
      k = eventIdx;
    } else if (eventIdx >= 0 && evStart + eventIdx < evEnd) {
      k = evStart + eventIdx;
    }

    const ev = k >= 0 ? indexed.span.events?.[table.evSrc[k]] : undefined;
    if (!ev) {
      return describeSpan(index, indexed.spanId, 'brief');
    }

    const evTime = table.evT[k];
    const rows: InfoRow[] = [
      ['Span', indexed.span.name],
      ['Service', indexed.serviceName],
      ['Offset', formatOffset(evTime - table.start[row])],
      ['Trace Time', formatOffset(evTime)],
      ...(ev.attributes ?? []).map((a): InfoRow => [a.key, extractAnyValue(a.value)]),
    ];
    return {
      title: ev.name,
      subtitle: `${indexed.serviceName} · ${indexed.span.name}`,
      status: ev.name === 'exception' ? 'error' : 'unset',
      sections: [{ title: 'Span Event', rows }],
    };
  }

  /** Save view-local state for tab switching. */
  getState(): unknown {
    const s = this.viewState;
    const saved: SavedSequenceViewState = {
      scrollTop: s.scrollTop,
      scrollLeft: s.scrollLeft,
      rowHeight: s.rowHeight,
      fitColumns: s.fitColumns,
      internal: s.internal,
      returns: s.returns,
      matchesOnly: s.matchesOnly,
      hideUnaffectedColumns: s.hideUnaffectedColumns,
      expandedFolds: [...s.expandedFolds],
      focusStep: s.focusStep,
    };
    return saved;
  }

  /** Restore view-local state previously returned by `getState()`. */
  setState(saved: unknown): void {
    if (saved === null || typeof saved !== 'object') return;
    const rec = saved as Record<string, unknown>;

    const scrollTop =
      typeof rec.scrollTop === 'number' && Number.isFinite(rec.scrollTop)
        ? Math.max(0, rec.scrollTop)
        : this.viewState.scrollTop;
    const scrollLeft =
      typeof rec.scrollLeft === 'number' && Number.isFinite(rec.scrollLeft)
        ? Math.max(0, rec.scrollLeft)
        : this.viewState.scrollLeft;
    const rowHeight =
      typeof rec.rowHeight === 'number' && Number.isFinite(rec.rowHeight)
        ? Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, rec.rowHeight))
        : this.viewState.rowHeight;
    const fitColumns =
      typeof rec.fitColumns === 'boolean' ? rec.fitColumns : this.viewState.fitColumns;
    const internal: InternalSpanMode =
      rec.internal === 'auto' || rec.internal === 'hide' || rec.internal === 'show'
        ? rec.internal
        : this.viewState.internal;
    const returns: ReturnArrowMode =
      rec.returns === 'all' || rec.returns === 'errors' || rec.returns === 'none'
        ? rec.returns
        : this.viewState.returns;
    const matchesOnly =
      typeof rec.matchesOnly === 'boolean' ? rec.matchesOnly : this.viewState.matchesOnly;
    const hideUnaffectedColumns =
      typeof rec.hideUnaffectedColumns === 'boolean'
        ? rec.hideUnaffectedColumns
        : this.viewState.hideUnaffectedColumns;

    let expandedFolds = this.viewState.expandedFolds;
    if (Array.isArray(rec.expandedFolds)) {
      const next = new Set<string>();
      for (const item of rec.expandedFolds) {
        if (typeof item === 'string') next.add(item);
      }
      expandedFolds = next;
    } else if (rec.expandedFolds instanceof Set) {
      const next = new Set<string>();
      for (const item of rec.expandedFolds) {
        if (typeof item === 'string') next.add(item);
      }
      expandedFolds = next;
    }

    const focusStep =
      typeof rec.focusStep === 'number' && Number.isFinite(rec.focusStep)
        ? Math.floor(rec.focusStep)
        : this.viewState.focusStep;

    this.viewState = {
      ...this.viewState,
      scrollTop,
      scrollLeft,
      rowHeight,
      fitColumns,
      internal,
      returns,
      matchesOnly,
      hideUnaffectedColumns,
      expandedFolds,
      focusStep,
    };

    this.recomputeStepsAndLayout(true);
    this.dirty = SequenceDirty.All;
    this.onScrollTo?.(this.viewState.scrollTop, this.viewState.scrollLeft);
  }
}
