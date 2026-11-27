/**
 * StatsController: headless controller joining the shared `TraceStore` to the
 * stats view's settings, aggregation, flat treegrid projection, scroll anchoring,
 * selection/hover synchronization, and keyboard navigation.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  Slice,
  touches,
  type ChangeSet,
  type InfoModel,
  type Origin,
  type SpanId,
  type TraceStore,
} from '../../core/index.ts';
import { spanTimings } from '../../core/self-time.ts';
import {
  clampScrollTop,
  ensureRowVisible,
  keepRowAtSameY,
  visibleRange,
  type ListMetrics,
} from '../../kit/geometry/virtual-list.ts';
import {
  buildStatsAggregation,
  describeStatsGroup,
  describeStatsSpan,
  spansOfGroup,
  type StatsAggregation,
} from './model/aggregate.ts';
import {
  DisplayRowKind,
  defaultSortDirForColumn,
  findDisplayRowForSpan,
  normalizeSortColumn,
  projectStatsRows,
  type StatsProjection,
} from './model/projection.ts';
import {
  DEFAULT_STATS_SETTINGS,
  GROUP_BY_MODES,
  SORT_COLUMNS,
  SORT_DIRECTIONS,
  STATS_ROW_H_MAX,
  STATS_ROW_H_MIN,
  type GroupByMode,
  type SortColumn,
  type SortDirection,
  type StatsSettings,
} from './settings.ts';

/** Dirty bits telling the painter what needs updating on the next frame. */
export const enum StatsDirty {
  None = 0,
  Data = 1,
  Layout = 2,
  Rows = 4,
  Selection = 8,
  Hover = 16,
  Scroll = 32,
  Theme = 64,
  All = 127,
}

/** View-local state of the stats view. */
export interface StatsViewState {
  groupBy: GroupByMode;
  sort: SortColumn;
  sortDir: SortDirection;
  matchesOnly: boolean;
  rowHeight: number;
  expandedGroups: Set<string>;
  scrollTop: number;
  scrollLeft: number;
  viewWidth: number;
  viewHeight: number;
  focusRow: number;
  hoveredRow: number;
}

/** Serializable snapshot persisted across tab switches via `getState` / `setState`. */
interface SavedStatsViewState {
  readonly groupBy: GroupByMode;
  readonly sort: SortColumn;
  readonly sortDir: SortDirection;
  readonly matchesOnly: boolean;
  readonly expandedGroups: readonly string[];
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly focusRow: number;
}

export interface StatsControllerOptions {
  readonly store: TraceStore;
  readonly origin: Origin;
  readonly settings?: Partial<StatsSettings>;
  readonly onScrollTo?: (scrollTop: number, scrollLeft?: number) => void;
  readonly onCommandsChanged?: () => void;
}

/** Height of the sticky column header row in CSS pixels. */
export const STATS_HEADER_HEIGHT = 32;

const GROUP_BY_READOUTS: Readonly<Record<GroupByMode, string>> = {
  'service-operation': 'svc · op',
  service: 'service',
  operation: 'operation',
  kind: 'kind',
  none: 'spans',
};

export class StatsController {
  readonly store: TraceStore;
  readonly origin: Origin;
  defaults: StatsSettings;
  readonly viewState: StatsViewState;
  dirty: number;

  private aggregation: StatsAggregation | null = null;
  private projection: StatsProjection | null = null;
  private aggStale = true;
  private projStale = true;
  private lastGeneration = -1;
  private readonly onScrollTo?: (scrollTop: number, scrollLeft?: number) => void;
  private readonly onCommandsChanged?: () => void;

