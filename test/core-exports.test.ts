/**
 * The runtime surface of the `log2trace-ui/core` entry. A name appearing or
 * disappearing here is an API change: update the list on purpose, together with the docs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.ts';

const EXPECTED_EXPORTS = [
  'API_ORIGIN',
  'EMPTY_SPAN_SET',
  'MIXED_ORIGIN',
  'Slice',
  'SpanKind',
  'SpanMask',
  'areRequiredExternalFiltersFilled',
  'buildQueryParams',
  'buildSpanIndex',
  'compileFilters',
  'createTraceStore',
  'defineSelector',
  'describeSpan',
  'extractAnyValue',
  'filterSpanIds',
  'formatAbsoluteTime',
  'formatDuration',
  'formatOffset',
  'getField',
  'hoveredSpan',
  'matchSpans',
  'matchSummary',
  'normalizeOptions',
  'selectedSpan',
  'spanKindName',
  'spanSetOf',
  'touches',
  'transformLogs',
];

test('core exports exactly the documented names', () => {
  assert.deepEqual(Object.keys(core).sort(), EXPECTED_EXPORTS);
});
