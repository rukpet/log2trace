/**
 * The core must load in Node without a DOM: no `document`, `HTMLElement`
 * or `CSSStyleSheet` at import time. This is what lets `core/` be unit-tested
 * and used from a Worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);

/** Every module of the headless core, found on disk so that a new file is covered without editing this test. */
function coreModules(): string[] {
  const inside = readdirSync(new URL('core/', SRC), { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => `core/${entry}`);
  return ['core.ts', ...inside];
}

test('core modules load without DOM globals', async () => {
  assert.equal('document' in globalThis, false, 'the test runner must not provide a DOM');
  const modules = coreModules();
  assert.ok(modules.length >= 14, `expected the whole core, found ${modules.join(', ')}`);
  for (const module of modules) {
    await assert.doesNotReject(import(new URL(module, SRC).href), module);
  }
});

test('the legacy view model still loads without DOM globals', async () => {
  await assert.doesNotReject(import(new URL('trace-view-model.ts', SRC).href));
});
