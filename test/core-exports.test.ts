/**
 * The runtime surface of the `log2trace-ui/core` entry. A name appearing or
 * disappearing here is an API change: update the list on purpose, together with the docs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../src/core/index.ts';

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

test('package.json declares zero runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.dependencies, undefined, 'log2trace-ui is a zero-dependency library; use devDependencies only');
});
