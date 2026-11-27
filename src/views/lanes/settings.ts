/**
 * The lanes view's own settings.
 *
 * What the lanes view reads from the element's options. Like the stats view, each option is looked
 * up in three places, first match wins: the view's own `<trace-view type="lanes">` child (short
 * names such as `max-rows`, or the prefixed `lane-max-rows`), an attribute of `<trace-visualizer>`
 * (`lane-max-rows`), then the `config` property (`laneMaxRows`). `wheel-zoom` and `gutter-width` are
 * shared with the waterfall and read the same way it reads them. Unknown or malformed values read
 * as "not set".
 *
 * As with the stats view, only the `<trace-view>` attributes are reactive: a `<trace-visualizer>`
 * attribute (`lane-max-rows`) or a `config` key is an initial fallback, read when the view is
 * created, and changing it later has no effect on a view that is already showing.
 *
 * Headless: no DOM, no browser globals.
 */

import { flagOption, numberOption, type ViewOptions } from '../../kit/view-options.ts';
import type { LaneOrder } from './model/lanes.ts';
import type { LanesMetrics } from './model/layout.ts';

/** The orders lanes can be shown in. */
export const LANE_ORDERS: readonly LaneOrder[] = ['start', 'name', 'busy'];

/** Smallest and largest `lane-max-rows`. */
export const MAX_ROWS_MIN = 1;
export const MAX_ROWS_MAX = 1000;
/** Smallest and largest `lane-row-height`, px. */
export const ROW_HEIGHT_MIN = 12;
export const ROW_HEIGHT_MAX = 48;
/** Smallest and largest `gutter-width`, px. */
export const GUTTER_WIDTH_MIN = 80;
export const GUTTER_WIDTH_MAX = 600;

/** The options of the lanes view. */
export interface LanesSettings {
  /** Level rows a capped lane shows before its overflow row (`lane-max-rows`), a whole number from {@link MAX_ROWS_MIN}. Default 16. */
  readonly maxRows: number;
  /** Height of a level row, px (`lane-row-height`), from {@link ROW_HEIGHT_MIN} to {@link ROW_HEIGHT_MAX}. Default 18. */
  readonly rowHeight: number;
  /** How lanes are ordered (`lane-order`): by first start, by name, or by busy time. Default `'start'`. */
  readonly order: LaneOrder;
  /** Whether peer lanes with ghost calls are shown (`lane-peers`; only the value `false` turns them off). Default true. */
  readonly peers: boolean;
  /** Let the plain wheel zoom instead of scrolling the lanes (`wheel-zoom`). Default false. */
  readonly wheelZoom: boolean;
  /** Width of the label column, px (`gutter-width`). Default 220. */
  readonly gutterWidth: number;
}

export const DEFAULT_LANES_SETTINGS: LanesSettings = Object.freeze({
  maxRows: 16,
  rowHeight: 18,
  order: 'start',
  peers: true,
  wheelZoom: false,
  gutterWidth: 220,
});

/** The name of an option on `<trace-view>`, `<trace-visualizer>` and in `config`. */
interface OptionName {
  /** Short attribute name on `<trace-view>` (`max-rows`). */
  readonly short: string;
  /** Attribute name on `<trace-view>` or `<trace-visualizer>` (`lane-max-rows`). */
  readonly attribute: string;
  /** Key in `config` (`laneMaxRows`). */
  readonly key: string;
}

const MAX_ROWS: OptionName = { short: 'max-rows', attribute: 'lane-max-rows', key: 'laneMaxRows' };
const ROW_HEIGHT: OptionName = { short: 'row-height', attribute: 'lane-row-height', key: 'laneRowHeight' };
const ORDER: OptionName = { short: 'order', attribute: 'lane-order', key: 'laneOrder' };
const PEERS: OptionName = { short: 'peers', attribute: 'lane-peers', key: 'lanePeers' };

function parseNumber(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumber(options: ViewOptions, name: OptionName): number | undefined {
  return (
    parseNumber(options.viewAttribute?.(name.short)) ??
    parseNumber(options.viewAttribute?.(name.attribute)) ??
    parseNumber(options.attribute(name.attribute)) ??
    numberOption(options, name.key) ??
    parseNumber(typeof options.config[name.key] === 'string' ? (options.config[name.key] as string) : undefined)
  );
}

function readOrder(options: ViewOptions): LaneOrder {
  const pick = (value: unknown): LaneOrder | undefined => LANE_ORDERS.find((order) => order === value);
  return (
    pick(options.viewAttribute?.(ORDER.short)) ??
    pick(options.viewAttribute?.(ORDER.attribute)) ??
    pick(options.attribute(ORDER.attribute)) ??
    pick(options.config[ORDER.key]) ??
    DEFAULT_LANES_SETTINGS.order
  );
}

function readPeers(options: ViewOptions): boolean {
  const own = options.viewAttribute?.(PEERS.short) ?? options.viewAttribute?.(PEERS.attribute);
  if (own != null) return own !== 'false';
  const host = options.attribute(PEERS.attribute);
  if (host !== null) return host !== 'false';
  const configured = options.config[PEERS.key];
  return typeof configured === 'boolean' ? configured : DEFAULT_LANES_SETTINGS.peers;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Read the settings of the lanes view from the options of the element. */
export function readLanesSettings(options: ViewOptions): LanesSettings {
  const maxRows = readNumber(options, MAX_ROWS);
  const rowHeight = readNumber(options, ROW_HEIGHT);
  const gutterWidth = numberOption(options, 'gutterWidth', 'gutter-width');
  return {
    maxRows: maxRows === undefined ? DEFAULT_LANES_SETTINGS.maxRows : clamp(Math.round(maxRows), MAX_ROWS_MIN, MAX_ROWS_MAX),
    rowHeight: rowHeight === undefined ? DEFAULT_LANES_SETTINGS.rowHeight : clamp(Math.round(rowHeight), ROW_HEIGHT_MIN, ROW_HEIGHT_MAX),
    order: readOrder(options),
    peers: readPeers(options),
    wheelZoom: flagOption(options, 'wheel-zoom'),
    gutterWidth: gutterWidth === undefined ? DEFAULT_LANES_SETTINGS.gutterWidth : clamp(gutterWidth, GUTTER_WIDTH_MIN, GUTTER_WIDTH_MAX),
  };
}

/** The sizes of the layout that the settings decide: a 2 px gap under each bar, the rest as configured. */
export function metricsOf(settings: LanesSettings): Partial<LanesMetrics> {
  return {
    rowHeight: settings.rowHeight,
    barHeight: Math.max(1, settings.rowHeight - 2),
    gutterWidth: settings.gutterWidth,
    maxRows: settings.maxRows,
  };
}
