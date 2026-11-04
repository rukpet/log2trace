/**
 * Sets of spans, by span id.
 *
 * Selection, hover and filter results are all "some spans of this trace". The
 * store and the views talk about them through {@link SpanSet}, which only
 * promises `size`, `has` and iteration; {@link SpanMask} is the fast form,
 * one byte per row of the index's {@link SpanTable}, for sets that can hold
 * every span (collapsed, matched).
 *
 * Headless: no DOM, no browser globals.
 */

import type { SpanIndex } from './span-index.ts';

/** Id of a span, as in `Span.spanId`. */
export type SpanId = string;

/** A read-only set of span ids. A `ReadonlySet<string>` satisfies it. */
export interface SpanSet {
  readonly size: number;
  has(id: SpanId): boolean;
  [Symbol.iterator](): Iterator<SpanId>;
}

/** The empty set. */
export const EMPTY_SPAN_SET: SpanSet = Object.freeze({
  size: 0,
  has: () => false,
  *[Symbol.iterator](): Iterator<SpanId> {},
});

/**
 * A set of arbitrary span ids, for small sets such as a selection. Duplicates
 * collapse; the ids are not checked against any trace.
 */
export function spanSetOf(ids: Iterable<SpanId>): SpanSet {
  const set = new Set<SpanId>(ids);
  return set.size === 0 ? EMPTY_SPAN_SET : set;
}

/**
 * A set of spans of one {@link SpanIndex}, stored as a byte per table row
 * (1 = member). Membership by row is a single array read, which is what a
 * painter or the row projection needs; membership by id costs one map lookup.
 *
 * Instances never change: the `with…` methods return a new mask.
 */
export class SpanMask implements SpanSet {
  /** The index whose rows the bits refer to. */
  readonly index: SpanIndex;
  /** One byte per row, 1 for members. Owned by the mask: do not write to it. */
  readonly bits: Uint8Array;
  /** Number of members. */
  readonly size: number;

  /**
   * @param index - The index the rows belong to.
   * @param bits - One byte per row of `index.table`; the mask takes ownership.
   * @param size - Number of 1s in `bits`, when the caller already counted them.
   */
  constructor(index: SpanIndex, bits: Uint8Array, size?: number) {
    this.index = index;
    this.bits = bits;
    this.size = size ?? countMembers(bits);
  }

  /** A mask with no members. */
  static empty(index: SpanIndex): SpanMask {
    return new SpanMask(index, new Uint8Array(index.size), 0);
  }

  /** A mask of the given ids; ids that are not in the index are ignored. */
  static of(index: SpanIndex, ids: Iterable<SpanId>): SpanMask {
    const bits = new Uint8Array(index.size);
    for (const id of ids) {
      const indexed = index.spans.get(id);
      if (indexed) bits[indexed.idx] = 1;
    }
    return new SpanMask(index, bits);
  }

  /** Whether the span in table row `row` is a member. */
  hasRow(row: number): boolean {
    return this.bits[row] === 1;
  }

  has(id: SpanId): boolean {
    const indexed = this.index.spans.get(id);
    return indexed !== undefined && this.bits[indexed.idx] === 1;
  }

  /** The same mask with row `row` added or removed. Returns `this` when nothing changes. */
  withRow(row: number, member: boolean): SpanMask {
    if (this.hasRow(row) === member) return this;
    const bits = this.bits.slice();
    bits[row] = member ? 1 : 0;
    return new SpanMask(this.index, bits, this.size + (member ? 1 : -1));
  }

  /** Whether both masks are over the same index and have the same members. */
  equals(other: SpanMask): boolean {
    if (this === other) return true;
    if (this.index !== other.index || this.size !== other.size) return false;
    const a = this.bits;
    const b = other.bits;
    for (let row = 0; row < a.length; row++) {
      if (a[row] !== b[row]) return false;
    }
    return true;
  }

  /** Member ids in row (depth-first) order. */
  *[Symbol.iterator](): Iterator<SpanId> {
    const { ids } = this.index.table;
    const bits = this.bits;
    for (let row = 0; row < bits.length; row++) {
      if (bits[row] === 1) yield ids[row];
    }
  }
}

function countMembers(bits: Uint8Array): number {
  let count = 0;
  for (let row = 0; row < bits.length; row++) {
    if (bits[row] === 1) count++;
  }
  return count;
}
