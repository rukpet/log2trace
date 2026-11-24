/**
 * SpanTable: a trace as parallel typed arrays.
 *
 * Rows are the spans in depth-first pre-order (parents before children,
 * siblings by start time), so a row number doubles as "position in the
 * waterfall" and a subtree is a contiguous range of rows. Per-row work
 * (filtering, projecting visible rows, hit testing, painting) becomes a loop
 * over numbers instead of a walk over objects, and nothing is allocated per row.
 *
 * Times are `Float64` milliseconds from the earliest span start, computed from
 * exact nanosecond arithmetic, so a trace that is hours long keeps microsecond
 * detail. The table is built once by `buildSpanIndex` and never changes.
 *
 * Headless: no DOM, no browser globals.
 */

import type { Event, Span } from './otel/trace.ts';
import { nanoDeltaToMilli, parseNano } from './time.ts';

/**
 * Columnar, read-only form of one trace. Every array has one entry per row
 * unless noted; do not mutate any of them.
 *
 * Invariants:
 * - rows are in depth-first pre-order: a span's parent has a smaller row number,
 *   and its descendants are exactly rows `row + 1 … subtreeEnd[row] - 1`;
 * - siblings (and roots) are ordered by `start`, ties keeping input order;
 * - `depth[row] === depth[parent[row]] + 1`, and `0` for roots;
 * - `evT` is non-decreasing within each span's range `evOff[row] … evOff[row + 1] - 1`.
 */
export interface SpanTable {
  /** Number of spans (rows). */
  readonly length: number;
  /** The instant that counts as time zero, the earliest span start: nanoseconds since the Unix epoch. */
  readonly originNs: bigint;
  /** Length of the time axis: the latest start or end of any span, ms after the origin. 0 for an empty trace. */
  readonly extentMs: number;

  /** Span id of each row. */
  readonly ids: readonly string[];
  /** Start of each span, ms after the origin. */
  readonly start: Float64Array;
  /** End of each span, ms after the origin. Not clamped: a malformed span may end before it starts. */
  readonly end: Float64Array;
  /** `SpanKind` value; 0 (unspecified) for anything outside 0–255. */
  readonly kind: Uint8Array;
  /** Status code: 0 unset, 1 ok, 2 error (as sent; 0 when missing). */
  readonly status: Uint8Array;
  /** Index into {@link SpanTable.services}. */
  readonly svc: Uint32Array;
  /** Index into {@link SpanTable.names}. */
  readonly nameId: Int32Array;
  /** Distinct service names, in order of first appearance among the rows. */
  readonly services: readonly string[];
  /** Distinct span names, in order of first appearance among the rows. */
  readonly names: readonly string[];

  /** Row of the parent span, or -1 for a root. */
  readonly parent: Int32Array;
  /** Depth in the tree: 0 for a root. */
  readonly depth: Int32Array;
  /** One past the last row of this span's subtree, so a leaf has `subtreeEnd === row + 1`. */
  readonly subtreeEnd: Int32Array;

  /** Events in compressed-row form. `evOff` has `length + 1` entries: row `r` owns `evOff[r] … evOff[r + 1] - 1`. */
  readonly evOff: Int32Array;
  /** Event times, ms after the origin, sorted within each span. One entry per event of the whole trace. */
  readonly evT: Float64Array;
  /** Position of each event in its span's original `events` array, so `span.events[evSrc[k]]` is event `k`. */
  readonly evSrc: Int32Array;
}

/** What {@link buildSpanTable} reads: one entry per span, in any order ("slot" order). */
export interface SpanTableInput {
  readonly spans: readonly Span[];
  /** Service name of each span. */
  readonly serviceNames: readonly string[];
  /** Slot of each span's parent, or -1 when it has none the trace knows about. Copied before use. */
  readonly parentSlot: Int32Array;
  /** Start of each span, nanoseconds since the Unix epoch. */
  readonly startNs: BigInt64Array;
  /** End of each span, nanoseconds since the Unix epoch. */
  readonly endNs: BigInt64Array;
}

