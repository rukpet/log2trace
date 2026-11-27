/**
 * Headless trace statistics aggregation over columnar `SpanTable` and `SpanTimings`.
 *
 * Groups spans using integer keys in a single linear pass (zero per-span string
 * allocations), computes recursion-safe inclusive totals via `subtreeEnd`, and
 * calculates exact latency percentiles (`min`, `avg`, `p50`, `p95`, `max`) using
 * in-place typed-array subarray sorts.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  formatDuration,
  formatOffset,
  spanKindName,
  type InfoModel,
  type InfoRow,
  type SpanId,
  type SpanIndex,
  type SpanMask,
} from '../../../core/index.ts';
import type { SpanTimings } from '../../../core/self-time.ts';
import type { GroupByMode, SortColumn, SortDirection } from '../settings.ts';

/** Aggregated statistics for the active (windowed and optionally filtered) spans. */
export interface StatsAggregation {
  readonly index: SpanIndex;
  readonly timings: SpanTimings;
  readonly groupBy: GroupByMode;
  readonly matchesOnly: boolean;
  /** Whether a filter mask was active when this aggregation was built. */
  readonly filtered: boolean;
  /** Table row indices included in this aggregation (in table order). */
  readonly activeSpans: Int32Array;
  /** Sum of `timings.selfTime[r]` over `activeSpans`, ms. */
  readonly totalSelfMs: number;
  /** Maximum `selfMs` across all groups (0 when ungrouped or empty). */
  readonly maxGroupSelfMs: number;
  /** Maximum `totalMs` across all groups (0 when ungrouped or empty). */
  readonly maxGroupTotalMs: number;
  /** Maximum `timings.selfTime[r]` across `activeSpans`, ms. */
  readonly maxSpanSelfMs: number;
  /** Maximum `timings.duration[r]` across `activeSpans`, ms. */
  readonly maxSpanDurationMs: number;

  /** Number of groups (0 when `groupBy === 'none'`). */
  readonly groupCount: number;
  /** Stable identity string per group, used to preserve expansion across updates. */
  readonly groupKeys: readonly string[];
  /** Primary display label per group (operation name, service name, or kind label). */
  readonly label: readonly string[];
  /** Secondary muted label per group (service name for `service-operation`, else `''`). */
  readonly secondary: readonly string[];
  /** Representative `SpanKind` per group. */
  readonly kind: Uint8Array;
  /** First `SpanTable` row in this group (for deterministic tie-breaking). */
  readonly firstRow: Int32Array;
  /** Invocation count per group. */
  readonly count: Int32Array;
  /** Error span count (`status === 2`) per group. */
  readonly errorCount: Int32Array;
  /** Filter-matched span count per group (equals `count` when unfiltered or `matchesOnly`). */
  readonly matchedCount: Int32Array;
  /** Sum of exclusive `selfTime` per group, ms. */
  readonly selfMs: Float64Array;
  /** Recursion-safe inclusive duration per group, ms. */
  readonly totalMs: Float64Array;
  /** Latency distribution metrics per group, ms. */
  readonly minMs: Float64Array;
  readonly avgMs: Float64Array;
  readonly p50Ms: Float64Array;
  readonly p95Ms: Float64Array;
  readonly maxMs: Float64Array;

  /** Compressed-row member span indices: group `g` owns `members[memberOff[g] .. memberOff[g + 1] - 1]`. */
  readonly memberOff: Int32Array;
  readonly members: Int32Array;
  /** Group index for each table row (`-1` when ungrouped or excluded). */
  readonly groupOfRow: Int32Array;
}

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** Compute a nearest-rank percentile from a sorted non-empty slice `[start, end)`. */
function sortedPercentile(values: Float64Array, start: number, len: number, p: number): number {
  const rank = Math.ceil(len * p) - 1;
  const clamped = rank < 0 ? 0 : rank >= len ? len - 1 : rank;
  return values[start + clamped];
}

