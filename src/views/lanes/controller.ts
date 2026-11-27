/**
 * LanesController: the headless heart of the lanes view.
 *
 * It joins the shared store (what is loaded, selected, hovered, filtered, which window is shared) to
 * the view's own state (where the camera looks, how far the lanes are scrolled, how each lane is
 * shown) and to the pure model in `model/`. Painters ask it for a frame plan and a hit test; the DOM
 * binding feeds it input and store changes and redraws whatever its dirty bits say. It never touches
 * the DOM, so the whole behaviour is tested in Node against a real store.
 *
 * Shared state it follows: the data (a new index resets the view), the selection and hover (turned
 * into row masks, with the causal tree of the selection for dimming), the filter (non-matching
 * spans are dimmed and summaries count matches only, nothing is repacked) and the time window
 * (followed when another origin sets it, like the waterfall). The store's collapse state is ignored:
 * hiding spans would leave false idle gaps in the lanes.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  Slice,
  describeSpan,
  formatDuration,
  formatOffset,
  touches,
  type ChangeSet,
  type InfoModel,
  type InfoRow,
  type Origin,
  type SpanId,
  type TraceState,
  type TraceStore,
} from '../../core/index.ts';
import { spanTimings } from '../../core/self-time.ts';
import type { SpanIndex } from '../../core/span-index.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { formatZoom, withWindow, zoomRatio } from '../../kit/geometry/camera1d.ts';
import { HitPart, createHitResult, hitTest, rowsOfRun, type HitResult } from './model/hit.ts';
import {
  LanesDirty,
  fitViewState,
  initialViewState,
  reduceInteraction,
  restack,
  type Effect,
  type InteractionContext,
  type InteractionResult,
  type LanesInput,
  type StackSpec,
  type ViewState,
} from './model/interaction.ts';
import { lanesModel, orderLanes, type LaneModel, type LaneOrder } from './model/lanes.ts';
import { LANE_MODE_NAMES, LaneMode, computeLayout, parseLaneMode, resolveMetrics, type LanesLayout, type LanesMetrics } from './model/layout.ts';
import {
  LanesFramePlan,
  SummarySource,
  buildLanesPlan,
  laneBusyPercent,
  markRows,
  selectionMasks,
  type SelectionMasks,
} from './model/plan.ts';
import { levelAt } from './model/summary.ts';
import { DEFAULT_LANES_SETTINGS, metricsOf, type LanesSettings } from './settings.ts';

/** Options of {@link LanesController}. */
export interface ControllerOptions {
  /** The store of the trace being shown. */
  readonly store: TraceStore;
  /** Identifies this view in the store; changes it makes carry it, and it ignores its own echoes. */
  readonly origin: Origin;
  /** The view's settings (`lane-max-rows`, `lane-order`, …); defaults are filled in. */
  readonly settings?: Partial<LanesSettings>;
  /** Sizes of rows, bars, ruler and gutter on top of the settings; defaults are filled in. */
  readonly metrics?: Partial<LanesMetrics>;
}

/** What a store change or a resize asks of the painter. */
export interface UpdateResult {
  /** OR of {@link LanesDirty} bits. */
  readonly dirty: number;
  /** The scroll position was changed here: write {@link LanesController.state}`.scrollTop` to the scroller. */
  readonly scrollTo: boolean;
}

/** What {@link LanesController.input} and {@link LanesController.reveal} return: the reducer's outcome (state, dirty bits, handled, scrollTo, cursor, effects). */
export type InputResult = InteractionResult;

export type { ViewCommand };

/** What {@link LanesController.getState} returns and {@link LanesController.setState} takes. */
export interface SavedLanesState {
  /** The data generation the state was saved for; a state of another trace is dropped. */
  readonly generation: number;
  readonly t0: number;
  readonly t1: number;
  readonly scrollTop: number;
  /** Mode of each lane by lane name. */
  readonly laneModes: Readonly<Record<string, 'collapsed' | 'capped' | 'full'>>;
}

const NOTHING: UpdateResult = Object.freeze({ dirty: 0, scrollTo: false });
const EVERYTHING = LanesDirty.Lanes | LanesDirty.Scroll | LanesDirty.Camera | LanesDirty.Selection | LanesDirty.Hover | LanesDirty.Filter | LanesDirty.Size;

function orderOf(model: LaneModel, order: LaneOrder): Int32Array {
  return order === 'start' ? model.order : orderLanes(model, order);
}

/** The lanes view's state and behaviour, without any drawing. */
export class LanesController {
  readonly store: TraceStore;
  readonly origin: Origin;
  wheelZoom: boolean;

