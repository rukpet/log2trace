/**
 * Sorting and flat treegrid row projection for the stats view.
 *
 * Compiles either grouped aggregations (with optional inline expanded member
 * spans) or flat individual spans into a single flat `StatsProjection` ready for
 * fixed-height virtualized rendering.
 *
 * Headless: no DOM, no browser globals.
 */

import type { GroupByMode, SortColumn, SortDirection } from '../settings.ts';
import type { StatsAggregation } from './aggregate.ts';

/** Metadata for one column in the stats table header. */
export interface StatsColumnDef {
  readonly id: SortColumn;
  readonly label: string;
  readonly align: 'left' | 'right';
  readonly defaultDir: SortDirection;
}

/** Kind of row in a projected display list. */
export const enum DisplayRowKind {
  Group = 0,
  Span = 1,
}

/** Flat display list produced from an aggregation, sort order, and expansion set. */
export interface StatsProjection {
  readonly aggregation: StatsAggregation;
  readonly columns: readonly StatsColumnDef[];
  readonly sort: SortColumn;
  readonly sortDir: SortDirection;
  readonly rowCount: number;
  /** `DisplayRowKind.Group` or `DisplayRowKind.Span` per display row. */
  readonly rowKind: Uint8Array;
  /** Group index (for `Group`) or `SpanTable` row (for `Span`) per display row. */
  readonly rowIndex: Int32Array;
  /** Owning group index for an expanded member span row, or `-1` for top-level rows. */
  readonly parentGroup: Int32Array;
  /** Display row index of each group (`-1` when ungrouped). */
  readonly rowOfGroup: Int32Array;
  /** Display row index of each span row (`-1` when not visible as an individual span row). */
  readonly rowOfSpan: Int32Array;
}

const FLAT_COLUMNS: readonly StatsColumnDef[] = [
  { id: 'name', label: 'Span', align: 'left', defaultDir: 'asc' },
  { id: 'start', label: 'Start', align: 'right', defaultDir: 'asc' },
  { id: 'errors', label: 'Errors', align: 'right', defaultDir: 'desc' },
  { id: 'self', label: 'Self Time', align: 'right', defaultDir: 'desc' },
  { id: 'total', label: 'Duration', align: 'right', defaultDir: 'desc' },
  { id: 'kind', label: 'Kind', align: 'left', defaultDir: 'asc' },
  { id: 'events', label: 'Events', align: 'right', defaultDir: 'desc' },
];

function identityLabel(groupBy: GroupByMode): string {
  switch (groupBy) {
    case 'service-operation':
      return 'Service · Operation';
    case 'service':
      return 'Service';
    case 'operation':
      return 'Operation';
    case 'kind':
      return 'Kind';
    case 'none':
      return 'Span';
  }
}

/** Column definitions for the given grouping mode. */
export function columnsForMode(groupBy: GroupByMode): readonly StatsColumnDef[] {
  if (groupBy === 'none') return FLAT_COLUMNS;
  return [
    { id: 'name', label: identityLabel(groupBy), align: 'left', defaultDir: 'asc' },
    { id: 'count', label: 'Spans', align: 'right', defaultDir: 'desc' },
    { id: 'errors', label: 'Errors', align: 'right', defaultDir: 'desc' },
    { id: 'self', label: 'Self Time', align: 'right', defaultDir: 'desc' },
    { id: 'total', label: 'Total', align: 'right', defaultDir: 'desc' },
    { id: 'min', label: 'Min', align: 'right', defaultDir: 'desc' },
    { id: 'avg', label: 'Avg', align: 'right', defaultDir: 'desc' },
    { id: 'p50', label: 'P50', align: 'right', defaultDir: 'desc' },
    { id: 'p95', label: 'P95', align: 'right', defaultDir: 'desc' },
    { id: 'max', label: 'Max', align: 'right', defaultDir: 'desc' },
  ];
}

/** Default sort direction when clicking a column for the first time. */
export function defaultSortDirForColumn(column: SortColumn): SortDirection {
  return column === 'name' || column === 'start' || column === 'kind' ? 'asc' : 'desc';
}