/** Build trace statistics for `index` using precomputed `timings`. */
export function buildStatsAggregation(
  index: SpanIndex,
  timings: SpanTimings,
  matched: SpanMask | null,
  groupBy: GroupByMode,
  matchesOnly: boolean,
): StatsAggregation {
  const t = index.table;
  const n = t.length;
  const { duration, selfTime, inWindow } = timings;
  const filtered = matched !== null;
  const matchBits = matched !== null ? matched.bits : null;
  const filterOut = matchesOnly && matchBits !== null;

  // 1. Collect active span rows in pre-order
  const activeBuf = new Int32Array(timings.activeCount);
  let activeLen = 0;
  let totalSelfMs = 0;
  let maxSpanSelfMs = 0;
  let maxSpanDurationMs = 0;

  for (let r = 0; r < n; r++) {
    if (inWindow[r] === 0) continue;
    if (filterOut && matchBits[r] === 0) continue;
    activeBuf[activeLen++] = r;
    const s = selfTime[r];
    const d = duration[r];
    totalSelfMs += s;
    if (s > maxSpanSelfMs) maxSpanSelfMs = s;
    if (d > maxSpanDurationMs) maxSpanDurationMs = d;
  }

  const activeSpans = activeLen === activeBuf.length ? activeBuf : activeBuf.subarray(0, activeLen);
  const groupOfRow = new Int32Array(n).fill(-1);

  if (groupBy === 'none' || activeLen === 0) {
    return {
      index,
      timings,
      groupBy,
      matchesOnly,
      filtered,
      activeSpans,
      totalSelfMs,
      maxGroupSelfMs: 0,
      maxGroupTotalMs: 0,
      maxSpanSelfMs,
      maxSpanDurationMs,
      groupCount: 0,
      groupKeys: [],
      label: [],
      secondary: [],
      kind: EMPTY_U8,
      firstRow: EMPTY_I32,
      count: EMPTY_I32,
      errorCount: EMPTY_I32,
      matchedCount: EMPTY_I32,
      selfMs: EMPTY_F64,
      totalMs: EMPTY_F64,
      minMs: EMPTY_F64,
      avgMs: EMPTY_F64,
      p50Ms: EMPTY_F64,
      p95Ms: EMPTY_F64,
      maxMs: EMPTY_F64,
      memberOff: EMPTY_I32,
      members: EMPTY_I32,
      groupOfRow,
    };
  }

  // 2. Integer-keyed grouping pass (zero string allocations in the hot loop)
  const svcLookup = groupBy === 'service' ? new Int32Array(t.services.length).fill(-1) : null;
  const nameLookup = groupBy === 'operation' ? new Int32Array(t.names.length).fill(-1) : null;
  const kindLookup = groupBy === 'kind' ? new Int32Array(256).fill(-1) : null;
  const pairLookup = groupBy === 'service-operation' ? new Map<number, number>() : null;
  const nameStride = Math.max(1, t.names.length);

  const firstRowBuf = new Int32Array(activeLen);
  const countBuf = new Int32Array(activeLen);
  const errorBuf = new Int32Array(activeLen);
  const matchedBuf = new Int32Array(activeLen);
  const kindBuf = new Uint8Array(activeLen);
  const selfBuf = new Float64Array(activeLen);
  const totalBuf = new Float64Array(activeLen);
  const sumDurBuf = new Float64Array(activeLen);
  const coveredUntilBuf = new Int32Array(activeLen);

  let groupCount = 0;

  for (let i = 0; i < activeLen; i++) {
    const r = activeSpans[i];
    let g = -1;

    if (pairLookup !== null) {
      const key = t.svc[r] * nameStride + t.nameId[r];
      const existing = pairLookup.get(key);
      if (existing === undefined) {
        g = groupCount++;
        pairLookup.set(key, g);
        firstRowBuf[g] = r;
        kindBuf[g] = t.kind[r];
        coveredUntilBuf[g] = -1;
      } else {
        g = existing;
      }
    } else if (svcLookup !== null) {
      const s = t.svc[r];
      g = svcLookup[s];
      if (g < 0) {
        g = groupCount++;
        svcLookup[s] = g;
        firstRowBuf[g] = r;
        kindBuf[g] = t.kind[r];
        coveredUntilBuf[g] = -1;
      }
    } else if (nameLookup !== null) {
      const nm = t.nameId[r];
      g = nameLookup[nm];
      if (g < 0) {
        g = groupCount++;
        nameLookup[nm] = g;
        firstRowBuf[g] = r;
        kindBuf[g] = t.kind[r];
        coveredUntilBuf[g] = -1;
      }
    } else if (kindLookup !== null) {
      const k = t.kind[r];
      g = kindLookup[k];
      if (g < 0) {
        g = groupCount++;
        kindLookup[k] = g;
        firstRowBuf[g] = r;
        kindBuf[g] = k;
        coveredUntilBuf[g] = -1;
      }
    }

    groupOfRow[r] = g;
    countBuf[g]++;
    if (t.status[r] === 2) errorBuf[g]++;
    if (matchBits === null || matchBits[r] === 1) matchedBuf[g]++;

    const dur = duration[r];
    selfBuf[g] += selfTime[r];
    sumDurBuf[g] += dur;

    // Recursion-safe inclusive total: activeSpans is in DFS pre-order, so any
    // descendant of an already-counted member of group `g` has r < coveredUntilBuf[g].
    if (r >= coveredUntilBuf[g]) {
      totalBuf[g] += dur;
      coveredUntilBuf[g] = t.subtreeEnd[r];
    }
  }

  // 3. Build compressed-row member list and parallel duration scratch for percentile sorts
  const memberOff = new Int32Array(groupCount + 1);
  for (let g = 0; g < groupCount; g++) {
    memberOff[g + 1] = memberOff[g] + countBuf[g];
  }
  const members = new Int32Array(activeLen);
  const durationsScratch = new Float64Array(activeLen);
  const cursor = memberOff.slice(0, groupCount);

  for (let i = 0; i < activeLen; i++) {
    const r = activeSpans[i];
    const g = groupOfRow[r];
    const pos = cursor[g]++;
    members[pos] = r;
    durationsScratch[pos] = duration[r];
  }

  // 4. Compute percentiles, labels, and stable keys per group
  const minMs = new Float64Array(groupCount);
  const avgMs = new Float64Array(groupCount);
  const p50Ms = new Float64Array(groupCount);
  const p95Ms = new Float64Array(groupCount);
  const maxMs = new Float64Array(groupCount);
  const groupKeys = new Array<string>(groupCount);
  const label = new Array<string>(groupCount);
  const secondary = new Array<string>(groupCount);

  let maxGroupSelfMs = 0;
  let maxGroupTotalMs = 0;

  for (let g = 0; g < groupCount; g++) {
    const start = memberOff[g];
    const len = countBuf[g];
    if (len > 1) {
      durationsScratch.subarray(start, start + len).sort();
    }
    minMs[g] = durationsScratch[start];
    maxMs[g] = durationsScratch[start + len - 1];
    avgMs[g] = sumDurBuf[g] / len;
    p50Ms[g] = sortedPercentile(durationsScratch, start, len, 0.5);
    p95Ms[g] = sortedPercentile(durationsScratch, start, len, 0.95);

    if (selfBuf[g] > maxGroupSelfMs) maxGroupSelfMs = selfBuf[g];
    if (totalBuf[g] > maxGroupTotalMs) maxGroupTotalMs = totalBuf[g];

    const fr = firstRowBuf[g];
    if (groupBy === 'service-operation') {
      const svcName = t.services[t.svc[fr]];
      const opName = t.names[t.nameId[fr]];
      label[g] = opName;
      secondary[g] = svcName;
      groupKeys[g] = `so:${svcName}\u0000${opName}`;
    } else if (groupBy === 'service') {
      const svcName = t.services[t.svc[fr]];
      label[g] = svcName;
      secondary[g] = '';
      groupKeys[g] = `s:${svcName}`;
    } else if (groupBy === 'operation') {
      const opName = t.names[t.nameId[fr]];
      label[g] = opName;
      secondary[g] = '';
      groupKeys[g] = `o:${opName}`;
    } else {
      const k = kindBuf[g];
      const kindLabel = spanKindName(k) || 'Unspecified';
      label[g] = kindLabel;
      secondary[g] = '';
      groupKeys[g] = `k:${k}`;
    }
  }

  return {
    index,
    timings,
    groupBy,
    matchesOnly,
    filtered,
    activeSpans,
    totalSelfMs,
    maxGroupSelfMs,
    maxGroupTotalMs,
    maxSpanSelfMs,
    maxSpanDurationMs,
    groupCount,
    groupKeys,
    label,
    secondary,
    kind: kindBuf.subarray(0, groupCount),
    firstRow: firstRowBuf.subarray(0, groupCount),
    count: countBuf.subarray(0, groupCount),
    errorCount: errorBuf.subarray(0, groupCount),
    matchedCount: matchedBuf.subarray(0, groupCount),
    selfMs: selfBuf.subarray(0, groupCount),
    totalMs: totalBuf.subarray(0, groupCount),
    minMs,
    avgMs,
    p50Ms,
    p95Ms,
    maxMs,
    memberOff,
    members,
    groupOfRow,
  };
}

