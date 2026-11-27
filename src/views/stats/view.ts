/**
 * Stats view: mounts the native 2D scrollable treegrid (`part="plot"`), binds
 * column-header sort, row selection, inline group expansion, hover tooltips,
 * normalized keyboard shortcuts, and toolbar commands.
 */

import type { ChangeSet, SpanId } from '../../core/index.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import { isFormField, normalizeKey } from '../../kit/input/normalize.ts';
import { Key } from '../../kit/input/types.ts';
import { getFrameScheduler, type FrameHandle, type FrameScheduler } from '../../kit/scheduler.ts';
import type { TraceView, ViewContext, ViewDefinition } from '../../kit/view.ts';
import { STATS_HEADER_HEIGHT, StatsController, StatsDirty } from './controller.ts';
import { DisplayRowKind } from './model/projection.ts';
import type { StatsDomPainter } from './paint/dom.ts';
import { mountStatsDomPainter } from './paint/dom-mount.ts';
import { SORT_COLUMNS, readStatsSettings, type SortColumn } from './settings.ts';
import * as styles from './view.css.ts';

const NAV_KEY_NAMES: Readonly<Partial<Record<Key, string>>> = {
  [Key.ArrowUp]: 'ArrowUp',
  [Key.ArrowDown]: 'ArrowDown',
  [Key.ArrowLeft]: 'ArrowLeft',
  [Key.ArrowRight]: 'ArrowRight',
  [Key.Home]: 'Home',
  [Key.End]: 'End',
  [Key.PageUp]: 'PageUp',
  [Key.PageDown]: 'PageDown',
  [Key.Escape]: 'Escape',
};

interface MountedStatsView {
  readonly ctx: ViewContext;
  readonly controller: StatsController;
  readonly scroller: HTMLElement;
  readonly painter: StatsDomPainter;
  readonly frame: FrameHandle;
  readonly cleanups: Array<() => void>;
}

function closestAttr(target: EventTarget | null, attr: string): Element | null {
  let node = target instanceof Element ? target : null;
  while (node !== null) {
    if (node.hasAttribute(attr)) return node;
    node = node.parentElement;
  }
  return null;
}

function isSortColumn(value: string): value is SortColumn {
  return (SORT_COLUMNS as readonly string[]).includes(value);
}

/** The trace statistics treegrid view. */
export class StatsView implements TraceView {
  private readonly scheduler: FrameScheduler;
  private mounted: MountedStatsView | null = null;

  constructor(scheduler: FrameScheduler = getFrameScheduler()) {
    this.scheduler = scheduler;
  }

  /** Parts of the view for tests; not a public API. */
  get internals(): {
    readonly controller: StatsController;
    readonly painter: StatsDomPainter;
    readonly scroller: HTMLElement;
  } | null {
    const m = this.mounted;
    return m === null ? null : { controller: m.controller, painter: m.painter, scroller: m.scroller };
  }

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;

    const settings = readStatsSettings(ctx.options());
    const controller = new StatsController({
      store: ctx.store,
      origin: ctx.origin,
      settings,
      onScrollTo: (top, left) => this.scrollTo(top, left),
      onCommandsChanged: () => ctx.refreshCommands(),
    });

    const scroller = h('div', {
      class: styles.scroller,
      part: 'plot',
      tabindex: 0,
      role: 'treegrid',
      'aria-label': 'Trace statistics',
    });
    surface.append(scroller);

    const painter = mountStatsDomPainter({ host: scroller });
    const frame = this.scheduler.register({
      paint: (dirty) => this.paint(dirty),
    });
    const cleanups: Array<() => void> = [];

    this.mounted = {
      ctx,
      controller,
      scroller,
      painter,
      frame,
      cleanups,
    };

    const observer = new ResizeObserver((entries) => {
      const m = this.mounted;
      if (m === null) return;
      const rect = entries[0]?.contentRect;
      const width = rect !== undefined && rect.width > 0 ? rect.width : m.scroller.clientWidth;
      const height = rect !== undefined && rect.height > 0 ? rect.height : m.scroller.clientHeight;
      this.schedulePaint(m.controller.setViewport(width, height));
    });
    observer.observe(scroller);
    cleanups.push(() => observer.disconnect());

    const onScroll = (): void => {
      const m = this.mounted;
      if (m === null) return;
      this.schedulePaint(m.controller.setScroll(m.scroller.scrollTop, m.scroller.scrollLeft));
    };
    scroller.addEventListener('scroll', onScroll);
    cleanups.push(() => scroller.removeEventListener('scroll', onScroll));