  constructor(options: StatsControllerOptions) {
    this.store = options.store;
    this.origin = options.origin;
    this.onScrollTo = options.onScrollTo;
    this.onCommandsChanged = options.onCommandsChanged;

    this.defaults = {
      ...DEFAULT_STATS_SETTINGS,
      ...options.settings,
    };
    const initialSort = normalizeSortColumn(this.defaults.groupBy, this.defaults.sort);
    this.viewState = {
      groupBy: this.defaults.groupBy,
      sort: initialSort,
      sortDir: this.defaults.sortDir,
      matchesOnly: this.defaults.matchesOnly,
      rowHeight: this.defaults.rowHeight,
      expandedGroups: new Set(),
      scrollTop: 0,
      scrollLeft: 0,
      viewWidth: 0,
      viewHeight: 0,
      focusRow: -1,
      hoveredRow: -1,
    };
    this.dirty = StatsDirty.All;
    this.lastGeneration = this.store.state.data.generation;
  }

  /** Viewport height available to data rows below the sticky header. */
  bodyViewportHeight(): number {
    return Math.max(0, this.viewState.viewHeight - STATS_HEADER_HEIGHT);
  }

  /** Virtual list metrics for the current projection. */
  listMetrics(proj = this.ensureProjection()): ListMetrics {
    return {
      rowHeight: this.viewState.rowHeight,
      rowCount: proj.rowCount,
      viewportHeight: this.bodyViewportHeight(),
    };
  }

  /** Ensure aggregation and projection are up to date with `store.state` and `viewState`. */
  ensureProjection(): StatsProjection {
    if (this.aggStale || this.aggregation === null) {
      const state = this.store.state;
      const timings = this.store.derive(spanTimings);
      this.aggregation = buildStatsAggregation(
        state.data.index,
        timings,
        state.matched,
        this.viewState.groupBy,
        this.viewState.matchesOnly,
      );
      this.aggStale = false;
      this.projStale = true;
    }
    if (this.projStale || this.projection === null) {
      this.projection = projectStatsRows(
        this.aggregation,
        this.viewState.sort,
        this.viewState.sortDir,
        this.viewState.expandedGroups,
      );
      this.projStale = false;
      if (this.viewState.focusRow >= this.projection.rowCount) {
        this.viewState.focusRow = this.projection.rowCount - 1;
      }
      if (this.viewState.hoveredRow >= this.projection.rowCount) {
        this.viewState.hoveredRow = -1;
      }
    }
    return this.projection;
  }

  /** Readout string for the `Group by` toolbar command. */
  groupByReadout(): string {
    return GROUP_BY_READOUTS[this.viewState.groupBy];
  }

  /** Readout string for the `Matches only` toolbar command. */
  matchesOnlyReadout(): string {
    return this.viewState.matchesOnly ? 'on' : 'dim';
  }

  /** Whether all groups are currently expanded (when grouped). */
  allGroupsExpanded(): boolean {
    const proj = this.ensureProjection();
    const agg = proj.aggregation;
    if (agg.groupCount === 0) return false;
    for (let g = 0; g < agg.groupCount; g++) {
      if (!this.viewState.expandedGroups.has(agg.groupKeys[g])) return false;
    }
    return true;
  }

  /** Live summary readout for the `Reset` toolbar command. */
  summaryReadout(): string {
    const proj = this.ensureProjection();
    const agg = proj.aggregation;
    const spanCount = agg.activeSpans.length;
    const spanWord = spanCount === 1 ? 'span' : 'spans';
    if (this.viewState.groupBy === 'none') {
      return `${spanCount.toLocaleString()} ${spanWord}`;
    }
    const groupWord = agg.groupCount === 1 ? 'group' : 'groups';
    return `${agg.groupCount.toLocaleString()} ${groupWord} · ${spanCount.toLocaleString()} ${spanWord}`;
  }

  // ---------------------------------------------------------------------------
  // Store & settings updates
  // ---------------------------------------------------------------------------