/** A built table and where each input slot ended up. */
export interface BuiltSpanTable {
  readonly table: SpanTable;
  /** Row of each input slot. */
  readonly idxOfSlot: Int32Array;
}

/**
 * Build the table for a set of spans.
 *
 * Parent links that form a cycle (a span that is its own ancestor, which no
 * well-formed trace has) are broken at the cycle member that starts first, so
 * every span ends up in the tree.
 *
 * @param input - The spans and their parsed times.
 * @throws Error when an event time is not a nanosecond timestamp.
 */
export function buildSpanTable(input: SpanTableInput): BuiltSpanTable {
  const { spans, serviceNames, startNs, endNs } = input;
  const n = spans.length;

  let originNs = n > 0 ? startNs[0] : 0n;
  for (let slot = 1; slot < n; slot++) {
    if (startNs[slot] < originNs) originNs = startNs[slot];
  }

  const startBySlot = new Float64Array(n);
  const endBySlot = new Float64Array(n);
  let extentMs = 0;
  for (let slot = 0; slot < n; slot++) {
    const start = nanoDeltaToMilli(startNs[slot], originNs);
    const end = nanoDeltaToMilli(endNs[slot], originNs);
    startBySlot[slot] = start;
    endBySlot[slot] = end;
    if (start > extentMs) extentMs = start;
    if (end > extentMs) extentMs = end;
  }

  const order = slotsByStart(startBySlot);
  const parentOfSlot = input.parentSlot.slice();
  breakCycles(parentOfSlot, order);

  // Children of each slot, in start order: counting sort by parent, filled by walking `order`.
  const childOff = new Int32Array(n + 1);
  for (let slot = 0; slot < n; slot++) {
    if (parentOfSlot[slot] >= 0) childOff[parentOfSlot[slot] + 1]++;
  }
  for (let slot = 0; slot < n; slot++) childOff[slot + 1] += childOff[slot];
  const children = new Int32Array(childOff[n]);
  const fill = childOff.slice(0, n);
  for (let k = 0; k < n; k++) {
    const slot = order[k];
    const parent = parentOfSlot[slot];
    if (parent >= 0) children[fill[parent]++] = slot;
  }

  // Depth-first walk with an explicit stack: a chain of 50K nested spans must not overflow the call stack.
  const idxOfSlot = new Int32Array(n);
  const slotAtIdx = new Int32Array(n);
  const depth = new Int32Array(n);
  const subtreeEnd = new Int32Array(n);
  const stack = new Int32Array(n);
  const cursor = childOff.slice(0, n);
  let next = 0;
  for (let k = 0; k < n; k++) {
    const root = order[k];
    if (parentOfSlot[root] >= 0) continue;
    let top = 0;
    stack[top++] = root;
    idxOfSlot[root] = next;
    slotAtIdx[next] = root;
    depth[next++] = 0;
    while (top > 0) {
      const slot = stack[top - 1];
      if (cursor[slot] < childOff[slot + 1]) {
        const child = children[cursor[slot]++];
        idxOfSlot[child] = next;
        slotAtIdx[next] = child;
        depth[next++] = top;
        stack[top++] = child;
      } else {
        top--;
        subtreeEnd[idxOfSlot[slot]] = next;
      }
    }
  }
  if (next !== n) throw new Error(`SpanTable: ${n - next} spans are not reachable from a root`);

  const ids = new Array<string>(n);
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  const kind = new Uint8Array(n);
  const status = new Uint8Array(n);
  const svc = new Uint32Array(n);
  const nameId = new Int32Array(n);
  const parent = new Int32Array(n);
  const services: string[] = [];
  const names: string[] = [];
  const serviceIds = new Map<string, number>();
  const nameIds = new Map<string, number>();
  const evOff = new Int32Array(n + 1);

  let eventCount = 0;
  for (let row = 0; row < n; row++) {
    const slot = slotAtIdx[row];
    const span = spans[slot];
    ids[row] = span.spanId;
    start[row] = startBySlot[slot];
    end[row] = endBySlot[slot];
    kind[row] = toByte(span.kind);
    status[row] = toByte(span.status?.code ?? 0);
    svc[row] = intern(serviceIds, services, serviceNames[slot]);
    nameId[row] = intern(nameIds, names, span.name);
    parent[row] = parentOfSlot[slot] >= 0 ? idxOfSlot[parentOfSlot[slot]] : -1;
    evOff[row] = eventCount;
    eventCount += span.events?.length ?? 0;
  }
  evOff[n] = eventCount;

  const evT = new Float64Array(eventCount);
  const evSrc = new Int32Array(eventCount);
  for (let row = 0; row < n; row++) {
    const span = spans[slotAtIdx[row]];
    if (span.events && span.events.length > 0) {
      writeEvents(span.events, evOff[row], originNs, evT, evSrc, span.spanId);
    }
  }

  const table: SpanTable = {
    length: n, originNs, extentMs,
    ids, start, end, kind, status, svc, nameId, services, names,
    parent, depth, subtreeEnd, evOff, evT, evSrc,
  };
  return { table, idxOfSlot };
}

