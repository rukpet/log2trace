/**
 * The data layer must load in Node without a DOM: no `document`, `HTMLElement`
 * or `CSSStyleSheet` at import time. This is what lets `core/` be unit-tested
 * and used from a Worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HEADLESS_MODULES = [
  '../src/opentelemetry/common.ts',
  '../src/opentelemetry/logs.ts',
  '../src/opentelemetry/resource.ts',
  '../src/opentelemetry/trace.ts',
  '../src/config.ts',
  '../src/filter.ts',
  '../src/instrumentation.ts',
  '../src/span-index.ts',
  '../src/time.ts',
  '../src/trace-view-model.ts',
  '../src/transform.ts',
];

test('data-layer modules load without DOM globals', async () => {
  assert.equal('document' in globalThis, false, 'the test runner must not provide a DOM');
  for (const specifier of HEADLESS_MODULES) {
    await assert.doesNotReject(import(specifier), specifier);
  }
});