  handleStoreChange(change: ChangeSet): number {
    let added: number = StatsDirty.None;
    const state = this.store.state;

    if (touches(change, Slice.Data)) {
      if (state.data.generation !== this.lastGeneration) {
        this.lastGeneration = state.data.generation;
        this.viewState.expandedGroups.clear();
        this.viewState.scrollTop = 0;
        this.viewState.focusRow = -1;
        this.viewState.hoveredRow = -1;
        this.onScrollTo?.(0, 0);
      }
      this.aggStale = true;
      this.projStale = true;
      added |= StatsDirty.Data | StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Selection;
      this.onCommandsChanged?.();
    }

    if (touches(change, Slice.Window | Slice.Filter)) {
      const anchor = this.captureAnchor();
      this.aggStale = true;
      this.projStale = true;
      this.restoreAnchor(anchor);
      added |= StatsDirty.Data | StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
      this.onCommandsChanged?.();
    }

    if (touches(change, Slice.Selection)) {
      added |= StatsDirty.Selection | StatsDirty.Rows;
      if (change.origin !== this.origin) {
        const primary = state.selection.primary;
        if (primary !== null) {
          const indexed = state.data.index.spans.get(primary);
          if (indexed !== undefined) {
            const proj = this.ensureProjection();
            const row = findDisplayRowForSpan(proj, indexed.idx);
            if (row >= 0) this.viewState.focusRow = row;
          }
        }
      }
    }

    if (touches(change, Slice.Hover) && change.origin !== this.origin) {
      added |= StatsDirty.Hover | StatsDirty.Rows;
    }

    if (touches(change, Slice.Theme)) {
      added |= StatsDirty.Theme;
    }

    this.dirty |= added;
    return added;
  }

  applySettings(next: StatsSettings): number {
    const prev = this.defaults;
    this.defaults = next;
    let added: number = StatsDirty.None;

    if (next.groupBy !== prev.groupBy) {
      this.viewState.groupBy = next.groupBy;
      this.viewState.sort = normalizeSortColumn(next.groupBy, this.viewState.sort);
      this.aggStale = true;
      this.projStale = true;
      added |= StatsDirty.Data | StatsDirty.Layout | StatsDirty.Rows;
    }
    if (next.sort !== prev.sort) {
      this.viewState.sort = normalizeSortColumn(this.viewState.groupBy, next.sort);
      this.projStale = true;
      added |= StatsDirty.Rows;
    }
    if (next.sortDir !== prev.sortDir) {
      this.viewState.sortDir = next.sortDir;
      this.projStale = true;
      added |= StatsDirty.Rows;
    }
    if (next.matchesOnly !== prev.matchesOnly) {
      this.viewState.matchesOnly = next.matchesOnly;
      this.aggStale = true;
      this.projStale = true;
      added |= StatsDirty.Data | StatsDirty.Layout | StatsDirty.Rows;
    }
    if (next.rowHeight !== prev.rowHeight) {
      this.viewState.rowHeight = next.rowHeight;
      added |= StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
    }

    if (added !== StatsDirty.None) {
      this.clampScroll();
      this.dirty |= added;
      this.onCommandsChanged?.();
    }
    return added;
  }

  // ---------------------------------------------------------------------------
  // User actions & toolbar commands
  // ---------------------------------------------------------------------------

  setViewport(width: number, height: number): number {
    if (width === this.viewState.viewWidth && height === this.viewState.viewHeight) {
      return StatsDirty.None;
    }
    this.viewState.viewWidth = width;
    this.viewState.viewHeight = height;
    this.clampScroll();
    const added = StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
    this.dirty |= added;
    return added;
  }

  setScroll(scrollTop: number, scrollLeft: number): number {
    const clampedTop = clampScrollTop(this.listMetrics(), scrollTop);
    const clampedLeft = Math.max(0, scrollLeft);
    if (clampedTop === this.viewState.scrollTop && clampedLeft === this.viewState.scrollLeft) {
      return StatsDirty.None;
    }
    this.viewState.scrollTop = clampedTop;
    this.viewState.scrollLeft = clampedLeft;
    const added = StatsDirty.Scroll | StatsDirty.Rows;
    this.dirty |= added;
    return added;
  }

  setGroupBy(mode: GroupByMode): number {
    if (mode === this.viewState.groupBy) return StatsDirty.None;
    this.viewState.groupBy = mode;
    this.viewState.sort = normalizeSortColumn(mode, this.viewState.sort);
    this.viewState.scrollTop = 0;
    this.viewState.focusRow = -1;
    this.viewState.hoveredRow = -1;
    this.aggStale = true;
    this.projStale = true;
    this.onScrollTo?.(0);
    const added = StatsDirty.Data | StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
    this.dirty |= added;
    this.onCommandsChanged?.();
    return added;
  }

