/**
 * WaterfallController: the headless heart of the waterfall view.
 *
 * It joins the shared store (what is loaded, selected, collapsed, filtered) to the view's own
 * state (where the camera looks, how far the rows are scrolled) and to the pure model in
 * `model/`. Painters ask it for a frame plan and a hit test; the DOM binding feeds it input and
 * store changes and redraws whatever its dirty bits say. It never touches the DOM, so the whole
 * behaviour is tested in Node against a real store.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  Slice,
  touches,
  type ChangeSet,
  type Origin,
  type SpanId,
  type TraceState,
  type TraceStore,
} from '../../core.ts';
import { formatZoom, withWindow, zoomRatio } from '../../kit/geometry/camera1d.ts';
import type { SpanIndex } from '../../core/span-index.ts';
import { createHitResult, hitTest, type HitResult } from './model/hit.ts';
import {
  WaterfallDirty,
  anchoredScrollTop,
  fitViewState,
  initialViewState,
  reduceInteraction,
  type Effect,
  type InteractionContext,
  type InteractionResult,
  type ViewState,
  type WaterfallInput,
} from './model/interaction.ts';
import { computeLayout, resolveMetrics, type WaterfallLayout, type WaterfallMetrics } from './model/layout.ts';
import { buildFramePlan, type FramePlan } from './model/plan.ts';
import { Chevron, chevronOf, projectRows, type RowProjection } from './model/rows.ts';

/** Options of {@link WaterfallController}. */
export interface ControllerOptions {
  /** The store of the trace being shown. */
  readonly store: TraceStore;
  /** Identifies this view in the store; changes it makes carry it, and it ignores its own echoes. */
  readonly origin: Origin;
  /** Sizes of rows, bars, ruler and gutter; defaults are filled in. */
  readonly metrics?: Partial<WaterfallMetrics>;
  /** Let the plain wheel zoom instead of scrolling the rows (the old behaviour). */
  readonly wheelZoom?: boolean;
}

/** What a store change or a resize asks of the painter. */
export interface UpdateResult {
  /** OR of {@link WaterfallDirty} bits. */
  readonly dirty: number;
  /** The scroll position was changed here: write {@link WaterfallController.state}`.scrollTop` to the scroller. */
  readonly scrollTo: boolean;
}

/** A button or key the view offers; the toolbar, the key handler and the a11y layer all read this list. */
export interface ViewCommand {
  readonly id: string;
  readonly label: string;
  /** Keys that trigger it, as `KeyboardEvent.key` values. */
  readonly keys?: readonly string[];
  run(): void;
  /** Text to show next to the command, such as the zoom level. */
  readonly readout?: () => string;
  readonly enabled?: () => boolean;
}

/** One row of the accessibility tree. */
export interface A11yItem {
  readonly id: SpanId;
  /** What a screen reader says: service and span name. */
  readonly label: string;
  /** Depth in the tree, from 0. */
  readonly level: number;
  /** `undefined` for a leaf. */
  readonly expanded?: boolean;
  readonly selected: boolean;
  /** Position among all rows, from 1. */
  readonly position: number;
}

/** The part of the tree a screen reader needs: the rows in view. */
export interface A11yTree {
  readonly role: 'tree';
  readonly label: string;
  /** Id of the selected span when it is among `items`, else `null`. */
  readonly activeId: SpanId | null;
  /** Number of rows in all. */
  readonly size: number;
  readonly items: readonly A11yItem[];
}

/** The waterfall's state and behaviour, without any drawing. */
export class WaterfallController {
  readonly store: TraceStore;
  readonly origin: Origin;
  wheelZoom: boolean;

  private metrics: WaterfallMetrics;
  private viewIndex: SpanIndex;
  private rows: RowProjection;
  private viewLayout: WaterfallLayout;
  private viewState: ViewState;
  private maxDepth = 0;
  private width = 0;
  private height = 0;
  private readonly hitResult = createHitResult();

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.origin = options.origin;
    this.wheelZoom = options.wheelZoom ?? false;
    this.metrics = resolveMetrics(options.metrics);

