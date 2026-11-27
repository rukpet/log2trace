/**
 * Pooled virtualized DOM painter for the Stats treegrid view.
 *
 * Class names are injected via `StatsDomClasses` so this module never imports
 * `*.css.ts` at runtime and can be unit-tested in plain Node with `FakeElement`.
 */

import {
  formatDuration,
  formatOffset,
  spanKindName,
  type SpanMask,
  type SpanSet,
} from '../../../core/index.ts';
import { h } from '../../../kit/dom.ts';
import { visibleRange } from '../../../kit/geometry/virtual-list.ts';
import { KIND_TOKENS } from '../../../kit/theme/theme.ts';
import { DisplayRowKind, type StatsColumnDef, type StatsProjection } from '../model/projection.ts';

/** CSS class names injected by `dom-mount.ts` (or mock strings in Node tests). */
export interface StatsDomClasses {
  readonly canvas: string;
  readonly header: string;
  readonly headerGridGrouped: string;
  readonly headerGridFlat: string;
  readonly headerCell: string;
  readonly headerCellSticky: string;
  readonly headerCellRight: string;
  readonly headerCellSorted: string;
  readonly sortIndicator: string;
  readonly body: string;
  readonly row: string;
  readonly rowChild: string;
  readonly rowHovered: string;
  readonly rowSelected: string;
  readonly rowDimmed: string;
  readonly cell: string;
  readonly cellIdentity: string;
  readonly cellIdentityChild: string;
  readonly cellMetric: string;
  readonly cellText: string;
  readonly chevron: string;
  readonly kindDot: string;
  readonly kindColor: Readonly<Record<string, string>>;
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  readonly metricValue: string;
  readonly mutedValue: string;
  readonly errorValue: string;
  readonly barTrack: string;
  readonly barFillSelf: string;
  readonly barFillTotal: string;
  readonly emptyNotice: string;
}

export interface StatsPainterContext {
  readonly host: HTMLElement;
}

export interface StatsPaintInput {
  readonly projection: StatsProjection;
  readonly rowHeight: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly expandedGroups: ReadonlySet<string>;
  readonly selectedIds: SpanSet;
  readonly hoveredRow: number;
  readonly matched: SpanMask | null;
  readonly matchesOnly: boolean;
}

export interface StatsPainterStats {
  readonly visibleRows: number;
  readonly poolSize: number;
  readonly paints: number;
}

export interface StatsDomPainter {
  paint(input: StatsPaintInput): void;
  stats(): StatsPainterStats;
  destroy(): void;
}

interface MetricCellSlot {
  readonly el: HTMLElement;
  readonly text: HTMLElement;
  readonly barTrack: HTMLElement;
  readonly barFill: HTMLElement;
}

interface RowSlot {
  readonly el: HTMLElement;
  readonly idCell: HTMLElement;
  readonly chevron: HTMLElement;
  readonly kindDot: HTMLElement;
  readonly primary: HTMLElement;
  readonly secondary: HTMLElement;
  readonly metrics: readonly MetricCellSlot[];
  kindClass: string;
}

const MAX_METRIC_CELLS = 9;
const OVERSCAN = 4;

function formatShare(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) return '0%';
  const pct = (part / total) * 100;
  return pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
}