  cycleGroupBy(): number {
    const idx = GROUP_BY_MODES.indexOf(this.viewState.groupBy);
    const next = GROUP_BY_MODES[(idx + 1) % GROUP_BY_MODES.length];
    return this.setGroupBy(next);
  }

  toggleSort(column: SortColumn): number {
    const normalized = normalizeSortColumn(this.viewState.groupBy, column);
    const anchor = this.captureAnchor();
    if (this.viewState.sort === normalized) {
      this.viewState.sortDir = this.viewState.sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      this.viewState.sort = normalized;
      this.viewState.sortDir = defaultSortDirForColumn(normalized);
    }
    this.projStale = true;
    this.restoreAnchor(anchor);
    const added = StatsDirty.Rows | StatsDirty.Scroll;
    this.dirty |= added;
    return added;
  }

  toggleMatchesOnly(): number {
    const anchor = this.captureAnchor();
    this.viewState.matchesOnly = !this.viewState.matchesOnly;
    this.aggStale = true;
    this.projStale = true;
    this.restoreAnchor(anchor);
    const added = StatsDirty.Data | StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
    this.dirty |= added;
    this.onCommandsChanged?.();
    return added;
  }

  toggleGroupExpanded(groupIdx: number): number {
    const proj = this.ensureProjection();
    const agg = proj.aggregation;
    if (groupIdx < 0 || groupIdx >= agg.groupCount) return StatsDirty.None;
    const key = agg.groupKeys[groupIdx];
    const anchor = this.captureAnchor(proj.rowOfGroup[groupIdx]);
    if (this.viewState.expandedGroups.has(key)) {
      this.viewState.expandedGroups.delete(key);
    } else {
      this.viewState.expandedGroups.add(key);
    }
    this.projStale = true;
    this.restoreAnchor(anchor);
    const added = StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
    this.dirty |= added;
    this.onCommandsChanged?.();
    return added;
  }

  toggleExpandAll(): number {
    const proj = this.ensureProjection();
    const agg = proj.aggregation;
    if (this.viewState.groupBy === 'none' || agg.groupCount === 0) return StatsDirty.None;
    const anchor = this.captureAnchor();
    if (this.allGroupsExpanded()) {
      this.viewState.expandedGroups.clear();
    } else {
      for (let g = 0; g < agg.groupCount; g++) {
        this.viewState.expandedGroups.add(agg.groupKeys[g]);
      }
    }
    this.projStale = true;
    this.restoreAnchor(anchor);
    const added = StatsDirty.Layout | StatsDirty.Rows | StatsDirty.Scroll;
    this.dirty |= added;
    this.onCommandsChanged?.();
    return added;
  }

  resetToDefaults(): number {
    this.viewState.groupBy = this.defaults.groupBy;
    this.viewState.sort = normalizeSortColumn(this.defaults.groupBy, this.defaults.sort);
    this.viewState.sortDir = this.defaults.sortDir;
    this.viewState.matchesOnly = this.defaults.matchesOnly;
    this.viewState.expandedGroups.clear();
    this.viewState.scrollTop = 0;
    this.viewState.scrollLeft = 0;
    this.viewState.focusRow = -1;
    this.viewState.hoveredRow = -1;
    this.aggStale = true;
    this.projStale = true;
    this.onScrollTo?.(0, 0);
    const added = StatsDirty.All;
    this.dirty |= added;
    this.onCommandsChanged?.();
    return added;
  }