    const state = this.store.state;
    this.viewIndex = state.data.index;
    this.maxDepth = deepest(this.viewIndex);
    this.viewLayout = computeLayout(this.metrics, 0, 0, this.maxDepth);
    this.rows = projectRows(this.viewIndex, state.collapsed, state.matched);
    this.viewState = initialViewState(this.viewIndex, this.viewLayout);
  }

  /** The loaded trace. */
  get index(): SpanIndex {
    return this.viewIndex;
  }

  /** The rows shown. */
  get projection(): RowProjection {
    return this.rows;
  }

  /** Current geometry. */
  get layout(): WaterfallLayout {
    return this.viewLayout;
  }

  /** Camera, scroll position and hover. */
  get state(): ViewState {
    return this.viewState;
  }

  /** Waterfall row of the primary selected span, or -1 for none or hidden. */
  get selectedRow(): number {
    const primary = this.store.state.selection.primary;
    const span = primary === null ? undefined : this.viewIndex.spans.get(primary);
    return span === undefined ? -1 : this.rows.rowOf[span.idx];
  }

  /** Whether the span in table row `span` is part of the selection. */
  isSelected(span: number): boolean {
    return this.store.state.selection.ids.has(this.viewIndex.table.ids[span]);
  }

  /** Whether the span in table row `span` is part of the hover. */
  isHovered(span: number): boolean {
    return this.store.state.hover?.ids.has(this.viewIndex.table.ids[span]) ?? false;
  }

  private context(): InteractionContext {
    const { collapsed } = this.store.state;
    return {
      index: this.viewIndex,
      projection: this.rows,
      collapsed,
      layout: this.viewLayout,
      selectedRow: this.selectedRow,
      wheelZoom: this.wheelZoom,
    };
  }

  /** Change the sizes of rows and ruler. */
  setMetrics(metrics: Partial<WaterfallMetrics>): UpdateResult {
    this.metrics = resolveMetrics({ ...this.metrics, ...metrics });
    return this.resize(this.width, this.height, true);
  }

  /**
   * The view was resized (or the sizes changed).
   *
   * @param width - Width of the surface, CSS px.
   * @param height - Height of the surface, CSS px.
   */
  resize(width: number, height: number, force = false): UpdateResult {
    if (!force && width === this.width && height === this.height) return { dirty: 0, scrollTo: false };
    this.width = width;
    this.height = height;
    this.viewLayout = computeLayout(this.metrics, width, height, this.maxDepth);
    const before = this.viewState;
    this.viewState = fitViewState(before, this.viewLayout, this.rows.count);
    return {
      dirty: WaterfallDirty.Size | WaterfallDirty.Camera | WaterfallDirty.Scroll,
      scrollTo: this.viewState.scrollTop !== before.scrollTop,
    };
  }

  private load(state: TraceState): void {
    this.viewIndex = state.data.index;
    this.maxDepth = deepest(this.viewIndex);
    this.viewLayout = computeLayout(this.metrics, this.width, this.height, this.maxDepth);
    this.rows = projectRows(this.viewIndex, state.collapsed, state.matched);
    this.viewState = initialViewState(this.viewIndex, this.viewLayout);
  }

  /**
   * Take a change of the store into account.
   *
   * @param change - What changed; the state itself is read from the store.
   * @returns What to redraw.
   */
  update(change: ChangeSet): UpdateResult {
    const state = this.store.state;
    let dirty = 0;
    let scrollTo = false;

    if (state.data.index !== this.viewIndex) {
      this.load(state);
      return {
        dirty: WaterfallDirty.Rows | WaterfallDirty.Camera | WaterfallDirty.Scroll | WaterfallDirty.Selection | WaterfallDirty.Hover,
        scrollTo: true,
      };
    }

    if (touches(change, Slice.Collapse | Slice.Filter)) {
      const previousPrimary = change.prev.selection.primary;
      const previousSpan = previousPrimary === null ? undefined : this.viewIndex.spans.get(previousPrimary);
      const before = { projection: this.rows, layout: this.viewLayout, scrollTop: this.viewState.scrollTop };
      this.rows = projectRows(this.viewIndex, state.collapsed, state.matched);
      const scrollTop = anchoredScrollTop(before, previousSpan === undefined ? -1 : previousSpan.idx, { projection: this.rows, layout: this.viewLayout });
      scrollTo = scrollTop !== before.scrollTop;
      this.viewState = fitViewState({ ...this.viewState, scrollTop }, this.viewLayout, this.rows.count);
      dirty |= WaterfallDirty.Rows | (scrollTo ? WaterfallDirty.Scroll : 0);
    }
    if (touches(change, Slice.Selection)) dirty |= WaterfallDirty.Selection;
    if (touches(change, Slice.Hover)) dirty |= WaterfallDirty.Hover;
    if (touches(change, Slice.Theme | Slice.Config)) dirty |= WaterfallDirty.Theme;
    if (touches(change, Slice.Window) && state.window !== null && change.origin !== this.origin) {
      const camera = withWindow(this.viewState.camera, state.window.t0, state.window.t1);
      if (camera.t0 !== this.viewState.camera.t0 || camera.t1 !== this.viewState.camera.t1) {
        this.viewState = { ...this.viewState, camera };
        dirty |= WaterfallDirty.Camera;
      }
    }
    return { dirty, scrollTo };
  }

  /**
   * Handle an input: move the camera or the scroll position, and pass what concerns everyone
   * (select, hover, collapse) on to the store.
   *
   * @returns The reducer's outcome; the caller cancels the event when `handled`, writes the
   *   scroll position when `scrollTo`, sets the cursor and redraws `dirty`.
   */
  input(input: WaterfallInput): InteractionResult {
    const result = reduceInteraction(this.viewState, input, this.context());
    this.viewState = result.state;
    for (const effect of result.effects) this.apply(effect);
    return result;
  }

  private apply(effect: Effect): void {
    const { table } = this.viewIndex;
    const options = { origin: this.origin };
    switch (effect.type) {
      case 'select': {
        if (effect.span < 0) {
          this.store.setSelection([], options);
          break;
        }
        const id = table.ids[effect.span];
        const key = effect.event >= 0 ? `event:${effect.event}` : undefined;
        const ids = effect.additive ? [...this.store.state.selection.ids, id] : [id];
        this.store.setSelection(ids, { ...options, primary: id, key });
        break;
      }
      case 'hover':
        if (effect.target === null) {
          this.store.setHover(null, options);
        } else {
          const key = effect.target.event >= 0 ? `event:${effect.target.event}` : undefined;
          this.store.setHover([table.ids[effect.target.span]], { ...options, key });
        }
        break;
      case 'toggle':
        this.store.toggleCollapse(table.ids[effect.span], options);
        break;
      case 'collapse': {
        const id = table.ids[effect.span];
        if (this.store.state.collapsed.has(id) !== effect.collapsed) this.store.toggleCollapse(id, options);
        break;
      }
    }
  }

  /** Select a span from outside (the API) and show it. */
  select(id: SpanId, reveal: boolean): void {
    const span = this.viewIndex.spans.get(id);
    if (span === undefined) return;
    this.store.expandAncestors(id, { origin: this.origin });
    this.store.setSelection([id], { origin: this.origin });
    if (reveal) {
      // the rows change when ancestors expand: bring the store up to date before looking for the row
      this.store.flushSync();
      this.input({ type: 'reveal', span: span.idx, align: 'center' });
    }
  }

  /** Fill `plan` for the rows in view. */
  buildPlan(plan: FramePlan, measureText: (text: string) => number, overscan = 0): void {
    buildFramePlan(plan, {
      index: this.viewIndex,
      projection: this.rows,
      collapsed: this.store.state.collapsed,
      layout: this.viewLayout,
      camera: this.viewState.camera,
      scrollTop: this.viewState.scrollTop,
      overscan,
      measureText,
    });
  }

  /** What is at a point of the view. The returned object is reused by the next call. */
  hit(x: number, y: number): HitResult {
    return hitTest(
      {
        index: this.viewIndex,
        projection: this.rows,
        collapsed: this.store.state.collapsed,
        layout: this.viewLayout,
        camera: this.viewState.camera,
        scrollTop: this.viewState.scrollTop,
      },
      x,
      y,
      this.hitResult,
    );
  }

  /** The zoom level as text: `100%`, `250%`, `12.5x`. */
  zoomReadout(): string {
    return formatZoom(zoomRatio(this.viewState.camera));
  }

  /** The commands of the view, for the toolbar and the key handler. */
  commands(): readonly ViewCommand[] {
    const run = (input: WaterfallInput) => (): void => {
      this.input(input);
    };
    const keyboard = (key: string): WaterfallInput => ({ type: 'key', key, shift: false, ctrl: false, alt: false });
    return [
      { id: 'zoom-in', label: 'Zoom in', keys: ['+', '='], run: run({ type: 'zoomBy', factor: 1 / 1.2 }) },
      { id: 'zoom-out', label: 'Zoom out', keys: ['-', '_'], run: run({ type: 'zoomBy', factor: 1.2 }) },
      { id: 'zoom-reset', label: 'Reset zoom', keys: ['0', 'Home'], run: run({ type: 'reset' }), readout: () => this.zoomReadout() },
      { id: 'pan-left', label: 'Pan left', keys: ['ArrowLeft'], run: run(keyboard('ArrowLeft')) },
      { id: 'pan-right', label: 'Pan right', keys: ['ArrowRight'], run: run(keyboard('ArrowRight')) },
      { id: 'collapse-all', label: 'Collapse all', run: () => this.store.collapseAll({ origin: this.origin }) },
      { id: 'expand-all', label: 'Expand all', run: () => this.store.expandAll({ origin: this.origin }) },
    ];
  }

  /** The state worth keeping when the view is hidden: where it looks. */
  getState(): { readonly t0: number; readonly t1: number; readonly scrollTop: number } {
    const { camera, scrollTop } = this.viewState;
    return { t0: camera.t0, t1: camera.t1, scrollTop };
  }

  /** Restore what {@link WaterfallController.getState} returned. */
  setState(saved: { readonly t0: number; readonly t1: number; readonly scrollTop: number }): UpdateResult {
    const camera = withWindow(this.viewState.camera, saved.t0, saved.t1);
    this.viewState = fitViewState({ ...this.viewState, camera, scrollTop: saved.scrollTop }, this.viewLayout, this.rows.count);
    return { dirty: WaterfallDirty.Camera | WaterfallDirty.Scroll, scrollTo: true };
  }

  /**
   * The rows in view as an accessibility tree, with a margin of a few rows.
   *
   * @param margin - Rows to include above and below the visible ones.
   */
  a11y(label: string, margin = 3): A11yTree {
    const { count, rows } = this.rows;
    const { table } = this.viewIndex;
    const rowHeight = this.viewLayout.rowHeight;
    const first = Math.max(0, Math.floor(this.viewState.scrollTop / rowHeight) - margin);
    const last = Math.min(count - 1, Math.ceil((this.viewState.scrollTop + this.viewLayout.bodyHeight) / rowHeight) + margin);
    const selected = this.store.state.selection.primary;

    const items: A11yItem[] = [];
    let activeId: SpanId | null = null;
    for (let row = first; row <= last; row++) {
      const span = rows[row];
      const id = table.ids[span];
      const chevron = chevronOf(this.viewIndex, this.rows, this.store.state.collapsed, row);
      const isSelected = this.isSelected(span);
      if (id === selected) activeId = id;
      items.push({
        id,
        label: `${table.services[table.svc[span]]}: ${table.names[table.nameId[span]]}`,
        level: table.depth[span],
        expanded: chevron === Chevron.None ? undefined : chevron === Chevron.Expanded,
        selected: isSelected,
        position: row + 1,
      });
    }
    return { role: 'tree', label, activeId, size: count, items };
  }

}

function deepest(index: SpanIndex): number {
  let depth = 0;
  const depths = index.table.depth;
  for (let row = 0; row < depths.length; row++) {
    if (depths[row] > depth) depth = depths[row];
  }
  return depth;
}