/** Pick the most informative representative span of a group based on the active sort. */
export function primarySpanOfGroup(
  agg: StatsAggregation,
  groupIdx: number,
  sort: SortColumn,
  sortDir: SortDirection,
): SpanId {
  const t = agg.index.table;
  const { duration, selfTime } = agg.timings;
  const from = agg.memberOff[groupIdx];
  const to = agg.memberOff[groupIdx + 1];
  let bestRow = agg.members[from];

  if (sort === 'errors') {
    let foundError = false;
    let bestSelf = -1;
    for (let i = from; i < to; i++) {
      const r = agg.members[i];
      if (t.status[r] === 2) {
        if (!foundError || selfTime[r] > bestSelf) {
          foundError = true;
          bestSelf = selfTime[r];
          bestRow = r;
        }
      } else if (!foundError && selfTime[r] > bestSelf) {
        bestSelf = selfTime[r];
        bestRow = r;
      }
    }
    return t.ids[bestRow];
  }

  const useSelf = sort === 'self';
  const pickMin =
    sortDir === 'asc'
    && (sort === 'self' || sort === 'total' || sort === 'min' || sort === 'avg' || sort === 'p50' || sort === 'p95' || sort === 'max');
  const metric = useSelf ? selfTime : duration;
  let bestVal = metric[bestRow];

  for (let i = from + 1; i < to; i++) {
    const r = agg.members[i];
    const v = metric[r];
    if (pickMin ? v < bestVal : v > bestVal) {
      bestVal = v;
      bestRow = r;
    }
  }
  return t.ids[bestRow];
}