  /** Select the spans represented by `displayRow` and sync with `TraceStore`. */
  selectDisplayRow(displayRow: number): number {
    const proj = this.ensureProjection();
    if (displayRow < 0 || displayRow >= proj.rowCount) return StatsDirty.None;

    this.viewState.focusRow = displayRow;
    const kind = proj.rowKind[displayRow];
    const idx = proj.rowIndex[displayRow];
    const agg = proj.aggregation;

    if (kind === DisplayRowKind.Group) {
      const { ids, primary } = spansOfGroup(agg, idx, proj.sort, proj.sortDir);
      this.store.setSelection(ids, {
        origin: this.origin,
        primary,
        key: agg.groupKeys[idx],
      });
    } else {
      const spanId = agg.index.table.ids[idx];
      this.store.setSelection([spanId], {
        origin: this.origin,
        primary: spanId,
      });
    }

    const added = StatsDirty.Selection | StatsDirty.Rows;
    this.dirty |= added;
    return added;
  }

  /** Update hovered display row and sync hover target to `TraceStore`. */
  hoverDisplayRow(displayRow: number): number {
    const proj = this.ensureProjection();
    const clamped = displayRow >= 0 && displayRow < proj.rowCount ? displayRow : -1;
    if (clamped === this.viewState.hoveredRow) return StatsDirty.None;

    this.viewState.hoveredRow = clamped;
    if (clamped < 0) {
      this.store.setHover(null, { origin: this.origin });
    } else {
      const kind = proj.rowKind[clamped];
      const idx = proj.rowIndex[clamped];
      const agg = proj.aggregation;
      if (kind === DisplayRowKind.Group) {
        const { ids, primary } = spansOfGroup(agg, idx, proj.sort, proj.sortDir);
        this.store.setHover(ids, {
          origin: this.origin,
          primary,
          key: agg.groupKeys[idx],
        });
      } else {
        const spanId = agg.index.table.ids[idx];
        this.store.setHover([spanId], {
          origin: this.origin,
          primary: spanId,
        });
      }
    }

    const added = StatsDirty.Hover | StatsDirty.Rows;
    this.dirty |= added;
    return added;
  }

  /** Build tooltip `InfoModel` for a display row. */
  describeDisplayRow(displayRow: number): InfoModel | null {
    const proj = this.ensureProjection();
    if (displayRow < 0 || displayRow >= proj.rowCount) return null;
    if (proj.rowKind[displayRow] === DisplayRowKind.Group) {
      return describeStatsGroup(proj.aggregation, proj.rowIndex[displayRow]);
    }
    return describeStatsSpan(proj.aggregation, proj.rowIndex[displayRow]);
  }

  /** Reveal a span selected elsewhere (or via `selectSpan`). */
  revealSpan(id: SpanId): number {
    const indexed = this.store.state.data.index.spans.get(id);
    if (indexed === undefined) return StatsDirty.None;
    const proj = this.ensureProjection();
    const row = findDisplayRowForSpan(proj, indexed.idx);
    if (row < 0) return StatsDirty.None;

    this.viewState.focusRow = row;
    const nextScroll = ensureRowVisible(this.listMetrics(proj), this.viewState.scrollTop, row, 'center');
    let added = StatsDirty.Selection | StatsDirty.Rows;
    if (nextScroll !== this.viewState.scrollTop) {
      this.viewState.scrollTop = nextScroll;
      this.onScrollTo?.(nextScroll);
      added |= StatsDirty.Scroll;
    }
    this.dirty |= added;
    return added;
  }