  private current: LanesSettings;
  private metrics: LanesMetrics;
  private laneModel: LaneModel;
  private source: SummarySource;
  private laneOrder: Int32Array;
  private viewLayout: LanesLayout;
  private viewState: ViewState;
  private generation: number;
  private width = 0;
  private height = 0;
  private lastPlan = new LanesFramePlan();
  private selectionTarget: TraceState['selection'] | null = null;
  private selectionMask: SelectionMasks | null = null;
  private hoverTarget: TraceState['hover'] = null;
  private hoverMask: Uint8Array | null = null;
  private readonly hitResult = createHitResult();

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.origin = options.origin;
    this.current = { ...DEFAULT_LANES_SETTINGS, ...options.settings };
    this.wheelZoom = this.current.wheelZoom;
    this.metrics = resolveMetrics({ ...metricsOf(this.current), ...options.metrics });

    const state = this.store.state;
    this.laneModel = this.store.derive(lanesModel);
    this.source = new SummarySource(this.laneModel);
    this.laneOrder = orderOf(this.laneModel, this.current.order);
    this.viewLayout = computeLayout(this.metrics, 0, 0);
    this.viewState = initialViewState(this.spec());
    this.generation = state.data.generation;
    this.syncTargets();
  }

  /** The loaded trace. */
  get index(): SpanIndex {
    return this.laneModel.index;
  }

  /** The lanes of the trace, packed once. */
  get model(): LaneModel {
    return this.laneModel;
  }

  /** Current geometry. */
  get layout(): LanesLayout {
    return this.viewLayout;
  }

  /** Camera, scroll position, hover, shown lanes and their modes. */
  get state(): ViewState {
    return this.viewState;
  }

  /** The settings in force. */
  get settings(): LanesSettings {
    return this.current;
  }

  /** The plan the last {@link LanesController.buildPlan} filled: what picking agrees with. */
  get plan(): LanesFramePlan {
    return this.lastPlan;
  }

  /** The cached step functions of the summaries (the painter does not need them; tests and tooltips do). */
  get summaries(): SummarySource {
    return this.source;
  }

  /** Table row of the primary selected span, or -1. */
  get selectedRow(): number {
    const primary = this.store.state.selection.primary;
    const span = primary === null ? undefined : this.index.spans.get(primary);
    return span === undefined ? -1 : span.idx;
  }

  /** Whether the span in table row `row` is part of the selection. */
  isSelected(row: number): boolean {
    this.syncTargets();
    return this.selectionMask !== null && this.selectionMask.selected[row] === 1;
  }

  /** Whether the span in table row `row` is part of the hover. */
  isHovered(row: number): boolean {
    this.syncTargets();
    return this.hoverMask !== null && this.hoverMask[row] === 1;
  }

  private spec(): StackSpec {
    return { model: this.laneModel, layout: this.viewLayout, order: this.laneOrder, showPeers: this.current.peers };
  }

  /** Turn the store's selection and hover into row masks, when they changed. */
  private syncTargets(): void {
    const { selection, hover } = this.store.state;
    if (selection !== this.selectionTarget) {
      this.selectionTarget = selection;
      this.selectionMask = selection.ids.size === 0 ? null : selectionMasks(this.index, this.rowsOf(selection.ids));
    }
    if (hover !== this.hoverTarget) {
      this.hoverTarget = hover;
      this.hoverMask = hover === null || hover.ids.size === 0 ? null : markRows(this.index, this.rowsOf(hover.ids));
    }
  }

  private rowsOf(ids: Iterable<SpanId>): number[] {
    const rows: number[] = [];
    for (const id of ids) {
      const span = this.index.spans.get(id);
      if (span !== undefined) rows.push(span.idx);
    }
    return rows;
  }

  private context(): InteractionContext {
    this.syncTargets();
    return {
      ...this.spec(),
      plan: this.lastPlan,
      matched: this.store.state.matched,
      selectedRow: this.selectedRow,
      selection: this.selectionMask,
      wheelZoom: this.wheelZoom,
    };
  }

  /** Lay the lanes out again after the sizes, order or peer flag changed; the lane at the top of the viewport stays put. */
  private relayout(): UpdateResult {
    this.viewLayout = computeLayout(this.metrics, this.width, this.height);
    const before = this.viewState;
    this.viewState = fitViewState(restack(before, this.spec(), before.stack.modes), this.viewLayout);
    return { dirty: LanesDirty.Lanes | LanesDirty.Size | LanesDirty.Camera | LanesDirty.Scroll, scrollTo: this.viewState.scrollTop !== before.scrollTop };
  }

  /** Change the sizes of rows, ruler and gutter. */
  setMetrics(metrics: Partial<LanesMetrics>): UpdateResult {
    this.metrics = resolveMetrics({ ...this.metrics, ...metrics });
    return this.relayout();
  }

  /** Take new settings: order, peers, wheel behaviour and the sizes they decide. */
  applySettings(settings: Partial<LanesSettings>): UpdateResult {
    this.current = { ...this.current, ...settings };
    this.wheelZoom = this.current.wheelZoom;
    this.metrics = resolveMetrics({ ...this.metrics, ...metricsOf(this.current) });
    this.laneOrder = orderOf(this.laneModel, this.current.order);
    return this.relayout();
  }

  /**
   * The view was resized (or the sizes changed).
   *
   * @param width - Width of the surface, CSS px.
   * @param height - Height of the surface, CSS px.
   */
  resize(width: number, height: number, force = false): UpdateResult {
    if (!force && width === this.width && height === this.height) return NOTHING;
    this.width = width;
    this.height = height;
    this.viewLayout = computeLayout(this.metrics, width, height);
    const before = this.viewState;
    this.viewState = fitViewState(before, this.viewLayout);
    return {
      dirty: LanesDirty.Size | LanesDirty.Camera | LanesDirty.Scroll,
      scrollTo: this.viewState.scrollTop !== before.scrollTop,
    };
  }

  private load(state: TraceState): void {
    this.laneModel = this.store.derive(lanesModel);
    this.source = new SummarySource(this.laneModel);
    this.laneOrder = orderOf(this.laneModel, this.current.order);
    this.generation = state.data.generation;
    this.viewState = initialViewState(this.spec());
    this.viewState = fitViewState(this.viewState, this.viewLayout);
    this.lastPlan = new LanesFramePlan();
    this.selectionTarget = null;
    this.hoverTarget = null;
    this.syncTargets();
  }

  /**
   * Take a change of the store into account.
   *
   * @param change - What changed; the state itself is read from the store.
   * @returns What to redraw.
   */
  update(change: ChangeSet): UpdateResult {
    const state = this.store.state;
    if (state.data.index !== this.laneModel.index) {
      this.load(state);
      return { dirty: EVERYTHING, scrollTo: true };
    }

    let dirty = 0;
    if (touches(change, Slice.Filter)) dirty |= LanesDirty.Filter;
    if (touches(change, Slice.Selection)) dirty |= LanesDirty.Selection;
    if (touches(change, Slice.Hover)) dirty |= LanesDirty.Hover;
    if (touches(change, Slice.Theme | Slice.Config)) dirty |= LanesDirty.Theme;
    this.syncTargets();
    if (touches(change, Slice.Window) && state.window !== null && change.origin !== this.origin) {
      const camera = withWindow(this.viewState.camera, state.window.t0, state.window.t1);
      if (camera.t0 !== this.viewState.camera.t0 || camera.t1 !== this.viewState.camera.t1) {
        this.viewState = { ...this.viewState, camera };
        dirty |= LanesDirty.Camera;
      }
    }
    return { dirty, scrollTo: false };
  }

  /**
   * Handle an input: move the camera or the scroll position, change lane modes, and pass what
   * concerns everyone (select, hover) on to the store.
   *
   * @returns The reducer's outcome; the caller cancels the event when `handled`, writes the
   *   scroll position when `scrollTo`, sets the cursor and redraws `dirty`.
   */
  input(input: LanesInput): InputResult {
    const result = reduceInteraction(this.viewState, input, this.context());
    this.viewState = result.state;
    for (const effect of result.effects) this.apply(effect);
    return result;
  }

  private apply(effect: Effect): void {
    const { table } = this.index;
    const options = { origin: this.origin };
    switch (effect.type) {
      case 'select': {
        if (effect.rows.length === 0) {
          this.store.setSelection([], options);
          break;
        }
        const ids = effect.rows.map((row) => table.ids[row]);
        const all = effect.additive ? [...this.store.state.selection.ids, ...ids] : ids;
        this.store.setSelection(all, { ...options, primary: table.ids[effect.primary], key: effect.key });
        break;
      }
      case 'hover': {
        const target = effect.target;
        if (target !== null && target.part === HitPart.Bar) {
          this.store.setHover([table.ids[target.row]], options);
        } else if (target !== null && target.part === HitPart.Run) {
          const { rows, primary } = rowsOfRun(this.lastPlan, target.run);
          this.store.setHover(rows.map((row) => table.ids[row]), { ...options, primary: table.ids[primary], key: `run:${target.item}:${target.count}` });
        } else {
          this.store.setHover(null, options);
        }
        break;
      }
    }
  }

  /**
   * Show a span: expand its lane if its mode hides the level, scroll its row into view and pan the
   * window to it when it is outside.
   *
   * @param id - The span.
   * @param align - Where to put the row when it has to scroll; defaults to the middle.
   */
  reveal(id: SpanId, align: 'nearest' | 'center' = 'center'): InputResult {
    const span = this.index.spans.get(id);
    if (span === undefined) {
      return { state: this.viewState, dirty: 0, handled: false, scrollTo: false, cursor: 'default', effects: [] };
    }
    return this.input({ type: 'reveal', row: span.idx, align });
  }

  /** Fill `plan` for the lanes in view; `plan` becomes what {@link LanesController.hit} picks against. */
  buildPlan(plan: LanesFramePlan, fitText: (text: string, maxWidth: number) => string, overscan = 0): void {
    this.syncTargets();
    buildLanesPlan(plan, {
      model: this.laneModel,
      layout: this.viewLayout,
      stack: this.viewState.stack,
      camera: this.viewState.camera,
      scrollTop: this.viewState.scrollTop,
      overscan,
      matched: this.store.state.matched,
      selection: this.selectionMask,
      hovered: this.hoverMask,
      summaries: this.source,
      fitText,
    });
    this.lastPlan = plan;
  }

  /** What is at a point of the view, as drawn by the last plan. The returned object is reused by the next call. */
  hit(x: number, y: number): HitResult {
    return hitTest(this.lastPlan, x, y, this.hitResult);
  }

  /** What to say about a hit, for the tooltip; `null` for the parts with nothing to say (ruler, nothing). */
  describeHit(hit: HitResult): InfoModel | null {
    const model = this.laneModel;
    const { matched } = this.store.state;
    const lane = hit.lane;
    const name = lane >= 0 ? model.names[lane] : '';
    switch (hit.part) {
      case HitPart.Bar: {
        const info = describeSpan(this.index, this.index.table.ids[hit.row], 'brief');
        if (info === null || !hit.ghost) return info;
        const [overview, ...rest] = info.sections;
        const rows: readonly InfoRow[] = [...(overview.rows ?? []), ['Seen as', `call to ${name}`]];
        return { ...info, sections: [{ ...overview, rows }, ...rest] };
      }
      case HitPart.Run: {
        const { itemStart, itemEnd, itemRow } = model;
        const { status } = this.index.table;
        const last = hit.item + hit.count - 1;
        let total = 0;
        let errors = 0;
        for (let i = hit.item; i <= last; i++) {
          total += itemEnd[i] - itemStart[i];
          if (status[itemRow[i]] === 2) errors++;
        }
        const rows: InfoRow[] = [
          ['Spans', String(hit.count)],
          ['Total', formatDuration(total)],
          ['Range', `${formatOffset(itemStart[hit.item])} – ${formatOffset(itemEnd[last])}`],
        ];
        if (errors > 0) rows.push(['Errors', String(errors)]);
        return { title: `${hit.count} spans`, subtitle: name, status: errors > 0 ? 'error' : undefined, sections: [{ title: 'Overview', rows }] };
      }
      case HitPart.Summary: {
        const steps = this.source.steps(lane, matched);
        const label = matched === null ? 'In flight' : 'Matching in flight';
        return {
          title: name,
          subtitle: 'Summary',
          sections: [{
            title: 'Overview',
            rows: [
              ['At', formatOffset(hit.t)],
              [label, String(levelAt(steps, hit.t))],
              ['Peak', String(steps.peak)],
              ['Busy', `${laneBusyPercent(model, lane)}%`],
            ],
          }],
        };
      }
      case HitPart.Overflow: {
        const k = this.viewState.stack.positionOfLane[lane];
        const hidden = k >= 0 ? this.viewState.stack.hidden[k] : 0;
        const steps = this.source.overflow(lane, this.viewLayout.maxRows, matched);
        return {
          title: `+${hidden} ${hidden === 1 ? 'row' : 'rows'}`,
          subtitle: name,
          sections: [{
            title: 'Hidden rows',
            rows: [
              ['At', formatOffset(hit.t)],
              ['In flight', String(levelAt(steps, hit.t))],
              ['Peak', String(steps.peak)],
              ['Levels', String(model.levelCount[lane])],
            ],
          }],
        };
      }
      case HitPart.IdleGap:
        return {
          title: `Idle ${formatDuration(hit.gapTo - hit.gapFrom)}`,
          subtitle: name,
          sections: [{ title: 'Overview', rows: [['From', formatOffset(hit.gapFrom)], ['To', formatOffset(hit.gapTo)]] }],
        };
      case HitPart.Header: {
        const rows: InfoRow[] = [
          ['Spans', String(model.spanCount[lane])],
          ['Busy', `${laneBusyPercent(model, lane)}%`],
          ['Peak', String(model.peak[lane])],
          ['Errors', String(model.errorCount[lane])],
        ];
        const peer = lane >= model.serviceCount;
        if (!peer) rows.push(['Self time', formatDuration(this.selfTimeOf(lane))]);
        return {
          title: name,
          subtitle: peer ? 'Peer lane' : 'Service lane',
          status: model.errorCount[lane] > 0 ? 'error' : undefined,
          sections: [{ title: 'Lane', rows }],
        };
      }
      default:
        return null;
    }
  }

  /** Summed self-time of the spans of a service lane in the shared window. */
  private selfTimeOf(lane: number): number {
    const { selfTime } = this.store.derive(spanTimings);
    const m = this.laneModel;
    let total = 0;
    for (let i = m.trackItemOff[m.laneTrackOff[lane]]; i < m.trackItemOff[m.laneTrackOff[lane + 1]]; i++) total += selfTime[m.itemRow[i]];
    return total;
  }

  /** The zoom level as text: `100%`, `250%`, `12.5x`. */
  zoomReadout(): string {
    return formatZoom(zoomRatio(this.viewState.camera));
  }

  /** The commands of the view, for the toolbar and the key handler. */
  commands(onResult?: (result: UpdateResult) => void): readonly ViewCommand[] {
    const run = (input: LanesInput) => (): void => {
      onResult?.(this.input(input));
    };
    const modes = (): Uint8Array => this.viewState.stack.modes;
    return [
      { id: 'zoom-in', label: 'Zoom in', keys: ['+', '='], run: run({ type: 'zoomBy', factor: 1 / 1.2 }) },
      { id: 'zoom-out', label: 'Zoom out', keys: ['-', '_'], run: run({ type: 'zoomBy', factor: 1.2 }) },
      { id: 'zoom-reset', label: 'Reset zoom', keys: ['0', 'Home'], run: run({ type: 'reset' }), readout: () => this.zoomReadout() },
      { id: 'expand-all', label: 'Expand all', keys: ['e', 'E'], run: run({ type: 'expandAll' }), enabled: () => modes().includes(LaneMode.Collapsed) },
      { id: 'collapse-all', label: 'Collapse all', keys: ['g', 'G'], run: run({ type: 'collapseAll' }), enabled: () => modes().some((m) => m !== LaneMode.Collapsed) },
    ];
  }

  /** The state worth keeping when the view is hidden: where it looks and how each lane is shown. */
  getState(): SavedLanesState {
    const { camera, scrollTop, stack } = this.viewState;
    const laneModes = Object.fromEntries(this.laneModel.names.map((name, lane) => [name, LANE_MODE_NAMES[stack.modes[lane]]]));
    return { generation: this.generation, t0: camera.t0, t1: camera.t1, scrollTop, laneModes };
  }

  /**
   * Restore what {@link LanesController.getState} returned. A state saved for another data
   * generation is dropped, and so is anything malformed.
   */
  setState(saved: unknown): UpdateResult {
    if (saved === null || typeof saved !== 'object') return NOTHING;
    const rec = saved as Partial<Record<keyof SavedLanesState, unknown>>;
    if (rec.generation !== this.generation) return NOTHING;

    const modes = this.viewState.stack.modes.slice();
    if (rec.laneModes !== null && typeof rec.laneModes === 'object') {
      const byName = rec.laneModes as Record<string, unknown>;
      for (let lane = 0; lane < modes.length; lane++) {
        const mode = parseLaneMode(byName[this.laneModel.names[lane]]);
        if (mode !== undefined) modes[lane] = mode;
      }
    }
    const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    const camera = withWindow(this.viewState.camera, finite(rec.t0, this.viewState.camera.t0), finite(rec.t1, this.viewState.camera.t1));
    const stacked = restack({ ...this.viewState, camera }, this.spec(), modes);
    this.viewState = fitViewState({ ...stacked, scrollTop: Math.max(0, finite(rec.scrollTop, 0)) }, this.viewLayout);
    return { dirty: LanesDirty.Lanes | LanesDirty.Camera | LanesDirty.Scroll, scrollTo: true };
  }
}
