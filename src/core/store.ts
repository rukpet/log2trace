/**
 * TraceStore: the state every view of one trace shares (data, selection,
 * hover, collapsed spans, filter result, time window), with batched change
 * notifications and cached selectors.
 *
 * State changes take effect at once: `store.state` is current right after a
 * setter returns. Notifications are delivered later, once per tick, with all
 * changes of that tick merged into one {@link ChangeSet}; views therefore mark
 * themselves dirty in `update` and paint on their own schedule. Setters that
 * would not change anything return without notifying.
 *
 * Headless: no DOM, no browser globals.
 */

import { buildSpanIndex, type SpanIndex } from './span-index.ts';
import { EMPTY_SPAN_SET, SpanMask, type SpanId, type SpanSet } from './span-set.ts';
import type { Selector } from './selectors.ts';
import {
  API_ORIGIN,
  MIXED_ORIGIN,
  Slice,
  type ChangeSet,
  type DataPhase,
  type Origin,
  type Target,
  type TimeWindow,
  type TraceState,
} from './state.ts';

/** Arranges for `flush` to be called later, once. */
export type FlushScheduler = (flush: () => void) => void;

/** Options for {@link createTraceStore}. */
export interface TraceStoreOptions {
  /**
   * How notifications are deferred. Defaults to a microtask; the element passes
   * its frame scheduler, and tests pass one they trigger by hand.
   */
  readonly schedule?: FlushScheduler;
}

/** Options shared by the setters. */
export interface MutationOptions {
  /** Who is making the change; defaults to `'api'`. Subscribers see it in {@link ChangeSet.origin}. */
  readonly origin?: Origin;
}

/** Options of the setters that take a set of spans. */
export interface TargetOptions extends MutationOptions {
  /** The span to describe; defaults to the first id. Ignored when it is not among the ids. */
  readonly primary?: SpanId;
  /** View-local id of the element that produced the target. */
  readonly key?: string;
}

/** The store. Create one per trace with {@link createTraceStore}. */
export interface TraceStore {
  /** The current state; a different object after every change. */
  readonly state: TraceState;

  /**
   * Replace the data. Spans keep their selection and collapsed state when they
   * still exist; hover, filter result and time window are reset. Setting the
   * index that is already loaded only updates the phase.
   */
  setData(index: SpanIndex): void;
  /** Report loading or failure. The index stays as it was. */
  setPhase(phase: DataPhase, error?: string): void;

  /** Select spans. Ids that are not in the trace are dropped; an empty list clears the selection. */
  setSelection(ids: Iterable<SpanId>, options?: TargetOptions): void;
  /** Hover spans, or `null` for nothing. */
  setHover(ids: Iterable<SpanId> | null, options?: TargetOptions): void;

  /** Collapse an expanded span or expand a collapsed one. Spans without children are ignored. */
  toggleCollapse(id: SpanId, options?: MutationOptions): void;
  /** Make exactly these spans the collapsed ones. Spans without children are ignored. */
  setCollapsed(ids: Iterable<SpanId>, options?: MutationOptions): void;
  /** Collapse every span that has children. */
  collapseAll(options?: MutationOptions): void;
  /** Expand every span. */
  expandAll(options?: MutationOptions): void;
  /** Expand the collapsed ancestors of a span so that it becomes visible. */
  expandAncestors(id: SpanId, options?: MutationOptions): void;

  /** Set the spans that passed the filter, or `null` for no filter. */
  setMatched(ids: SpanSet | null, options?: MutationOptions): void;
  /** Set the shared time window, or `null` for the whole trace. A window that is empty or not finite is ignored. */
  setWindow(window: TimeWindow | null, options?: MutationOptions): void;

  /**
   * Report a change to something the store does not hold ({@link Slice.Config},
   * {@link Slice.Theme}) so that subscribers and selectors see it.
   */
  touch(slices: number, options?: MutationOptions): void;

  /** The value of a selector for the current state, computed again only when a slice it depends on changed. */
  derive<T>(selector: Selector<T>): T;

  /**
   * Be called when any of the given slices change.
   *
   * @param listener - Receives the merged changes of one tick. An exception it throws does not stop the other listeners; the first one is rethrown afterwards.
   * @param slices - OR of the {@link Slice} bits of interest; defaults to all.
   * @returns A function that unsubscribes.
   */
  subscribe(listener: (change: ChangeSet) => void, slices?: number): () => void;

  /** Deliver pending notifications now instead of waiting for the scheduler. */
  flushSync(): void;
}

interface Subscriber {
  readonly listener: (change: ChangeSet) => void;
  readonly slices: number;
}

interface PendingChange {
  mask: number;
  origin: Origin;
  readonly prev: TraceState;
}

const SLICE_BITS = 8;

const NO_SELECTION: Target = Object.freeze({ ids: EMPTY_SPAN_SET, primary: null, origin: API_ORIGIN });

