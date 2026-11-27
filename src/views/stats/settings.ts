/**
 * The stats view's own settings.
 *
 * Headless: no DOM, no browser globals.
 */

import { choiceOption, numberOption, type ViewOptions } from '../../kit/view-options.ts';

export type GroupByMode = 'service-operation' | 'service' | 'operation' | 'kind' | 'none';

export type SortColumn =
  | 'self'
  | 'total'
  | 'count'
  | 'errors'
  | 'min'
  | 'avg'
  | 'p50'
  | 'p95'
  | 'max'
  | 'start'
  | 'kind'
  | 'events'
  | 'name';

export type SortDirection = 'desc' | 'asc';

export const GROUP_BY_MODES: readonly GroupByMode[] = [
  'service-operation',
  'service',
  'operation',
  'kind',
  'none',
];

export const SORT_COLUMNS: readonly SortColumn[] = [
  'self',
  'total',
  'count',
  'errors',
  'min',
  'avg',
  'p50',
  'p95',
  'max',
  'start',
  'kind',
  'events',
  'name',
];

export const SORT_DIRECTIONS: readonly SortDirection[] = ['desc', 'asc'];

export const STATS_ROW_H_MIN = 22;
export const STATS_ROW_H_MAX = 48;

export interface StatsSettings {
  /** Grouping dimension (`group-by` on `<trace-view type="stats">`, or `stats-group-by` / `statsGroupBy`). Default `'service-operation'`. */
  readonly groupBy: GroupByMode;
  /** Active sort column (`sort` on `<trace-view type="stats">`, or `stats-sort` / `statsSort`). Default `'self'`. */
  readonly sort: SortColumn;
  /** Active sort direction (`sort-dir` on `<trace-view type="stats">`, or `stats-sort-dir` / `statsSortDir`). Default `'desc'`. */
  readonly sortDir: SortDirection;
  /** Whether active local filters scope rows & aggregations (`true`) or dim non-matches (`false`). Default `true`. */
  readonly matchesOnly: boolean;
  /** Row height in CSS pixels (`row-height` on `<trace-view type="stats">`, or `row-height` / `rowHeight`). Default `28`, clamped to `[22, 48]`. */
  readonly rowHeight: number;
}

export const DEFAULT_STATS_SETTINGS: StatsSettings = Object.freeze({
  groupBy: 'service-operation',
  sort: 'self',
  sortDir: 'desc',
  matchesOnly: true,
  rowHeight: 28,
});

function readChoice<T extends string>(
  options: ViewOptions,
  attribute: string,
  configKey: string,
  choices: readonly T[],
  fallback: T,
  viewName: string,
): T {
  const fromAttr = choiceOption(options, attribute, choices, viewName);
  if (fromAttr !== undefined) return fromAttr;
  const fromConfig = options.config[configKey];
  if (typeof fromConfig === 'string') {
    const match = choices.find((choice) => choice === fromConfig);
    if (match !== undefined) return match;
  }
  return fallback;
}

function readBoolean(
  options: ViewOptions,
  attribute: string,
  configKey: string,
  viewName: string,
  fallback: boolean,
): boolean {
  const own = options.viewAttribute?.(viewName);
  if (own != null) return own !== 'false';
  const host = options.attribute(attribute);
  if (host !== null) return host !== 'false';
  const cfg = options.config[configKey];
  if (typeof cfg === 'boolean') return cfg;
  return fallback;
}

function readNumber(options: ViewOptions, configKey: string, attribute: string, viewName: string): number | undefined {
  const fromOption = numberOption(options, configKey, viewName);
  if (fromOption !== undefined) return fromOption;
  const rawConfig = options.config[configKey];
  if (typeof rawConfig === 'string' && rawConfig.trim() !== '') {
    const parsed = Number(rawConfig);
    if (Number.isFinite(parsed)) return parsed;
  }
  const attr = options.attribute(attribute);
  if (attr !== null && attr.trim() !== '') {
    const parsed = Number(attr);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Read the settings of the stats view from the options of the element. */
export function readStatsSettings(options: ViewOptions): StatsSettings {
  const groupBy = readChoice(
    options,
    'stats-group-by',
    'statsGroupBy',
    GROUP_BY_MODES,
    DEFAULT_STATS_SETTINGS.groupBy,
    'group-by',
  );

  const sort = readChoice(
    options,
    'stats-sort',
    'statsSort',
    SORT_COLUMNS,
    DEFAULT_STATS_SETTINGS.sort,
    'sort',
  );

  const sortDir = readChoice(
    options,
    'stats-sort-dir',
    'statsSortDir',
    SORT_DIRECTIONS,
    DEFAULT_STATS_SETTINGS.sortDir,
    'sort-dir',
  );

  const matchesOnly = readBoolean(
    options,
    'stats-matches-only',
    'statsMatchesOnly',
    'matches-only',
    DEFAULT_STATS_SETTINGS.matchesOnly,
  );

  const rawRowHeight = readNumber(options, 'rowHeight', 'row-height', 'row-height');
  const rowHeight =
    rawRowHeight !== undefined
      ? Math.min(STATS_ROW_H_MAX, Math.max(STATS_ROW_H_MIN, Math.round(rawRowHeight)))
      : DEFAULT_STATS_SETTINGS.rowHeight;

  return {
    groupBy,
    sort,
    sortDir,
    matchesOnly,
    rowHeight,
  };
}
