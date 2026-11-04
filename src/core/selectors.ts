/**
 * Selectors: values derived from the store state and cached until a slice they
 * depend on changes.
 *
 * `defineSelector` makes a selector once, at module level; any number of
 * stores can `derive` it, each with its own cache. A view that is not shown
 * never derives anything, so it costs nothing. The core ships the selectors
 * every view wants; each view defines its own on top (rows for the waterfall,
 * self-time totals for a flame graph, nodes and edges for a service graph).
 *
 * Headless: no DOM, no browser globals.
 */

import type { IndexedSpan } from './span-index.ts';
import { Slice, type TraceState } from './state.ts';

/** A cached derivation of the store state. Create it with {@link defineSelector}. */
export interface Selector<T> {
  /** Name for debugging. */
  readonly id: string;
  /** OR of the {@link Slice} bits the result depends on; changes to other slices never recompute it. */
  readonly deps: number;
  /**
   * Compute the value from the state. `previous` is the last result, so an
   * incremental selector can update it, or return it unchanged to keep its identity.
   */
  readonly compute: (state: TraceState, previous: T | undefined) => T;
}

/**
 * Define a selector.
 *
 * @param id - Name for debugging.
 * @param deps - OR of the {@link Slice} bits `compute` reads. Reading a slice that is not listed gives stale results.
 * @param compute - Pure function of the state.
 */
export function defineSelector<T>(
  id: string,
  deps: number,
  compute: (state: TraceState, previous: T | undefined) => T,
): Selector<T> {
  return Object.freeze({ id, deps, compute });
}

/** How many spans there are and how many passed the filter. */
export interface MatchSummary {
  readonly total: number;
  /** Spans that passed the filter; equals `total` when no filter is active. */
  readonly matched: number;
  /** Whether a filter is active. */
  readonly filtered: boolean;
}

/** Span counts for a "showing 12 of 340 spans" line. */
export const matchSummary: Selector<MatchSummary> = defineSelector(
  'core.matchSummary',
  Slice.Data | Slice.Filter,
  (state, previous) => {
    const total = state.data.index.size;
    const filtered = state.matched !== null;
    const matched = state.matched === null ? total : state.matched.size;
    if (previous && previous.total === total && previous.matched === matched && previous.filtered === filtered) {
      return previous;
    }
    return { total, matched, filtered };
  },
);

/** The span the detail panel describes: the primary span of the selection, or `null`. */
export const selectedSpan: Selector<IndexedSpan | null> = defineSelector(
  'core.selectedSpan',
  Slice.Data | Slice.Selection,
  state => primarySpan(state, state.selection.primary),
);

/** The span under the pointer, or `null`. */
export const hoveredSpan: Selector<IndexedSpan | null> = defineSelector(
  'core.hoveredSpan',
  Slice.Data | Slice.Hover,
  state => primarySpan(state, state.hover?.primary ?? null),
);

function primarySpan(state: TraceState, id: string | null): IndexedSpan | null {
  return id === null ? null : state.data.index.spans.get(id) ?? null;
}
