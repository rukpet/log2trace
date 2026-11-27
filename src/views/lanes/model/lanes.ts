/**
 * The lanes model: the trace as service lanes, each packed into levels, built once per trace.
 *
 * - A **service lane** holds every span of one service (`SpanTable.svc`).
 * - A **peer lane** holds a ghost copy of each leaf CLIENT/PRODUCER span that calls an
 *   uninstrumented peer (database, broker, external host; see `classifyLeafPeers`), so the load on
 *   that peer shows up. Calls to an instrumented service get no ghost: the callee's own spans are
 *   already in its lane. A span with a ghost is therefore in two lanes.
 * - Inside a lane the spans are packed into **levels** by {@link packLevels}; a level of a lane is a
 *   **track**, a sorted list of non-overlapping items.
 *
 * Packing covers the whole trace and never depends on the time window, the filter or the lane
 * order, so rows do not jump while the user zooms, pans or filters. Lane ids are fixed at build time
 * (services first, in `SpanTable.services` order, then peers in order of first call);
 * {@link LaneModel.order} and {@link orderLanes} say in which order to show them.
 *
 * Building is `O(n log n)`.
 *
 * Headless: no DOM, no browser globals.
 */

import { Slice, defineSelector, type Selector, type SpanIndex } from '../../../core/index.ts';
import { classifyLeafPeers } from '../../../core/peers.ts';
import { createPackScratch, packLevels } from './pack.ts';
import { busyOf, intervalsOf, buildSteps, stepsOfRows, type Busy, type Steps } from './summary.ts';

/** What a lane stands for. */
export const enum LaneKind {
  /** An instrumented service: holds its own spans. */
  Service = 0,
  /** An uninstrumented peer: holds ghost copies of the calls that reach it. */
  Peer = 1,
}

/** How to order lanes: by first start, by name, or by busy time (busiest first). */
export type LaneOrder = 'start' | 'name' | 'busy';

/** Options of {@link buildLaneModel}. */
export interface LaneBuildOptions {
  /** Build peer lanes with ghost spans. Default true. */
  readonly peers?: boolean;
}

/**
 * The lanes of one trace. All arrays are read-only; "by lane" means indexed by lane id
 * `0 … laneCount - 1`, "by row" by `SpanTable` row.
 */
export interface LaneModel {
  readonly index: SpanIndex;
  /** Number of lanes. */
  readonly laneCount: number;
  /** Number of service lanes; lanes `0 … serviceCount - 1` are services, the rest peers. */
  readonly serviceCount: number;

  /** Display name of each lane: the service name or the peer name. */
  readonly names: readonly string[];
  /** {@link LaneKind} of each lane. */
  readonly kind: Uint8Array;
  /** Lane ids in the default (`'start'`) display order: `order[position] = lane`. */
  readonly order: Int32Array;
  /** For a peer lane, the service lane of the earliest call that reaches it; -1 for a service lane. */
  readonly callerLane: Int32Array;

  /** Service lane of each row. */
  readonly laneOfRow: Int32Array;
  /** Level of each row inside its service lane. */
  readonly levelOfRow: Int32Array;
  /** Peer lane of the ghost of each row, or -1 when the row has no ghost. */
  readonly ghostLaneOfRow: Int32Array;
  /** Level of the ghost of each row inside its peer lane, or -1. */
  readonly ghostLevelOfRow: Int32Array;

  /** Number of levels of each lane (at least its peak concurrency). */
  readonly levelCount: Int32Array;
  /** Track of lane `l`, level `v` is `laneTrackOff[l] + v`; the lane's tracks are `laneTrackOff[l] … laneTrackOff[l + 1] - 1`. `laneCount + 1` entries. */
  readonly laneTrackOff: Int32Array;
  /** Items of track `t` are `trackItemOff[t] … trackItemOff[t + 1] - 1`, sorted by start. `trackCount + 1` entries. */
  readonly trackItemOff: Int32Array;
  /** Table row of each item. */
  readonly itemRow: Int32Array;
  /** Start of each item, ms. Ascending within a track. */
  readonly itemStart: Float64Array;
  /** End of each item, ms, never before its start. Items of a track do not overlap, so this is ascending within a track too. */
  readonly itemEnd: Float64Array;
  /** 1 for a ghost item (on a peer lane), 0 for a span in its own service lane. */
  readonly itemGhost: Uint8Array;
  /** Item of each row in its service lane. */
  readonly itemOfRow: Int32Array;
  /** Item of the ghost of each row in its peer lane, or -1. */
  readonly ghostItemOfRow: Int32Array;