    const onClick = (event: MouseEvent): void => this.handleClick(event);
    const onDblClick = (event: MouseEvent): void => this.handleDoubleClick(event);
    const onMouseMove = (event: MouseEvent): void => this.handleMouseMove(event);
    const onMouseLeave = (): void => this.clearHover();
    const onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event);

    scroller.addEventListener('click', onClick);
    scroller.addEventListener('dblclick', onDblClick);
    scroller.addEventListener('mousemove', onMouseMove);
    scroller.addEventListener('mouseleave', onMouseLeave);
    scroller.addEventListener('keydown', onKeyDown);
    cleanups.push(
      () => scroller.removeEventListener('click', onClick),
      () => scroller.removeEventListener('dblclick', onDblClick),
      () => scroller.removeEventListener('mousemove', onMouseMove),
      () => scroller.removeEventListener('mouseleave', onMouseLeave),
      () => scroller.removeEventListener('keydown', onKeyDown),
    );

    if (scroller.clientWidth > 0 || scroller.clientHeight > 0) {
      controller.setViewport(scroller.clientWidth, scroller.clientHeight);
    }
    this.schedulePaint(controller.dirty);
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    for (const cleanup of m.cleanups) cleanup();
    m.frame.dispose();
    m.painter.destroy();
    m.scroller.remove();
    m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.ctx.hover(null);
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.handleStoreChange(change);
    if (dirty !== StatsDirty.None) this.schedulePaint(dirty);
  }

  optionsChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    const settings = readStatsSettings(m.ctx.options());
    const dirty = m.controller.applySettings(settings);
    if (dirty !== StatsDirty.None) this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  themeChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    m.controller.dirty |= StatsDirty.Theme;
    this.schedulePaint(StatsDirty.Theme);
  }

  commands(): readonly ViewCommand[] {
    const m = this.mounted;
    if (m === null) return [];
    const { controller } = m;
    return [
      {
        id: 'stats.group-by',
        label: 'Group by',
        keys: ['g', 'G'],
        readout: () => controller.groupByReadout(),
        run: () => this.schedulePaint(controller.cycleGroupBy()),
      },
      {
        id: 'stats.matches-only',
        label: 'Matches only',
        keys: ['m', 'M'],
        readout: () => controller.matchesOnlyReadout(),
        run: () => this.schedulePaint(controller.toggleMatchesOnly()),
      },
      {
        id: 'stats.expand-all',
        label: 'Expand groups',
        keys: ['e', 'E'],
        enabled: () => controller.viewState.groupBy !== 'none' && controller.ensureProjection().aggregation.groupCount > 0,
        readout: () => (controller.allGroupsExpanded() ? 'all' : 'collapsed'),
        run: () => this.schedulePaint(controller.toggleExpandAll()),
      },
      {
        id: 'stats.reset',
        label: 'Reset',
        keys: ['0'],
        readout: () => controller.summaryReadout(),
        run: () => this.schedulePaint(controller.resetToDefaults()),
      },
    ];
  }

  reveal(id: SpanId): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.revealSpan(id);
    if (dirty !== StatsDirty.None) this.schedulePaint(dirty);
  }

  focus(): void {
    this.mounted?.scroller.focus({ preventScroll: true });
  }

  getState(): unknown {
    return this.mounted?.controller.getState() ?? null;
  }

  setState(state: unknown): void {
    const m = this.mounted;
    if (m === null) return;
    m.controller.setState(state);
    this.schedulePaint(m.controller.dirty);
    m.ctx.refreshCommands();
  }

  // ---------------------------------------------------------------------------
  // Pointer, hover, keyboard & paint
  // ---------------------------------------------------------------------------

  private handleClick(event: MouseEvent): void {
    const m = this.mounted;
    if (m === null) return;

    const headerBtn = closestAttr(event.target, 'data-sort-col');
    if (headerBtn !== null) {
      const col = headerBtn.getAttribute('data-sort-col');
      if (col !== null && isSortColumn(col)) {
        this.schedulePaint(m.controller.toggleSort(col));
      }
      return;
    }

    const rowEl = closestAttr(event.target, 'data-display-row');
    if (rowEl === null) return;
    const displayRow = Number(rowEl.getAttribute('data-display-row'));
    if (!Number.isInteger(displayRow)) return;

    const chevron = closestAttr(event.target, 'data-part');
    if (chevron !== null && chevron.getAttribute('data-part') === 'chevron') {
      const groupIdx = Number(rowEl.getAttribute('data-group-idx'));
      if (Number.isInteger(groupIdx)) {
        this.schedulePaint(m.controller.toggleGroupExpanded(groupIdx));
      }
      return;
    }

    this.schedulePaint(m.controller.selectDisplayRow(displayRow));
  }

  private handleDoubleClick(event: MouseEvent): void {
    const m = this.mounted;
    if (m === null) return;
    if (closestAttr(event.target, 'data-sort-col') !== null) return;
    const rowEl = closestAttr(event.target, 'data-display-row');
    if (rowEl === null) return;
    if (rowEl.getAttribute('data-row-kind') !== 'group') return;
    const groupIdx = Number(rowEl.getAttribute('data-group-idx'));
    if (Number.isInteger(groupIdx)) {
      this.schedulePaint(m.controller.toggleGroupExpanded(groupIdx));
    }
  }

  private handleMouseMove(event: MouseEvent): void {
    const m = this.mounted;
    if (m === null) return;
    const rowEl = closestAttr(event.target, 'data-display-row');
    if (rowEl === null) {
      this.clearHover();
      return;
    }
    const displayRow = Number(rowEl.getAttribute('data-display-row'));
    if (!Number.isInteger(displayRow)) {
      this.clearHover();
      return;
    }

    const dirty = m.controller.hoverDisplayRow(displayRow);
    if (dirty !== StatsDirty.None) this.schedulePaint(dirty);

    const proj = m.controller.ensureProjection();
    if (displayRow < 0 || displayRow >= proj.rowCount) {
      m.ctx.hover(null);
      return;
    }

    const y = STATS_HEADER_HEIGHT + displayRow * m.controller.viewState.rowHeight - m.controller.viewState.scrollTop;
    const kind = proj.rowKind[displayRow];
    const idx = proj.rowIndex[displayRow];
    const generation = m.ctx.store.state.data.generation;
    const key =
      kind === DisplayRowKind.Group
        ? `${generation}:g:${proj.aggregation.groupKeys[idx]}`
        : `${generation}:s:${proj.aggregation.index.table.ids[idx]}`;

    m.ctx.hover({
      key,
      anchor: {
        x: 0,
        y,
        w: Math.max(120, m.controller.viewState.viewWidth),
        h: m.controller.viewState.rowHeight,
      },
      bounds: {
        width: m.controller.viewState.viewWidth,
        height: m.controller.viewState.viewHeight,
      },
      info: () => m.controller.describeDisplayRow(displayRow),
    });
  }

  private clearHover(): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.hoverDisplayRow(-1);
    if (dirty !== StatsDirty.None) this.schedulePaint(dirty);
    m.ctx.hover(null);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const m = this.mounted;
    if (m === null || event.defaultPrevented) return;
    const originNode = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
    if (isFormField(originNode)) return;

    const normalized = normalizeKey(event);
    if (normalized === null) return;

    switch (normalized.key) {
      case Key.G:
        event.preventDefault();
        this.schedulePaint(m.controller.cycleGroupBy());
        return;
      case Key.M:
        event.preventDefault();
        this.schedulePaint(m.controller.toggleMatchesOnly());
        return;
      case Key.E:
        if (m.controller.viewState.groupBy !== 'none') {
          event.preventDefault();
          this.schedulePaint(m.controller.toggleExpandAll());
        }
        return;
      case Key.Zero:
        event.preventDefault();
        this.schedulePaint(m.controller.resetToDefaults());
        return;
      default:
        break;
    }

    const navKey = NAV_KEY_NAMES[normalized.key];
    if (navKey === undefined) return;
    const result = m.controller.handleNavigationKey(navKey);
    if (result.handled) {
      event.preventDefault();
      if (result.dirty !== StatsDirty.None) this.schedulePaint(result.dirty);
    }
  }

  private scrollTo(top: number, left?: number): void {
    const m = this.mounted;
    if (m === null) return;
    if (m.scroller.scrollTop !== top) m.scroller.scrollTop = top;
    if (left !== undefined && m.scroller.scrollLeft !== left) m.scroller.scrollLeft = left;
  }

  private schedulePaint(dirty: number): void {
    const m = this.mounted;
    if (m === null || dirty === StatsDirty.None) return;
    m.frame.mark(dirty);
  }

  private paint(dirty: number): void {
    const m = this.mounted;
    if (m === null) return;
    const combined = dirty | m.controller.dirty;
    if (combined === StatsDirty.None) return;
    m.controller.dirty = StatsDirty.None;

    const proj = m.controller.ensureProjection();
    const state = m.ctx.store.state;
    m.painter.paint({
      projection: proj,
      rowHeight: m.controller.viewState.rowHeight,
      scrollTop: m.controller.viewState.scrollTop,
      viewportHeight: m.controller.bodyViewportHeight(),
      expandedGroups: m.controller.viewState.expandedGroups,
      selectedIds: state.selection.ids,
      hoveredRow: m.controller.viewState.hoveredRow,
      matched: state.matched,
      matchesOnly: m.controller.viewState.matchesOnly,
    });

    const focusRow = m.controller.viewState.focusRow;
    const activeId = focusRow >= 0 && focusRow < proj.rowCount ? `l2t-stats-row-${focusRow}` : '';
    m.scroller.setAttribute('aria-activedescendant', activeId);
  }
}

/** The trace statistics view, as the element lists it. */
export const statsDefinition: ViewDefinition = {
  id: 'stats',
  label: 'Stats',
  capabilities: { legend: true },
  create: () => new StatsView(),
};