function formatErrorRate(errors: number, count: number): string {
  if (errors <= 0 || count <= 0) return '—';
  const pct = (errors / count) * 100;
  const pctStr = pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`;
  return `${errors} · ${pctStr}`;
}

function clampPct(value: number, max: number): string {
  if (!(max > 0) || !(value > 0)) return '0%';
  const pct = Math.min(100, (value / max) * 100);
  return `${pct.toFixed(1)}%`;
}

/** Create a pooled virtualized DOM painter mounted into `context.host`. */
export function createStatsDomPainter(
  context: StatsPainterContext,
  classes: StatsDomClasses,
): StatsDomPainter {
  const canvas = h('div', { class: classes.canvas });
  const header = h('div', { class: classes.header, role: 'row' });
  const body = h('div', { class: classes.body });
  const emptyNotice = h(
    'div',
    { class: classes.emptyNotice, role: 'status', hidden: true },
    'No spans in the active time window',
  );

  canvas.append(header, body, emptyNotice);
  context.host.append(canvas);

  const pool: RowSlot[] = [];
  let lastHeaderKey = '';
  let lastVisibleCount = 0;
  let paints = 0;

  function makeRowSlot(): RowSlot {
    const chevron = h('button', {
      class: classes.chevron,
      type: 'button',
      'data-part': 'chevron',
      tabindex: -1,
    });
    const kindDot = h('span', { class: classes.kindDot, 'data-part': 'kind-dot', 'aria-hidden': 'true' });
    const primary = h('span', { class: classes.primaryLabel, 'data-part': 'label' });
    const secondary = h('span', { class: classes.secondaryLabel, 'data-part': 'secondary' });
    const idCell = h(
      'div',
      { class: [classes.cell, classes.cellIdentity], role: 'gridcell' },
      chevron,
      kindDot,
      primary,
      secondary,
    );

    const metrics: MetricCellSlot[] = [];
    for (let i = 0; i < MAX_METRIC_CELLS; i++) {
      const text = h('span', { class: classes.metricValue });
      const barFill = h('div', { class: i === 2 ? classes.barFillSelf : classes.barFillTotal });
      const barTrack = h('div', { class: classes.barTrack, hidden: true }, barFill);
      const cell = h('div', { class: [classes.cell, classes.cellMetric], role: 'gridcell' }, text, barTrack);
      metrics.push({ el: cell, text, barTrack, barFill });
    }

    const rowEl = h(
      'div',
      { class: classes.row, role: 'row', hidden: true },
      idCell,
      ...metrics.map((m) => m.el),
    );
    body.append(rowEl);
    return { el: rowEl, idCell, chevron, kindDot, primary, secondary, metrics, kindClass: '' };
  }

  function syncHeader(columns: readonly StatsColumnDef[], isFlat: boolean, sort: string, sortDir: string): void {
    const key = `${isFlat ? 'f' : 'g'}|${columns[0]?.label ?? ''}|${sort}|${sortDir}`;
    if (key === lastHeaderKey) return;
    lastHeaderKey = key;

    header.classList.toggle(classes.headerGridFlat, isFlat);
    header.classList.toggle(classes.headerGridGrouped, !isFlat);

    const nodes = columns.map((col, idx) => {
      const sorted = col.id === sort;
      const ariaSort = sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
      const cls: Array<string | false> = [
        classes.headerCell,
        idx === 0 && classes.headerCellSticky,
        col.align === 'right' && classes.headerCellRight,
        sorted && classes.headerCellSorted,
      ];
      return h(
        'button',
        {
          class: cls,
          type: 'button',
          role: 'columnheader',
          'data-sort-col': col.id,
          'aria-sort': ariaSort,
        },
        col.label,
        sorted && h('span', { class: classes.sortIndicator, 'aria-hidden': 'true' }, sortDir === 'asc' ? '▴' : '▾'),
      );
    });
    header.replaceChildren(...nodes);
  }

  function setKindDot(slot: RowSlot, kind: number): void {
    const clamped = kind >= 0 && kind < KIND_TOKENS.length ? kind : 0;
    const nextClass = classes.kindColor[String(clamped)] ?? '';
    if (slot.kindClass === nextClass) return;
    if (slot.kindClass !== '') slot.kindDot.classList.remove(slot.kindClass);
    if (nextClass !== '') slot.kindDot.classList.add(nextClass);
    slot.kindClass = nextClass;
  }

  function setMetricCell(
    cell: MetricCellSlot,
    text: string,
    opts: {
      muted?: boolean;
      error?: boolean;
      textAlign?: boolean;
      barWidth?: string | null;
      barKind?: 'self' | 'total';
    } = {},
  ): void {
    cell.el.hidden = false;
    cell.text.textContent = text;
    cell.text.classList.toggle(classes.mutedValue, opts.muted === true);
    cell.text.classList.toggle(classes.errorValue, opts.error === true);
    cell.el.classList.toggle(classes.cellText, opts.textAlign === true);
    cell.el.classList.toggle(classes.cellMetric, opts.textAlign !== true);

    if (opts.barWidth != null) {
      cell.barTrack.hidden = false;
      cell.barFill.style.width = opts.barWidth;
      cell.barFill.classList.toggle(classes.barFillSelf, opts.barKind !== 'total');
      cell.barFill.classList.toggle(classes.barFillTotal, opts.barKind === 'total');
    } else {
      cell.barTrack.hidden = true;
    }
  }

  function isGroupSelected(proj: StatsProjection, g: number, selectedIds: SpanSet): boolean {
    if (selectedIds.size === 0) return false;
    const agg = proj.aggregation;
    const ids = agg.index.table.ids;
    const from = agg.memberOff[g];
    const to = agg.memberOff[g + 1];
    for (let i = from; i < to; i++) {
      if (selectedIds.has(ids[agg.members[i]])) return true;
    }
    return false;
  }

  function paint(input: StatsPaintInput): void {
    paints++;
    const {
      projection: proj,
      rowHeight,
      scrollTop,
      viewportHeight,
      expandedGroups,
      selectedIds,
      hoveredRow,
      matched,
      matchesOnly,
    } = input;
    const agg = proj.aggregation;
    const isFlat = agg.groupBy === 'none';

    syncHeader(proj.columns, isFlat, proj.sort, proj.sortDir);

    const totalHeight = proj.rowCount * rowHeight;
    body.style.height = `${totalHeight}px`;

    const showEmptyWindow =
      proj.rowCount === 0 && agg.index.size > 0 && (matched === null || matched.size > 0);
    emptyNotice.hidden = !showEmptyWindow;

    const range = visibleRange(
      { rowHeight, rowCount: proj.rowCount, viewportHeight },
      scrollTop,
      OVERSCAN,
    );
    const needed = range.last >= range.first ? range.last - range.first + 1 : 0;
    lastVisibleCount = needed;

    while (pool.length < needed) {
      pool.push(makeRowSlot());
    }

    const t = agg.index.table;
    const { duration, selfTime } = agg.timings;

    for (let slotIdx = 0; slotIdx < needed; slotIdx++) {
      const displayRow = range.first + slotIdx;
      const slot = pool[slotIdx];
      const kind = proj.rowKind[displayRow];
      const idx = proj.rowIndex[displayRow];
      const isChild = !isFlat && kind === DisplayRowKind.Span;

      slot.el.hidden = false;
      slot.el.style.top = `${displayRow * rowHeight}px`;
      slot.el.style.height = `${rowHeight}px`;
      slot.el.id = `l2t-stats-row-${displayRow}`;
      slot.el.setAttribute('data-display-row', String(displayRow));
      slot.el.classList.toggle(classes.headerGridFlat, isFlat);
      slot.el.classList.toggle(classes.headerGridGrouped, !isFlat);
      slot.el.classList.toggle(classes.rowChild, isChild);
      slot.idCell.classList.toggle(classes.cellIdentityChild, isChild);

      if (kind === DisplayRowKind.Group) {
        const g = idx;
        const expanded = expandedGroups.has(agg.groupKeys[g]);
        const selected = isGroupSelected(proj, g, selectedIds);
        const dimmed = matched !== null && !matchesOnly && agg.matchedCount[g] === 0;

        slot.el.setAttribute('data-row-kind', 'group');
        slot.el.setAttribute('data-group-idx', String(g));
        slot.el.removeAttribute('data-span-id');
        slot.el.setAttribute('aria-level', '1');
        slot.el.setAttribute('aria-expanded', String(expanded));
        slot.el.setAttribute('aria-selected', String(selected));
        slot.el.classList.toggle(classes.rowSelected, selected);
        slot.el.classList.toggle(classes.rowHovered, hoveredRow === displayRow && !selected);
        slot.el.classList.toggle(classes.rowDimmed, dimmed);

        slot.chevron.hidden = false;
        slot.chevron.textContent = expanded ? '▾' : '▸';
        slot.chevron.setAttribute('aria-label', expanded ? 'Collapse group' : 'Expand group');
        setKindDot(slot, agg.kind[g]);
        slot.primary.textContent = agg.label[g];
        slot.secondary.textContent = agg.secondary[g];
        slot.secondary.hidden = agg.secondary[g] === '';

        const errors = agg.errorCount[g];
        const count = agg.count[g];
        const selfMs = agg.selfMs[g];
        const totalMs = agg.totalMs[g];

        setMetricCell(slot.metrics[0], String(count));
        setMetricCell(slot.metrics[1], formatErrorRate(errors, count), {
          error: errors > 0,
          muted: errors === 0,
        });
        setMetricCell(slot.metrics[2], `${formatDuration(selfMs)} · ${formatShare(selfMs, agg.totalSelfMs)}`, {
          barWidth: clampPct(selfMs, agg.maxGroupSelfMs),
          barKind: 'self',
        });
        setMetricCell(slot.metrics[3], formatDuration(totalMs), {
          barWidth: clampPct(totalMs, agg.maxGroupTotalMs),
          barKind: 'total',
        });
        setMetricCell(slot.metrics[4], formatDuration(agg.minMs[g]));
        setMetricCell(slot.metrics[5], formatDuration(agg.avgMs[g]));
        setMetricCell(slot.metrics[6], formatDuration(agg.p50Ms[g]));
        setMetricCell(slot.metrics[7], formatDuration(agg.p95Ms[g]));
        setMetricCell(slot.metrics[8], formatDuration(agg.maxMs[g]));
      } else {
        const spanRow = idx;
        const spanId = t.ids[spanRow];
        const selected = selectedIds.has(spanId);
        const dimmed = matched !== null && !matchesOnly && !matched.hasRow(spanRow);
        const isErr = t.status[spanRow] === 2;
        const self = selfTime[spanRow];
        const dur = duration[spanRow];

        slot.el.setAttribute('data-row-kind', 'span');
        slot.el.setAttribute('data-span-id', spanId);
        slot.el.removeAttribute('data-group-idx');
        slot.el.setAttribute('aria-level', isChild ? '2' : '1');
        slot.el.removeAttribute('aria-expanded');
        slot.el.setAttribute('aria-selected', String(selected));
        slot.el.classList.toggle(classes.rowSelected, selected);
        slot.el.classList.toggle(classes.rowHovered, hoveredRow === displayRow && !selected);
        slot.el.classList.toggle(classes.rowDimmed, dimmed);

        slot.chevron.hidden = true;
        setKindDot(slot, t.kind[spanRow]);
        slot.primary.textContent = t.names[t.nameId[spanRow]];

        if (isFlat) {
          const svcName = t.services[t.svc[spanRow]];
          slot.secondary.textContent = svcName;
          slot.secondary.hidden = svcName === '';
          const evCount = t.evOff[spanRow + 1] - t.evOff[spanRow];

          setMetricCell(slot.metrics[0], formatOffset(t.start[spanRow]), { muted: true });
          setMetricCell(slot.metrics[1], isErr ? 'ERR' : '—', { error: isErr, muted: !isErr });
          setMetricCell(slot.metrics[2], `${formatDuration(self)} · ${formatShare(self, agg.totalSelfMs)}`, {
            barWidth: clampPct(self, agg.maxSpanSelfMs),
            barKind: 'self',
          });
          setMetricCell(slot.metrics[3], formatDuration(dur), {
            barWidth: clampPct(dur, agg.maxSpanDurationMs),
            barKind: 'total',
          });
          setMetricCell(slot.metrics[4], spanKindName(t.kind[spanRow]) || 'Unspecified', {
            textAlign: true,
          });
          setMetricCell(slot.metrics[5], evCount > 0 ? String(evCount) : '—', { muted: evCount === 0 });
          for (let m = 6; m < MAX_METRIC_CELLS; m++) slot.metrics[m].el.hidden = true;
        } else {
          // Expanded member span inside a grouped table
          slot.secondary.textContent = `@ ${formatOffset(t.start[spanRow])}`;
          slot.secondary.hidden = false;

          setMetricCell(slot.metrics[0], '1', { muted: true });
          setMetricCell(slot.metrics[1], isErr ? 'ERR' : '—', { error: isErr, muted: !isErr });
          setMetricCell(slot.metrics[2], `${formatDuration(self)} · ${formatShare(self, agg.totalSelfMs)}`, {
            barWidth: clampPct(self, agg.maxGroupSelfMs > 0 ? agg.maxGroupSelfMs : agg.maxSpanSelfMs),
            barKind: 'self',
          });
          setMetricCell(slot.metrics[3], formatDuration(dur), {
            barWidth: clampPct(dur, agg.maxGroupTotalMs > 0 ? agg.maxGroupTotalMs : agg.maxSpanDurationMs),
            barKind: 'total',
          });
          for (let m = 4; m < MAX_METRIC_CELLS; m++) {
            setMetricCell(slot.metrics[m], '—', { muted: true });
          }
        }
      }
    }

    for (let slotIdx = needed; slotIdx < pool.length; slotIdx++) {
      const el = pool[slotIdx].el;
      el.hidden = true;
      el.removeAttribute('data-display-row');
    }
  }

  return {
    paint,
    stats: () => ({ visibleRows: lastVisibleCount, poolSize: pool.length, paints }),
    destroy() {
      canvas.remove();
      pool.length = 0;
    },
  };
}