  /** Spans in each lane (ghosts for a peer lane). */
  readonly spanCount: Int32Array;
  /** Failed spans (`status` 2) in each lane. */
  readonly errorCount: Int32Array;
  /** Peak of the in-flight count of each lane: local roots for a service lane, ghosts for a peer lane. */
  readonly peak: Int32Array;
  /** Time each lane has something in flight (union of its spans), ms. */
  readonly busyMs: Float64Array;
  /** Earliest start in each lane, ms. */
  readonly firstStart: Float64Array;

  /** In-flight count over time of each lane, counting what `peak` counts. */
  readonly steps: readonly Steps[];
  /** Stretches where each lane has any span in flight, for idle gaps. */
  readonly busy: readonly Busy[];
  /** The rows `steps` counts for lane `l` (local roots, or ghost rows) are `countedRow[countedOff[l] … countedOff[l + 1] - 1]`. */
  readonly countedOff: Int32Array;
  readonly countedRow: Int32Array;
  /** Failed rows of lane `l` (ghosts for a peer lane) are `errorRow[errorOff[l] … errorOff[l + 1] - 1]`, by start. */
  readonly errorOff: Int32Array;
  readonly errorRow: Int32Array;
  /** Start of each entry of `errorRow`, ms; ascending within a lane. */
  readonly errorStart: Float64Array;
}

/** Status code of a failed span (`SpanTable.status`). */
const STATUS_ERROR = 2;

