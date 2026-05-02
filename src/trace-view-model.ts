/**
 * Data flow step 3b: TraceViewModel
 *
 * Reactive view layer over a SpanIndex. Manages UI state (collapsed nodes,
 * active filters) and produces a flat list of visible spans for rendering.
 *
 * The view-model is mutable — collapsing/expanding or applying filters
 * invalidates the cached visible list, which is lazily recomputed on next
 * access to `visibleSpans`.
 */

import type { SpanIndex, IndexedSpan } from './span-index.ts';

/**
 * A single span ready for rendering in the waterfall.
 *
 * Contains all information the template needs without further lookups:
 * the indexed span data, tree depth, and collapse state.
 */
export interface ViewSpan {
  /** The pre-indexed span with precomputed ms timestamps. */
  readonly indexed: IndexedSpan;
  /** Depth in the parent-child tree (root = 0). */
  readonly level: number;
  /** Whether this span has children in the index. */
  readonly hasChildren: boolean;
  /** Whether this span is currently collapsed (children hidden). */
  readonly collapsed: boolean;
}

/**
 * Reactive view model for trace visualization.
 *
 * Wraps an immutable {@link SpanIndex} and overlays mutable UI state
 * (collapsed spans, filter set). Produces a `visibleSpans` list that
 * accounts for both collapsed subtrees and active filters.
 */
export class TraceViewModel {
  private _index: SpanIndex;
  private _collapsedIds = new Set<string>();
  private _filteredIds: Set<string> | null = null;
  private _visibleSpans: ViewSpan[] | null = null;

  constructor(index: SpanIndex) {
    this._index = index;
  }

  /** The underlying immutable span index. */
  get index(): SpanIndex {
    return this._index;
  }

  /** Pre-computed time range from the index (O(1)). */
  get timeRange(): Readonly<{ min: number; max: number }> {
    return this._index.timeRange;
  }

  /** Trace ID for display (from first root). */
  get traceId(): string {
    return this._index.traceId;
  }

  /** Total spans in the index (before filtering). */
  get totalSpans(): number {
    return this._index.size;
  }

  /** Whether any data has been loaded. */
  get isEmpty(): boolean {
    return this._index.size === 0;
  }

  /** Set of currently collapsed span IDs (read-only view). */
  get collapsedIds(): ReadonlySet<string> {
    return this._collapsedIds;
  }

  /**
   * The flat list of visible spans for rendering.
   *
   * Lazily computed on first access after invalidation. Walks the tree
   * depth-first, skipping children of collapsed spans and spans not in
   * the filter set (when active).
   */
  get visibleSpans(): ViewSpan[] {
    if (!this._visibleSpans) {
      this._visibleSpans = this.computeVisibleSpans();
    }
    return this._visibleSpans;
  }

  /**
   * Toggle collapse state of a span.
   * When collapsed, all descendants are hidden from the visible list.
   */
  toggleCollapse(spanId: string): void {
    if (this._collapsedIds.has(spanId)) {
      this._collapsedIds.delete(spanId);
    } else {
      this._collapsedIds.add(spanId);
    }
    this.invalidate();
  }

  /**
   * Set a span as collapsed.
   */
  collapse(spanId: string): void {
    this._collapsedIds.add(spanId);
    this.invalidate();
  }

  /**
   * Expand a collapsed span.
   */
  expand(spanId: string): void {
    this._collapsedIds.delete(spanId);
    this.invalidate();
  }

  /**
   * Collapse all spans that have children.
   */
  collapseAll(): void {
    for (const [parentId] of this._index.childrenOf) {
      this._collapsedIds.add(parentId);
    }
    this.invalidate();
  }

  /**
   * Expand all spans.
   */
  expandAll(): void {
    this._collapsedIds.clear();
    this.invalidate();
  }

  /**
   * Apply a filter: only spans whose IDs are in `ids` will be visible.
   * Pass `null` to clear the filter (show all).
   */
  applyFilter(ids: Set<string> | null): void {
    this._filteredIds = ids;
    this.invalidate();
  }

  /**
   * Clear all view state (collapse + filter). Resets to showing everything.
   */
  resetView(): void {
    this._collapsedIds.clear();
    this._filteredIds = null;
    this.invalidate();
  }

  /**
   * Replace the underlying index (e.g. after external fetch).
   * Preserves collapse state for span IDs that still exist.
   */
  replaceIndex(index: SpanIndex): void {
    this._index = index;
    // Prune collapsed IDs that no longer exist
    for (const id of this._collapsedIds) {
      if (!index.spans.has(id)) {
        this._collapsedIds.delete(id);
      }
    }
    this._filteredIds = null;
    this.invalidate();
  }

  /**
   * Compute which spans are visible in a scroll viewport.
   *
   * Returns the slice of `visibleSpans` that falls within the given scroll
   * window, plus the absolute start/end indices. Includes an overscan of
   * extra rows above/below the viewport for smoother scrolling.
   *
   * @param scrollTop - Current vertical scroll offset in pixels.
   * @param viewportHeight - Visible viewport height in pixels.
   * @param rowHeight - Height of one span row (spanHeight + spanPadding).
   * @param overscan - Number of extra rows to render outside viewport (default 5).
   */
  getWindow(
    scrollTop: number,
    viewportHeight: number,
    rowHeight: number,
    overscan: number = 5,
  ): { startIndex: number; endIndex: number; spans: ViewSpan[] } {
    const visible = this.visibleSpans;
    const total = visible.length;
    if (total === 0) return { startIndex: 0, endIndex: 0, spans: [] };

    const rawStart = Math.floor(scrollTop / rowHeight);
    const rawEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight);

    const startIndex = Math.max(0, rawStart - overscan);
    const endIndex = Math.min(total, rawEnd + overscan);

    return { startIndex, endIndex, spans: visible.slice(startIndex, endIndex) };
  }

  private invalidate(): void {
    this._visibleSpans = null;
  }

  private computeVisibleSpans(): ViewSpan[] {
    const { spans, roots, childrenOf } = this._index;
    const result: ViewSpan[] = [];

    const walk = (spanIds: readonly string[], level: number) => {
      for (const id of spanIds) {
        const indexed = spans.get(id);
        if (!indexed) continue;

        // If filter is active, skip spans not in the set
        if (this._filteredIds && !this._filteredIds.has(id)) {
          // Still walk children in case a descendant matches
          const children = childrenOf.get(id);
          if (children) walk(children, level + 1);
          continue;
        }

        const children = childrenOf.get(id);
        const hasChildren = !!children && children.length > 0;
        const collapsed = this._collapsedIds.has(id);

        result.push({ indexed, level, hasChildren, collapsed });

        // Walk children unless collapsed
        if (hasChildren && !collapsed && children) {
          walk(children, level + 1);
        }
      }
    };

    walk(roots, 0);
    return result;
  }
}