/** Map a sort column onto a valid column for `groupBy`. */
export function normalizeSortColumn(groupBy: GroupByMode, sort: SortColumn): SortColumn {
  const cols = columnsForMode(groupBy);
  if (cols.some((c) => c.id === sort)) return sort;
  if (groupBy === 'none') {
    if (sort === 'min' || sort === 'avg' || sort === 'p50' || sort === 'p95' || sort === 'max') {
      return 'total';
    }
    return 'self';
  }
  return 'self';
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareGroups(agg: StatsAggregation, a: number, b: number, sort: SortColumn, dirSign: number): number {
  let diff = 0;
  switch (sort) {
    case 'name':
      diff = compareStrings(agg.label[a], agg.label[b]) || compareStrings(agg.secondary[a], agg.secondary[b]);
      break;
    case 'count':
      diff = agg.count[a] - agg.count[b];
      break;
    case 'errors':
      diff = agg.errorCount[a] - agg.errorCount[b];
      break;
    case 'self':
      diff = agg.selfMs[a] - agg.selfMs[b];
      break;
    case 'total':
      diff = agg.totalMs[a] - agg.totalMs[b];
      break;
    case 'min':
      diff = agg.minMs[a] - agg.minMs[b];
      break;
    case 'avg':
      diff = agg.avgMs[a] - agg.avgMs[b];
      break;
    case 'p50':
      diff = agg.p50Ms[a] - agg.p50Ms[b];
      break;
    case 'p95':
      diff = agg.p95Ms[a] - agg.p95Ms[b];
      break;
    case 'max':
      diff = agg.maxMs[a] - agg.maxMs[b];
      break;
    default:
      diff = agg.selfMs[a] - agg.selfMs[b];
      break;
  }
  if (diff !== 0) return diff * dirSign;
  return agg.firstRow[a] - agg.firstRow[b];
}

function compareSpans(agg: StatsAggregation, a: number, b: number, sort: SortColumn, dirSign: number): number {
  const t = agg.index.table;
  const { duration, selfTime } = agg.timings;
  let diff = 0;
  switch (sort) {
    case 'name':
      diff = compareStrings(t.names[t.nameId[a]], t.names[t.nameId[b]])
        || compareStrings(t.services[t.svc[a]], t.services[t.svc[b]]);
      break;
    case 'start':
      diff = t.start[a] - t.start[b];
      break;
    case 'errors':
      diff = (t.status[a] === 2 ? 1 : 0) - (t.status[b] === 2 ? 1 : 0);
      break;
    case 'self':
      diff = selfTime[a] - selfTime[b];
      break;
    case 'total':
    case 'min':
    case 'avg':
    case 'p50':
    case 'p95':
    case 'max':
      diff = duration[a] - duration[b];
      break;
    case 'kind':
      diff = t.kind[a] - t.kind[b];
      break;
    case 'events':
      diff = (t.evOff[a + 1] - t.evOff[a]) - (t.evOff[b + 1] - t.evOff[b]);
      break;
    default:
      diff = selfTime[a] - selfTime[b];
      break;
  }
  if (diff !== 0) return diff * dirSign;
  return a - b;
}

/** Build the sorted, flattened display list for `agg`. */
export function projectStatsRows(
  agg: StatsAggregation,
  requestedSort: SortColumn,
  sortDir: SortDirection,
  expandedGroups: ReadonlySet<string>,
): StatsProjection {
  const columns = columnsForMode(agg.groupBy);
  const sort = normalizeSortColumn(agg.groupBy, requestedSort);
  const dirSign = sortDir === 'asc' ? 1 : -1;
  const tableLen = agg.index.table.length;

  const rowOfGroup = new Int32Array(agg.groupCount).fill(-1);
  const rowOfSpan = new Int32Array(tableLen).fill(-1);

  if (agg.groupBy === 'none') {
    const n = agg.activeSpans.length;
    const rowKind = new Uint8Array(n);
    rowKind.fill(DisplayRowKind.Span);
    const rowIndex = agg.activeSpans.slice();
    if (n > 1) {
      rowIndex.sort((a, b) => compareSpans(agg, a, b, sort, dirSign));
    }
    const parentGroup = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      rowOfSpan[rowIndex[i]] = i;
    }
    return {
      aggregation: agg,
      columns,
      sort,
      sortDir,
      rowCount: n,
      rowKind,
      rowIndex,
      parentGroup,
      rowOfGroup,
      rowOfSpan,
    };
  }

  // Grouped mode: sort groups, then splice expanded member spans inline
  const groupOrder = new Int32Array(agg.groupCount);
  for (let g = 0; g < agg.groupCount; g++) groupOrder[g] = g;
  if (agg.groupCount > 1) {
    groupOrder.sort((a, b) => compareGroups(agg, a, b, sort, dirSign));
  }

  let totalRows = agg.groupCount;
  for (let i = 0; i < agg.groupCount; i++) {
    const g = groupOrder[i];
    if (expandedGroups.has(agg.groupKeys[g])) {
      totalRows += agg.count[g];
    }
  }

  const rowKind = new Uint8Array(totalRows);
  const rowIndex = new Int32Array(totalRows);
  const parentGroup = new Int32Array(totalRows).fill(-1);

  let out = 0;
  for (let i = 0; i < agg.groupCount; i++) {
    const g = groupOrder[i];
    rowKind[out] = DisplayRowKind.Group;
    rowIndex[out] = g;
    rowOfGroup[g] = out;
    out++;

    if (expandedGroups.has(agg.groupKeys[g])) {
      const from = agg.memberOff[g];
      const to = agg.memberOff[g + 1];
      const members = agg.members.slice(from, to);
      if (members.length > 1) {
        members.sort((a, b) => compareSpans(agg, a, b, sort, dirSign));
      }
      for (let m = 0; m < members.length; m++) {
        const spanRow = members[m];
        rowKind[out] = DisplayRowKind.Span;
        rowIndex[out] = spanRow;
        parentGroup[out] = g;
        rowOfSpan[spanRow] = out;
        out++;
      }
    }
  }

  return {
    aggregation: agg,
    columns,
    sort,
    sortDir,
    rowCount: totalRows,
    rowKind,
    rowIndex,
    parentGroup,
    rowOfGroup,
    rowOfSpan,
  };
}

/** Find the best display row for a given `SpanTable` row (direct span row, else owning group row). */
export function findDisplayRowForSpan(proj: StatsProjection, spanRow: number): number {
  if (spanRow < 0 || spanRow >= proj.rowOfSpan.length) return -1;
  const direct = proj.rowOfSpan[spanRow];
  if (direct >= 0) return direct;
  const g = proj.aggregation.groupOfRow[spanRow];
  return g >= 0 ? proj.rowOfGroup[g] : -1;
}