function scheduleMicrotask(flush: () => void): void {
  void Promise.resolve().then(flush);
}

/** Whether the span in `row` has children. */
function hasChildren(index: SpanIndex, row: number): boolean {
  return index.table.subtreeEnd[row] > row + 1;
}

/** Create a store holding no data. */
export function createTraceStore(options: TraceStoreOptions = {}): TraceStore {
  const schedule = options.schedule ?? scheduleMicrotask;
  const subscribers: Subscriber[] = [];
  const memo = new WeakMap<object, { stamp: number; value: unknown }>();
  const stamps = new Array<number>(SLICE_BITS).fill(0);
  let clock = 0;
  let pending: PendingChange | null = null;
  let scheduled = false;

  const emptyIndex = buildSpanIndex({ resourceSpans: [] });
  let state: TraceState = {
    data: { index: emptyIndex, phase: 'empty', generation: 0 },
    selection: NO_SELECTION,
    hover: null,
    collapsed: SpanMask.empty(emptyIndex),
    matched: null,
    window: null,
  };

  function commit(next: TraceState, slices: number, origin: Origin): void {
    if (pending === null) {
      pending = { mask: 0, origin, prev: state };
    } else if (pending.origin !== origin) {
      pending.origin = MIXED_ORIGIN;
    }
    pending.mask |= slices;

    clock++;
    for (let bit = 0; bit < SLICE_BITS; bit++) {
      if (slices & (1 << bit)) stamps[bit] = clock;
    }

    state = next;
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  }

  function flush(): void {
    scheduled = false;
    const change = pending;
    if (change === null) return;
    pending = null;

    let failure: { error: unknown } | null = null;
    for (const subscriber of subscribers.slice()) {
      if ((subscriber.slices & change.mask) === 0 || !subscribers.includes(subscriber)) continue;
      try {
        subscriber.listener(change);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== null) throw failure.error;
  }

  function originOf(options: MutationOptions | undefined): Origin {
    return options?.origin ?? API_ORIGIN;
  }

  /** The spans among `ids` that exist in the current index, without duplicates, as a target. */
  function makeTarget(ids: Iterable<SpanId>, options: TargetOptions | undefined): Target {
    const known = state.data.index.spans;
    const accepted = new Set<SpanId>();
    for (const id of ids) {
      if (known.has(id)) accepted.add(id);
    }
    const origin = originOf(options);
    const key = options?.key;
    if (accepted.size === 0) return { ids: EMPTY_SPAN_SET, primary: null, origin, key };

    const wanted = options?.primary;
    const primary = wanted !== undefined && accepted.has(wanted) ? wanted : (accepted.values().next().value ?? null);
    return { ids: accepted, primary, origin, key };
  }

  function sameTarget(a: Target | null, b: Target | null): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a.primary !== b.primary || a.key !== b.key || a.ids.size !== b.ids.size) return false;
    for (const id of a.ids) {
      if (!b.ids.has(id)) return false;
    }
    return true;
  }

  /** The part of a target that still exists in `index`. */
  function retarget(target: Target, index: SpanIndex): Target {
    if (target.ids.size === 0) return target;
    const kept: SpanId[] = [];
    for (const id of target.ids) {
      if (index.spans.has(id)) kept.push(id);
    }
    if (kept.length === target.ids.size) return target;
    if (kept.length === 0) return { ids: EMPTY_SPAN_SET, primary: null, origin: target.origin };

    const ids = new Set(kept);
    const primary = target.primary !== null && ids.has(target.primary) ? target.primary : kept[0];
    return { ids, primary, origin: target.origin, key: target.key };
  }

  function replaceCollapsed(next: SpanMask, origin: Origin): void {
    if (state.collapsed.equals(next)) return;
    commit({ ...state, collapsed: next }, Slice.Collapse, origin);
  }

  function toMask(ids: SpanSet): SpanMask {
    const index = state.data.index;
    return ids instanceof SpanMask && ids.index === index ? ids : SpanMask.of(index, ids);
  }

  function setPhase(phase: DataPhase, error?: string): void {
    const data = state.data;
    if (data.phase === phase && data.error === error) return;
    commit({ ...state, data: { ...data, phase, error } }, Slice.Data, API_ORIGIN);
  }

  return {
    get state() {
      return state;
    },

    setData(index) {
      const previous = state;
      const phase: DataPhase = index.size === 0 ? 'empty' : 'ready';
      if (index === previous.data.index) {
        setPhase(phase);
        return;
      }

      const selection = retarget(previous.selection, index);
      const carried = new Uint8Array(index.size);
      let carriedCount = 0;
      for (const id of previous.collapsed) {
        const indexed = index.spans.get(id);
        if (indexed && hasChildren(index, indexed.idx) && carried[indexed.idx] === 0) {
          carried[indexed.idx] = 1;
          carriedCount++;
        }
      }
      const collapsed = new SpanMask(index, carried, carriedCount);

      let slices: number = Slice.Data;
      if (!sameTarget(previous.selection, selection)) slices |= Slice.Selection;
      if (previous.hover !== null) slices |= Slice.Hover;
      if (previous.collapsed.size > 0 || collapsed.size > 0) slices |= Slice.Collapse;
      if (previous.matched !== null) slices |= Slice.Filter;
      if (previous.window !== null) slices |= Slice.Window;

      commit(
        {
          data: { index, phase, generation: previous.data.generation + 1 },
          selection,
          hover: null,
          collapsed,
          matched: null,
          window: null,
        },
        slices,
        API_ORIGIN,
      );
    },

    setPhase,

    setSelection(ids, options) {
      const selection = makeTarget(ids, options);
      if (sameTarget(state.selection, selection)) return;
      commit({ ...state, selection }, Slice.Selection, selection.origin);
    },

    setHover(ids, options) {
      const hover = ids === null ? null : makeTarget(ids, options);
      const next = hover !== null && hover.primary === null ? null : hover;
      if (sameTarget(state.hover, next)) return;
      commit({ ...state, hover: next }, Slice.Hover, originOf(options));
    },

    toggleCollapse(id, options) {
      const indexed = state.data.index.spans.get(id);
      if (!indexed || !hasChildren(state.data.index, indexed.idx)) return;
      replaceCollapsed(
        state.collapsed.withRow(indexed.idx, !state.collapsed.hasRow(indexed.idx)),
        originOf(options),
      );
    },

    setCollapsed(ids, options) {
      const index = state.data.index;
      const bits = new Uint8Array(index.size);
      let count = 0;
      for (const id of ids) {
        const indexed = index.spans.get(id);
        if (indexed && hasChildren(index, indexed.idx) && bits[indexed.idx] === 0) {
          bits[indexed.idx] = 1;
          count++;
        }
      }
      replaceCollapsed(new SpanMask(index, bits, count), originOf(options));
    },

    collapseAll(options) {
      const index = state.data.index;
      const bits = new Uint8Array(index.size);
      let count = 0;
      for (let row = 0; row < index.size; row++) {
        if (hasChildren(index, row)) {
          bits[row] = 1;
          count++;
        }
      }
      replaceCollapsed(new SpanMask(index, bits, count), originOf(options));
    },

    expandAll(options) {
      replaceCollapsed(SpanMask.empty(state.data.index), originOf(options));
    },

    expandAncestors(id, options) {
      const indexed = state.data.index.spans.get(id);
      if (!indexed) return;
      const { parent } = state.data.index.table;
      let bits: Uint8Array | null = null;
      let removed = 0;
      for (let row = parent[indexed.idx]; row >= 0; row = parent[row]) {
        if ((bits ?? state.collapsed.bits)[row] === 1) {
          bits ??= state.collapsed.bits.slice();
          bits[row] = 0;
          removed++;
        }
      }
      if (bits === null) return;
      replaceCollapsed(new SpanMask(state.data.index, bits, state.collapsed.size - removed), originOf(options));
    },

    setMatched(ids, options) {
      if (ids === null) {
        if (state.matched === null) return;
        commit({ ...state, matched: null }, Slice.Filter, originOf(options));
        return;
      }
      const matched = toMask(ids);
      if (state.matched !== null && state.matched.equals(matched)) return;
      commit({ ...state, matched }, Slice.Filter, originOf(options));
    },

    setWindow(window, options) {
      if (window !== null && !(Number.isFinite(window.t0) && Number.isFinite(window.t1) && window.t1 > window.t0)) return;
      const current = state.window;
      if (current === window) return;
      if (current !== null && window !== null && current.t0 === window.t0 && current.t1 === window.t1) return;
      commit({ ...state, window }, Slice.Window, originOf(options));
    },

    touch(slices, options) {
      const bits = slices & Slice.All;
      if (bits === 0) return;
      commit(state, bits, originOf(options));
    },

    derive<T>(selector: Selector<T>): T {
      let stamp = 0;
      for (let bit = 0; bit < SLICE_BITS; bit++) {
        if ((selector.deps & (1 << bit)) !== 0 && stamps[bit] > stamp) stamp = stamps[bit];
      }
      const cached = memo.get(selector);
      if (cached !== undefined && cached.stamp === stamp) return cached.value as T;

      const value = selector.compute(state, cached?.value as T | undefined);
      memo.set(selector, { stamp, value });
      return value;
    },

    subscribe(listener, slices = Slice.All) {
      const subscriber: Subscriber = { listener, slices };
      subscribers.push(subscriber);
      return () => {
        const at = subscribers.indexOf(subscriber);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },

    flushSync() {
      flush();
    },
  };
}