/** Build the lanes of a trace. */
export function buildLaneModel(index: SpanIndex, options: LaneBuildOptions = {}): LaneModel {
  const table = index.table;
  const n = table.length;
  const serviceCount = table.services.length;
  const { start, end, parent, status } = table;

  // Peer lanes: one per uninstrumented peer that some leaf call reaches.
  const ghostLaneOfRow = new Int32Array(n).fill(-1);
  const names: string[] = table.services.slice();
  let ghostCount = 0;
  if (options.peers !== false) {
    const peers = classifyLeafPeers(index);
    const laneOfPeer = new Int32Array(peers.count).fill(-1);
    for (let r = 0; r < n; r++) {
      const q = peers.peerOfRow[r];
      if (q < 0 || peers.knownService[q] >= 0) continue;
      if (laneOfPeer[q] < 0) {
        laneOfPeer[q] = names.length;
        names.push(peers.names[q]);
      }
      ghostLaneOfRow[r] = laneOfPeer[q];
      ghostCount++;
    }
  }
  const laneCount = names.length;
  const kind = new Uint8Array(laneCount);
  kind.fill(LaneKind.Peer, serviceCount);

  const laneOfRow = new Int32Array(n);
  for (let r = 0; r < n; r++) laneOfRow[r] = table.svc[r];

  // The rows of every lane, ascending, then packed in place into placement order.
  const itemTotal = n + ghostCount;
  const laneRowOff = new Int32Array(laneCount + 1);
  for (let r = 0; r < n; r++) {
    laneRowOff[laneOfRow[r] + 1]++;
    if (ghostLaneOfRow[r] >= 0) laneRowOff[ghostLaneOfRow[r] + 1]++;
  }
  for (let l = 0; l < laneCount; l++) laneRowOff[l + 1] += laneRowOff[l];
  const laneRows = new Int32Array(itemTotal);
  const fill = laneRowOff.slice(0, laneCount);
  for (let r = 0; r < n; r++) {
    laneRows[fill[laneOfRow[r]]++] = r;
    if (ghostLaneOfRow[r] >= 0) laneRows[fill[ghostLaneOfRow[r]]++] = r;
  }

  const levelOfRow = new Int32Array(n);
  const ghostLevelOfRow = new Int32Array(n).fill(-1);
  const levelCount = new Int32Array(laneCount);
  const scratch = createPackScratch(n);
  for (let l = 0; l < laneCount; l++) {
    const rows = laneRows.subarray(laneRowOff[l], laneRowOff[l + 1]);
    levelCount[l] = l < serviceCount
      ? packLevels(rows, start, end, { parent, laneOfRow, lane: l }, levelOfRow, scratch)
      : packLevels(rows, start, end, null, ghostLevelOfRow, scratch);
  }

  // Tracks: a counting sort of the items by (lane, level) that keeps placement order, which is start order.
  const laneTrackOff = new Int32Array(laneCount + 1);
  for (let l = 0; l < laneCount; l++) laneTrackOff[l + 1] = laneTrackOff[l] + levelCount[l];
  const trackCount = laneTrackOff[laneCount];
  const trackItemOff = new Int32Array(trackCount + 1);
  const trackOfItem = new Int32Array(itemTotal);
  for (let l = 0; l < laneCount; l++) {
    const levels = l < serviceCount ? levelOfRow : ghostLevelOfRow;
    for (let i = laneRowOff[l]; i < laneRowOff[l + 1]; i++) {
      const t = laneTrackOff[l] + levels[laneRows[i]];
      trackOfItem[i] = t;
      trackItemOff[t + 1]++;
    }
  }
  for (let t = 0; t < trackCount; t++) trackItemOff[t + 1] += trackItemOff[t];
  const trackFill = trackItemOff.slice(0, trackCount);
  const itemRow = new Int32Array(itemTotal);
  const itemStart = new Float64Array(itemTotal);
  const itemEnd = new Float64Array(itemTotal);
  const itemGhost = new Uint8Array(itemTotal);
  const itemOfRow = new Int32Array(n);
  const ghostItemOfRow = new Int32Array(n).fill(-1);
  for (let l = 0; l < laneCount; l++) {
    const ghost = l >= serviceCount;
    for (let i = laneRowOff[l]; i < laneRowOff[l + 1]; i++) {
      const r = laneRows[i];
      const item = trackFill[trackOfItem[i]]++;
      itemRow[item] = r;
      itemStart[item] = start[r];
      itemEnd[item] = end[r] > start[r] ? end[r] : start[r];
      if (ghost) {
        itemGhost[item] = 1;
        ghostItemOfRow[r] = item;
      } else {
        itemOfRow[r] = item;
      }
    }
  }

  // Per-lane stats and summaries.
  const spanCount = new Int32Array(laneCount);
  const errorCount = new Int32Array(laneCount);
  const peak = new Int32Array(laneCount);
  const busyMs = new Float64Array(laneCount);
  const firstStart = new Float64Array(laneCount);
  const callerLane = new Int32Array(laneCount).fill(-1);
  const steps: Steps[] = [];
  const busy: Busy[] = [];
  const countedOff = new Int32Array(laneCount + 1);
  const countedBuffer = new Int32Array(itemTotal);
  const errorOff = new Int32Array(laneCount + 1);
  const errorBuffer = new Int32Array(itemTotal);
  let counted = 0;
  let errors = 0;
  for (let l = 0; l < laneCount; l++) {
    const from = laneRowOff[l];
    const to = laneRowOff[l + 1];
    const service = l < serviceCount;
    spanCount[l] = to - from;

    let first = Infinity;
    let firstRow = -1;
    const countedFrom = counted;
    const errorsFrom = errors;
    for (let i = from; i < to; i++) {
      const r = laneRows[i];
      if (start[r] < first || (start[r] === first && r < firstRow)) {
        first = start[r];
        firstRow = r;
      }
      if (status[r] === STATUS_ERROR) errorBuffer[errors++] = r;
      // a service lane counts requests in flight (local roots), a peer lane every call
      if (!service || parent[r] < 0 || laneOfRow[parent[r]] !== l) countedBuffer[counted++] = r;
    }
    firstStart[l] = first === Infinity ? 0 : first;
    errorCount[l] = errors - errorsFrom;
    errorOff[l + 1] = errors;
    countedOff[l + 1] = counted;
    if (!service && firstRow >= 0) callerLane[l] = laneOfRow[firstRow];

    const laneSteps = stepsOfRows(countedBuffer, countedFrom, counted, start, end);
    steps.push(laneSteps);
    peak[l] = laneSteps.peak;
    // every span is drawn, so idle means no span at all, not just no local root
    const laneBusy = service && counted - countedFrom < to - from
      ? busyOf(buildAll(laneRows, from, to, start, end))
      : busyOf(laneSteps);
    busy.push(laneBusy);
    busyMs[l] = laneBusy.totalMs;

    errorBuffer.subarray(errorsFrom, errors).sort((a, b) => start[a] - start[b] || a - b);
  }
  const errorRow = errorBuffer.slice(0, errors);
  const errorStart = new Float64Array(errors);
  for (let k = 0; k < errors; k++) errorStart[k] = start[errorRow[k]];

  const model: LaneModel = {
    index, laneCount, serviceCount, names, kind,
    order: new Int32Array(laneCount),
    callerLane,
    laneOfRow, levelOfRow, ghostLaneOfRow, ghostLevelOfRow,
    levelCount, laneTrackOff, trackItemOff, itemRow, itemStart, itemEnd, itemGhost, itemOfRow, ghostItemOfRow,
    spanCount, errorCount, peak, busyMs, firstStart,
    steps, busy,
    countedOff, countedRow: countedBuffer.slice(0, counted),
    errorOff, errorRow, errorStart,
  };
  model.order.set(orderLanes(model, 'start'));
  return model;
}

