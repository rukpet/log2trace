/**
 * The waterfall reads its own settings from the options of the element and ignores the rest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewOptions } from '../../../src/kit/view-options.ts';
import { readWaterfallSettings } from '../../../src/views/waterfall/settings.ts';

function options(
  config: Record<string, unknown>,
  attributes: Record<string, string> = {},
  viewAttributes: Record<string, string> = {},
): ViewOptions {
  return {
    config,
    attribute: (name) => attributes[name] ?? null,
    viewAttribute: (name) => viewAttributes[name] ?? null,
  };
}

test('no options give the defaults: nothing set, the plain wheel scrolls', () => {
  const settings = readWaterfallSettings(options({}));
  assert.deepEqual(settings, { spanHeight: undefined, spanPadding: undefined, gutterWidth: undefined, wheelZoom: false });
});

test('metrics come from the configuration, the wheel from attributes', () => {
  const settings = readWaterfallSettings(options({ spanHeight: 18, spanPadding: 3, gutterWidth: 220 }, { 'wheel-zoom': '' }));
  assert.deepEqual(settings, { spanHeight: 18, spanPadding: 3, gutterWidth: 220, wheelZoom: true });
});

test('malformed values and the options of other views are ignored', () => {
  const settings = readWaterfallSettings(options({ spanHeight: '18', gutterWidth: Number.NaN, flameDepth: 9 }));
  assert.equal(settings.spanHeight, undefined);
  assert.equal(settings.gutterWidth, undefined);
  assert.ok(!('flameDepth' in settings));
});

test('child <trace-view> attributes override config and element attributes', () => {
  const settings = readWaterfallSettings(
    options(
      { spanHeight: 18, spanPadding: 3, gutterWidth: 220 },
      { 'wheel-zoom': '' },
      { 'span-height': '28', 'span-padding': '6', 'gutter-width': '260', 'wheel-zoom': 'false' },
    ),
  );
  assert.deepEqual(settings, { spanHeight: 28, spanPadding: 6, gutterWidth: 260, wheelZoom: false });
});