  /** Handle treegrid keyboard navigation (`Arrow*`, `Home`, `End`, `Page*`, `Escape`). */
  handleNavigationKey(key: string): { readonly handled: boolean; readonly dirty: number } {
    const proj = this.ensureProjection();
    if (key === 'Escape') {
      if (this.store.state.selection.ids.size === 0) return { handled: false, dirty: StatsDirty.None };
      this.store.setSelection([], { origin: this.origin });
      const dirty = StatsDirty.Selection | StatsDirty.Rows;
      this.dirty |= dirty;
      return { handled: true, dirty };
    }

    if (proj.rowCount === 0) return { handled: false, dirty: StatsDirty.None };

    const cur = this.viewState.focusRow;
    const pageRows = Math.max(1, Math.floor(this.bodyViewportHeight() / this.viewState.rowHeight));

    switch (key) {
      case 'ArrowDown':
        return { handled: true, dirty: this.moveFocusTo(cur < 0 ? 0 : Math.min(proj.rowCount - 1, cur + 1)) };
      case 'ArrowUp':
        return { handled: true, dirty: this.moveFocusTo(cur < 0 ? 0 : Math.max(0, cur - 1)) };
      case 'Home':
        return { handled: true, dirty: this.moveFocusTo(0) };
      case 'End':
        return { handled: true, dirty: this.moveFocusTo(proj.rowCount - 1) };
      case 'PageDown':
        return { handled: true, dirty: this.moveFocusTo(cur < 0 ? 0 : Math.min(proj.rowCount - 1, cur + pageRows)) };
      case 'PageUp':
        return { handled: true, dirty: this.moveFocusTo(cur < 0 ? 0 : Math.max(0, cur - pageRows)) };
      case 'ArrowRight': {
        if (cur < 0 || cur >= proj.rowCount) return { handled: true, dirty: this.moveFocusTo(0) };
        if (proj.rowKind[cur] === DisplayRowKind.Group) {
          const g = proj.rowIndex[cur];
          const groupKey = proj.aggregation.groupKeys[g];
          if (!this.viewState.expandedGroups.has(groupKey)) {
            return { handled: true, dirty: this.toggleGroupExpanded(g) };
          }
          if (cur + 1 < proj.rowCount && proj.parentGroup[cur + 1] === g) {
            return { handled: true, dirty: this.moveFocusTo(cur + 1) };
          }
        }
        return { handled: true, dirty: StatsDirty.None };
      }
      case 'ArrowLeft': {
        if (cur < 0 || cur >= proj.rowCount) return { handled: false, dirty: StatsDirty.None };
        if (proj.rowKind[cur] === DisplayRowKind.Group) {
          const g = proj.rowIndex[cur];
          const groupKey = proj.aggregation.groupKeys[g];
          if (this.viewState.expandedGroups.has(groupKey)) {
            return { handled: true, dirty: this.toggleGroupExpanded(g) };
          }
        } else {
          const parent = proj.parentGroup[cur];
          if (parent >= 0) {
            const parentRow = proj.rowOfGroup[parent];
            if (parentRow >= 0) return { handled: true, dirty: this.moveFocusTo(parentRow) };
          }
        }
        return { handled: true, dirty: StatsDirty.None };
      }
      default:
        return { handled: false, dirty: StatsDirty.None };
    }
  }

  // ---------------------------------------------------------------------------
  // State persistence across tab switches
  // ---------------------------------------------------------------------------

  getState(): SavedStatsViewState {
    return {
      groupBy: this.viewState.groupBy,
      sort: this.viewState.sort,
      sortDir: this.viewState.sortDir,
      matchesOnly: this.viewState.matchesOnly,
      expandedGroups: [...this.viewState.expandedGroups],
      scrollTop: this.viewState.scrollTop,
      scrollLeft: this.viewState.scrollLeft,
      focusRow: this.viewState.focusRow,
    };
  }