/** Steps over every row of a lane slice, for its busy union. */
function buildAll(rows: Int32Array, from: number, to: number, start: Float64Array, end: Float64Array): Steps {
  const { starts, ends } = intervalsOf(rows, from, to, start, end);
  return buildSteps(starts, ends);
}

/**
 * Lane ids in display order. Cheap (no repacking), so the view can switch order freely.
 *
 * - `'start'`: service lanes by first start; each peer lane directly after the service that
 *   calls it first, peers of one service by first call.
 * - `'name'`: every lane by name.
 * - `'busy'`: every lane by busy time, busiest first.
 *
 * Ties go to the earlier first start, then the lower lane id. A view that hides peer lanes skips
 * those with `kind === LaneKind.Peer`.
 */
export function orderLanes(model: LaneModel, order: LaneOrder): Int32Array {
  const { laneCount, serviceCount, firstStart, names, busyMs, callerLane } = model;
  const byStart = (a: number, b: number): number => firstStart[a] - firstStart[b] || a - b;

  const lanes: number[] = [];
  if (order === 'start') {
    const peersOf: number[][] = Array.from({ length: serviceCount }, () => []);
    for (let l = serviceCount; l < laneCount; l++) peersOf[callerLane[l]].push(l);
    const services: number[] = [];
    for (let l = 0; l < serviceCount; l++) services.push(l);
    services.sort(byStart);
    for (const s of services) {
      lanes.push(s);
      peersOf[s].sort(byStart);
      for (const p of peersOf[s]) lanes.push(p);
    }
  } else {
    for (let l = 0; l < laneCount; l++) lanes.push(l);
    if (order === 'name') {
      lanes.sort((a, b) => (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0) || byStart(a, b));
    } else {
      lanes.sort((a, b) => busyMs[b] - busyMs[a] || byStart(a, b));
    }
  }
  return Int32Array.from(lanes);
}

/** First track (level 0) of a lane plus `level`: the track holding the lane's spans of that level. */
export function trackOf(model: LaneModel, lane: number, level: number): number {
  return model.laneTrackOff[lane] + level;
}

/**
 * In-flight count over time of a lane counting only the matched spans.
 *
 * @param mask - A filter result's `SpanMask`, or `null` for no filter (returns the precomputed {@link LaneModel.steps}).
 */
export function matchedSteps(model: LaneModel, lane: number, mask: { readonly bits: Uint8Array } | null): Steps {
  if (mask === null) return model.steps[lane];
  const t = model.index.table;
  return stepsOfRows(model.countedRow, model.countedOff[lane], model.countedOff[lane + 1], t.start, t.end, mask.bits);
}

/** The lanes of the current trace, with peer lanes. Recomputed only when the data changes. */
export const lanesModel: Selector<LaneModel> = defineSelector(
  'lanes.model',
  Slice.Data,
  (state, previous) => (previous !== undefined && previous.index === state.data.index ? previous : buildLaneModel(state.data.index)),
);
