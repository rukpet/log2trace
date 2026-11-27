import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewOptions } from '../../../src/kit/view-options.ts';
import {
  DEFAULT_STATS_SETTINGS,
  STATS_ROW_H_MAX,
  STATS_ROW_H_MIN,
  readStatsSettings,
} from '../../../src/views/stats/settings.ts';

function makeOptions(opts: {
  config?: Record<string, unknown>;
  hostAttrs?: Record<string, string>;
  viewAttrs?: Record<string, string>;
} = {}): ViewOptions {
  return {
    config: opts.config ?? {},
    attribute: (name) => opts.hostAttrs?.[name] ?? null,
    viewAttribute: (name) => opts.viewAttrs?.[name] ?? null,
  };
}

test('returns default stats settings when no options are provided', () => {
  assert.deepEqual(readStatsSettings(makeOptions()), DEFAULT_STATS_SETTINGS);
});

test('reads <trace-view> attributes with priority over host attributes and config', () => {
  const settings = readStatsSettings(
    makeOptions({
      config: { statsGroupBy: 'service', statsSort: 'count', statsSortDir: 'asc', statsMatchesOnly: false, rowHeight: 40 },
      hostAttrs: { 'stats-group-by': 'operation', 'stats-sort': 'p95', 'stats-sort-dir': 'asc', 'stats-matches-only': 'false', 'row-height': '36' },
      viewAttrs: { 'group-by': 'none', sort: 'events', 'sort-dir': 'desc', 'matches-only': 'true', 'row-height': '24' },
    }),
  );

  assert.deepEqual(settings, {
    groupBy: 'none',
    sort: 'events',
    sortDir: 'desc',
    matchesOnly: true,
    rowHeight: 24,
  });
});

test('falls back to host attributes and programmatic config, ignoring invalid values', () => {
  const fromHost = readStatsSettings(
    makeOptions({
      hostAttrs: { 'stats-group-by': 'kind', 'stats-sort': 'max', 'stats-matches-only': 'false', 'row-height': '12' },
    }),
  );
  assert.equal(fromHost.groupBy, 'kind');
  assert.equal(fromHost.sort, 'max');
  assert.equal(fromHost.matchesOnly, false);
  assert.equal(fromHost.rowHeight, STATS_ROW_H_MIN);

  const fromConfig = readStatsSettings(
    makeOptions({
      viewAttrs: { 'group-by': 'bogus', sort: 'bogus', 'sort-dir': 'sideways', 'row-height': '999' },
      config: { statsGroupBy: 'service', statsSort: 'p50', statsSortDir: 'asc', statsMatchesOnly: false },
    }),
  );
  assert.equal(fromConfig.groupBy, 'service');
  assert.equal(fromConfig.sort, 'p50');
  assert.equal(fromConfig.sortDir, 'asc');
  assert.equal(fromConfig.matchesOnly, false);
  assert.equal(fromConfig.rowHeight, STATS_ROW_H_MAX);
});