/** All span IDs belonging to a group, together with its sort-aware primary span. */
export function spansOfGroup(
  agg: StatsAggregation,
  groupIdx: number,
  sort: SortColumn,
  sortDir: SortDirection,
): { readonly ids: SpanId[]; readonly primary: SpanId } {
  const t = agg.index.table;
  const from = agg.memberOff[groupIdx];
  const to = agg.memberOff[groupIdx + 1];
  const ids = new Array<SpanId>(to - from);
  for (let i = from; i < to; i++) {
    ids[i - from] = t.ids[agg.members[i]];
  }
  return {
    ids,
    primary: primarySpanOfGroup(agg, groupIdx, sort, sortDir),
  };
}

/** Build an `InfoModel` tooltip for a grouped statistics row. */
export function describeStatsGroup(agg: StatsAggregation, groupIdx: number): InfoModel {
  const count = agg.count[groupIdx];
  const errors = agg.errorCount[groupIdx];
  const selfMs = agg.selfMs[groupIdx];
  const share = agg.totalSelfMs > 0 ? `${((selfMs / agg.totalSelfMs) * 100).toFixed(1)}%` : '0.0%';

  const summaryRows: InfoRow[] = [
    ['Spans', String(count)],
    ['Errors', errors > 0 ? `${errors} (${((errors / count) * 100).toFixed(1)}%)` : '0'],
    ['Self Time', `${formatDuration(selfMs)} (${share})`],
    ['Total', formatDuration(agg.totalMs[groupIdx])],
  ];
  if (agg.filtered && !agg.matchesOnly) {
    summaryRows.push(['Filter matches', `${agg.matchedCount[groupIdx]} / ${count}`]);
  }

  const distRows: InfoRow[] = [
    ['Min', formatDuration(agg.minMs[groupIdx])],
    ['Avg', formatDuration(agg.avgMs[groupIdx])],
    ['P50', formatDuration(agg.p50Ms[groupIdx])],
    ['P95', formatDuration(agg.p95Ms[groupIdx])],
    ['Max', formatDuration(agg.maxMs[groupIdx])],
  ];

  const subtitle = agg.secondary[groupIdx] || undefined;
  return {
    title: agg.label[groupIdx],
    subtitle,
    status: errors > 0 ? 'error' : undefined,
    sections: [
      { title: 'Group', rows: summaryRows },
      { title: 'Latency', rows: distRows },
    ],
  };
}

/** Build a concise `InfoModel` tooltip for an individual span row (expanded member or flat mode). */
export function describeStatsSpan(agg: StatsAggregation, spanRow: number): InfoModel {
  const t = agg.index.table;
  const dur = agg.timings.duration[spanRow];
  const self = agg.timings.selfTime[spanRow];
  const share = agg.totalSelfMs > 0 ? `${((self / agg.totalSelfMs) * 100).toFixed(1)}%` : '0.0%';
  const events = t.evOff[spanRow + 1] - t.evOff[spanRow];
  const rows: InfoRow[] = [
    ['Self Time', `${formatDuration(self)} (${share})`],
    ['Duration', formatDuration(dur)],
    ['Start', formatOffset(t.start[spanRow])],
    ['Kind', spanKindName(t.kind[spanRow]) || 'Unspecified'],
  ];
  if (events > 0) rows.push(['Events', String(events)]);

  return {
    title: t.names[t.nameId[spanRow]],
    subtitle: t.services[t.svc[spanRow]],
    status: t.status[spanRow] === 2 ? 'error' : t.status[spanRow] === 1 ? 'ok' : 'unset',
    sections: [{ title: 'Span', rows }],
  };
}
