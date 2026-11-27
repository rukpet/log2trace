import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewOptions } from '../../../src/kit/view-options.ts';
import {
  DEFAULT_LANES_SETTINGS,
  GUTTER_WIDTH_MAX,
  GUTTER_WIDTH_MIN,
  MAX_ROWS_MAX,
  ROW_HEIGHT_MAX,
  ROW_HEIGHT_MIN,
  metricsOf,
  readLanesSettings,
} from '../../../src/views/lanes/settings.ts';
import { resolveMetrics } from '../../../src/views/lanes/model/layout.ts';

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

test('returns the defaults when nothing is configured', () => {
  assert.deepEqual(readLanesSettings(makeOptions()), DEFAULT_LANES_SETTINGS);
  assert.deepEqual(DEFAULT_LANES_SETTINGS, { maxRows: 16, rowHeight: 18, order: 'start', peers: true, wheelZoom: false, gutterWidth: 220 });
  assert.deepEqual(readLanesSettings({ config: {}, attribute: () => null }), DEFAULT_LANES_SETTINGS, 'a view without a <trace-view> child');
});

test('<trace-view> attributes win over host attributes and config', () => {
  const settings = readLanesSettings(makeOptions({
    config: { laneMaxRows: 30, laneRowHeight: 40, laneOrder: 'name', lanePeers: false, gutterWidth: 300 },
    hostAttrs: { 'lane-max-rows': '20', 'lane-row-height': '30', 'lane-order': 'busy', 'lane-peers': 'false', 'wheel-zoom': '' },
    viewAttrs: { 'max-rows': '8', 'row-height': '24', order: 'start', peers: 'true', 'gutter-width': '180', 'wheel-zoom': 'true' },
  }));
  assert.deepEqual(settings, { maxRows: 8, rowHeight: 24, order: 'start', peers: true, wheelZoom: true, gutterWidth: 180 });
});

test('the prefixed names also work on <trace-view>', () => {
  const settings = readLanesSettings(makeOptions({
    viewAttrs: { 'lane-max-rows': '5', 'lane-row-height': '20', 'lane-order': 'name', 'lane-peers': 'false' },
  }));
  assert.equal(settings.maxRows, 5);
  assert.equal(settings.rowHeight, 20);
  assert.equal(settings.order, 'name');
  assert.equal(settings.peers, false);
});

test('falls back to host attributes, then the programmatic config', () => {
  const fromHost = readLanesSettings(makeOptions({
    hostAttrs: { 'lane-max-rows': '4', 'lane-row-height': '22', 'lane-order': 'busy', 'lane-peers': 'false', 'wheel-zoom': '' },
  }));
  assert.deepEqual(fromHost, { maxRows: 4, rowHeight: 22, order: 'busy', peers: false, wheelZoom: true, gutterWidth: 220 });

  const fromConfig = readLanesSettings(makeOptions({
    config: { laneMaxRows: 12, laneRowHeight: 26, laneOrder: 'name', lanePeers: false, gutterWidth: 260 },
  }));
  assert.deepEqual(fromConfig, { maxRows: 12, rowHeight: 26, order: 'name', peers: false, wheelZoom: false, gutterWidth: 260 });

  const strings = readLanesSettings(makeOptions({ config: { laneMaxRows: '7', laneRowHeight: '21' } }));
  assert.equal(strings.maxRows, 7);
  assert.equal(strings.rowHeight, 21);
});

test('only the value "false" turns peers off', () => {
  assert.equal(readLanesSettings(makeOptions({ hostAttrs: { 'lane-peers': '' } })).peers, true);
  assert.equal(readLanesSettings(makeOptions({ hostAttrs: { 'lane-peers': 'false' } })).peers, false);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { peers: 'false' } })).peers, false);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { peers: '' } })).peers, true);
});

test('numbers are rounded and clamped, bad values read as not set', () => {
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'max-rows': '0' } })).maxRows, 1);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'max-rows': '-4' } })).maxRows, 1);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'max-rows': '2.6' } })).maxRows, 3);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'max-rows': '1e9' } })).maxRows, MAX_ROWS_MAX);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'row-height': '2' } })).rowHeight, ROW_HEIGHT_MIN);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'row-height': '999' } })).rowHeight, ROW_HEIGHT_MAX);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'gutter-width': '10' } })).gutterWidth, GUTTER_WIDTH_MIN);
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { 'gutter-width': '9999' } })).gutterWidth, GUTTER_WIDTH_MAX);

  const bad = readLanesSettings(makeOptions({
    viewAttrs: { 'max-rows': 'many', 'row-height': ' ', order: 'sideways', 'gutter-width': 'wide' },
    hostAttrs: { 'lane-order': 'also-bad' },
    config: { laneMaxRows: NaN, laneOrder: 42 },
  }));
  assert.deepEqual(bad, DEFAULT_LANES_SETTINGS);
});

test('an invalid view order falls through to the host attribute, then the config', () => {
  assert.equal(readLanesSettings(makeOptions({ viewAttrs: { order: 'bogus' }, hostAttrs: { 'lane-order': 'name' } })).order, 'name');
  assert.equal(readLanesSettings(makeOptions({ hostAttrs: { 'lane-order': 'bogus' }, config: { laneOrder: 'busy' } })).order, 'busy');
});

test('metricsOf turns the settings into layout sizes', () => {
  const metrics = resolveMetrics(metricsOf({ ...DEFAULT_LANES_SETTINGS, maxRows: 6, rowHeight: 24, gutterWidth: 300 }));
  assert.equal(metrics.maxRows, 6);
  assert.equal(metrics.rowHeight, 24);
  assert.equal(metrics.barHeight, 22);
  assert.equal(metrics.gutterWidth, 300);
  assert.deepEqual(resolveMetrics(metricsOf(DEFAULT_LANES_SETTINGS)), resolveMetrics());
});