/** Slots ordered by start time, ties by slot. Skips the sort when the input is already in order, the usual case for logs. */
function slotsByStart(start: Float64Array): Int32Array {
  const n = start.length;
  const order = new Int32Array(n);
  let sorted = true;
  for (let slot = 0; slot < n; slot++) {
    order[slot] = slot;
    if (slot > 0 && start[slot] < start[slot - 1]) sorted = false;
  }
  if (!sorted) order.sort((a, b) => start[a] - start[b] || a - b);
  return order;
}

/**
 * Turn the parent links into a forest. Every span has at most one parent, so the
 * only way to get a cycle is to follow parents in a loop; walk each chain once,
 * and where a walk meets itself, cut the link above the cycle member that
 * starts first (earliest in `order`).
 */
function breakCycles(parent: Int32Array, order: Int32Array): void {
  const n = parent.length;
  const rank = new Int32Array(n);
  for (let k = 0; k < n; k++) rank[order[k]] = k;

  const state = new Uint8Array(n); // 0 not visited, 1 on the walk in progress, 2 settled
  const path = new Int32Array(n);
  for (let first = 0; first < n; first++) {
    if (state[first] !== 0) continue;
    let length = 0;
    let slot = first;
    while (slot >= 0 && state[slot] === 0) {
      state[slot] = 1;
      path[length++] = slot;
      slot = parent[slot];
    }
    if (slot >= 0 && state[slot] === 1) {
      let from = length - 1;
      while (path[from] !== slot) from--;
      let earliest = path[from];
      for (let k = from + 1; k < length; k++) {
        if (rank[path[k]] < rank[earliest]) earliest = path[k];
      }
      parent[earliest] = -1;
    }
    for (let k = 0; k < length; k++) state[path[k]] = 2;
  }
}

/** Keep a small integer that fits a byte; anything else counts as 0. */
function toByte(value: number): number {
  return value >= 0 && value <= 255 ? value : 0;
}

function intern(ids: Map<string, number>, list: string[], value: string): number {
  let id = ids.get(value);
  if (id === undefined) {
    id = list.length;
    ids.set(value, id);
    list.push(value);
  }
  return id;
}

/** Write one span's event times and source positions, sorted by time (ties keep source order). */
function writeEvents(
  events: readonly Event[],
  off: number,
  originNs: bigint,
  evT: Float64Array,
  evSrc: Int32Array,
  spanId: string,
): void {
  const count = events.length;
  let sorted = true;
  for (let k = 0; k < count; k++) {
    const t = nanoDeltaToMilli(parseNano(events[k].timeUnixNano, `time of event ${k} of span ${spanId}`), originNs);
    evT[off + k] = t;
    evSrc[off + k] = k;
    if (k > 0 && t < evT[off + k - 1]) sorted = false;
  }
  if (sorted) return;

  const perm = Array.from({ length: count }, (_, k) => k);
  perm.sort((a, b) => evT[off + a] - evT[off + b] || a - b);
  const times = evT.slice(off, off + count);
  for (let k = 0; k < count; k++) {
    evSrc[off + k] = perm[k];
    evT[off + k] = times[perm[k]];
  }
}
