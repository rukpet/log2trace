/**
 * The vocabulary of the trace store: what the shared state looks like and how
 * changes to it are described.
 *
 * Only state that every view must agree on lives here: which data is loaded,
 * what is selected or hovered, what is collapsed, which spans passed the
 * filter, and the shared time window. A view's own camera (scroll, zoom, pan)
 * stays inside the view.
 *
 * Headless: no DOM, no browser globals.
 */

import type { SpanIndex } from './span-index.ts';
import type { SpanId, SpanMask, SpanSet } from './span-set.ts';

/**
 * Who caused a change: `'api'` for calls made from outside, `'shell'` for the
 * element's own chrome, or the id of a view instance. A view ignores changes
 * that carry its own origin, because it has already reflected them itself.
 */
export type Origin = string;

/** Origin of changes made through the public API. */
export const API_ORIGIN: Origin = 'api';

/** Origin of a batch of changes that came from more than one origin. */
export const MIXED_ORIGIN: Origin = '*';

/**
 * The independent parts of the state. A change is described by an OR of
 * these bits, and subscribers and selectors name the parts they depend on.
 * `Config` and `Theme` carry no state of their own: the element reports them
 * with `store.touch` so that views repaint.
 */
export enum Slice {
  Data = 1,
  Selection = 2,
  Hover = 4,
  Collapse = 8,
  Filter = 16,
  Window = 32,
  Config = 64,
  Theme = 128,
  All = 255,
}

/**
 * A selection or a hover: a set of spans that belong together.
 *
 * A waterfall row is one span; a flame-graph box, a service-graph node or edge
 * or a sequence arrow is a set of spans. `primary` is the span the detail
 * panel shows, `key` identifies the element inside the view that produced it.
 */
export interface Target {
  /** The spans; every one of them is in the current index. */
  readonly ids: SpanSet;
  /** The span to describe, one of `ids`; `null` when `ids` is empty. */
  readonly primary: SpanId | null;
  /** Who set it. */
  readonly origin: Origin;
  /** View-local id of the element, for views whose elements are not single spans. */
  readonly key?: string;
}

/** Where the data stands. */
export type DataPhase = 'empty' | 'loading' | 'ready' | 'error';

/**
 * A stretch of the trace's time axis, in milliseconds after the start of the
 * trace (`SpanTable.originNs`), the same unit and orientation as `Camera1D`.
 */
export interface TimeWindow {
  readonly t0: number;
  readonly t1: number;
}

/**
 * Everything the views share. Each field is replaced, never mutated, so a
 * change shows up as a different object and `prev` states stay valid.
 */
export interface TraceState {
  readonly data: {
    /** The loaded spans; an empty index before any data arrives. */
    readonly index: SpanIndex;
    readonly phase: DataPhase;
    /** Message to show when `phase` is `'error'`. */
    readonly error?: string;
    /** Counts how many different indexes were loaded; 0 before the first. */
    readonly generation: number;
  };
  readonly selection: Target;
  /** What the pointer is over; `null` for nothing. */
  readonly hover: Target | null;
  /**
   * Spans whose children are hidden. Advisory: the waterfall and the sequence
   * view honour it, a flame graph keeps its own focus, a service graph ignores it.
   */
  readonly collapsed: SpanMask;
  /** Spans that passed the filter; `null` when no filter is active. */
  readonly matched: SpanMask | null;
  /** Time window shared by views with a time axis; `null` for the whole trace. */
  readonly window: TimeWindow | null;
}

/**
 * One notification: what changed since the last one. Changes made in the same
 * tick arrive together, with `prev` the state before the first of them.
 */
export interface ChangeSet {
  /** OR of the {@link Slice} bits that changed. */
  readonly mask: number;
  /** The origin shared by all changes in the batch, or {@link MIXED_ORIGIN}. */
  readonly origin: Origin;
  /** The state before the batch. */
  readonly prev: TraceState;
}

/** Whether a change touches any of the given {@link Slice} bits. */
export function touches(change: ChangeSet, slices: number): boolean {
  return (change.mask & slices) !== 0;
}