  setState(saved: unknown): void {
    if (typeof saved !== 'object' || saved === null) return;
    const s = saved as Partial<SavedStatsViewState>;
    if (s.groupBy !== undefined && GROUP_BY_MODES.includes(s.groupBy)) {
      this.viewState.groupBy = s.groupBy;
    }
    if (s.sort !== undefined && SORT_COLUMNS.includes(s.sort)) {
      this.viewState.sort = normalizeSortColumn(this.viewState.groupBy, s.sort);
    }
    if (s.sortDir !== undefined && SORT_DIRECTIONS.includes(s.sortDir)) {
      this.viewState.sortDir = s.sortDir;
    }
    if (typeof s.matchesOnly === 'boolean') {
      this.viewState.matchesOnly = s.matchesOnly;
    }
    if (Array.isArray(s.expandedGroups)) {
      this.viewState.expandedGroups = new Set(s.expandedGroups.filter((k): k is string => typeof k === 'string'));
    }
    if (typeof s.focusRow === 'number' && Number.isFinite(s.focusRow)) {
      this.viewState.focusRow = Math.floor(s.focusRow);
    }
    this.aggStale = true;
    this.projStale = true;
    const proj = this.ensureProjection();
    const top = typeof s.scrollTop === 'number' && Number.isFinite(s.scrollTop) ? s.scrollTop : 0;
    const left = typeof s.scrollLeft === 'number' && Number.isFinite(s.scrollLeft) ? Math.max(0, s.scrollLeft) : 0;
    this.viewState.scrollTop = clampScrollTop(this.listMetrics(proj), top);
    this.viewState.scrollLeft = left;
    this.viewState.rowHeight = Math.min(STATS_ROW_H_MAX, Math.max(STATS_ROW_H_MIN, this.viewState.rowHeight));
    this.onScrollTo?.(this.viewState.scrollTop, this.viewState.scrollLeft);
    this.dirty |= StatsDirty.All;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private moveFocusTo(displayRow: number): number {
    const proj = this.ensureProjection();
    let dirty = this.selectDisplayRow(displayRow);
    const nextScroll = ensureRowVisible(this.listMetrics(proj), this.viewState.scrollTop, displayRow, 'nearest');
    if (nextScroll !== this.viewState.scrollTop) {
      this.viewState.scrollTop = nextScroll;
      this.onScrollTo?.(nextScroll);
      dirty |= StatsDirty.Scroll;
      this.dirty |= StatsDirty.Scroll;
    }
    return dirty;
  }

  private clampScroll(): void {
    const next = clampScrollTop(this.listMetrics(), this.viewState.scrollTop);
    if (next !== this.viewState.scrollTop) {
      this.viewState.scrollTop = next;
      this.onScrollTo?.(next);
    }
  }

  private captureAnchor(explicitRow?: number): { readonly fromRow: number; readonly groupKey?: string; readonly spanId?: SpanId } | null {
    if (this.projection === null || this.projection.rowCount === 0) return null;
    const proj = this.projection;
    const range = visibleRange(this.listMetrics(proj), this.viewState.scrollTop, 0);
    let anchorRow = explicitRow ?? -1;
    if (anchorRow < 0 && this.viewState.focusRow >= range.first && this.viewState.focusRow <= range.last) {
      anchorRow = this.viewState.focusRow;
    }
    if (anchorRow < 0 && range.first <= range.last) {
      anchorRow = range.first;
    }
    if (anchorRow < 0 || anchorRow >= proj.rowCount) return null;

    if (proj.rowKind[anchorRow] === DisplayRowKind.Group) {
      return { fromRow: anchorRow, groupKey: proj.aggregation.groupKeys[proj.rowIndex[anchorRow]] };
    }
    return { fromRow: anchorRow, spanId: proj.aggregation.index.table.ids[proj.rowIndex[anchorRow]] };
  }

  private restoreAnchor(
    anchor: { readonly fromRow: number; readonly groupKey?: string; readonly spanId?: SpanId } | null,
  ): void {
    const proj = this.ensureProjection();
    const metrics = this.listMetrics(proj);
    let toRow = -1;
    if (anchor !== null) {
      if (anchor.groupKey !== undefined) {
        const idx = proj.aggregation.groupKeys.indexOf(anchor.groupKey);
        if (idx >= 0) toRow = proj.rowOfGroup[idx];
      } else if (anchor.spanId !== undefined) {
        const indexed = proj.aggregation.index.spans.get(anchor.spanId);
        if (indexed !== undefined) toRow = findDisplayRowForSpan(proj, indexed.idx);
      }
    }
    const nextScroll =
      anchor !== null
        ? keepRowAtSameY(metrics, this.viewState.scrollTop, anchor.fromRow, toRow)
        : clampScrollTop(metrics, this.viewState.scrollTop);
    if (nextScroll !== this.viewState.scrollTop) {
      this.viewState.scrollTop = nextScroll;
      this.onScrollTo?.(nextScroll);
    }
  }
}
