/**
 * Data source: fetching, filter parameters, and turning payloads into a span index.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceData } from '../../src/core/otel/trace.ts';
import { fetchFiltered, fetchJson, payloadToIndex, urlWithParams, type FetchLike } from '../../src/element/data-source.ts';
import { demoLogs, demoOtelIndex, DEMO_CONFIG, readDemoJson } from '../support/demo-data.ts';

function respond(body: unknown, init: { ok?: boolean; statusText?: string } = {}): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return { ok: init.ok ?? true, statusText: init.statusText ?? 'OK', json: async () => body };
    },
  };
}

test('fetchJson returns the document and fails with the status text', async () => {
  assert.deepEqual(await fetchJson('/a', respond({ a: 1 }).fetch), { a: 1 });
  await assert.rejects(fetchJson('/a', respond({}, { ok: false, statusText: 'Not Found' }).fetch), /Failed to load: Not Found/);
});

test('filter parameters are appended; arrays repeat the key', () => {
  assert.equal(urlWithParams('/api', {}), '/api');
  assert.equal(urlWithParams('/api', { q: 'a b', tag: ['x', 'y'] }), '/api?q=a+b&tag=x&tag=y');
});

test('fetchFiltered prefers the callback, else asks the URL, else does nothing', async () => {
  const calls: unknown[] = [];
  const viaCallback = await fetchFiltered({ url: '/api', params: { q: '1' }, callback: async (url, params) => { calls.push([url, params]); return []; } });
  assert.deepEqual(viaCallback, []);
  assert.deepEqual(calls, [['/api', { q: '1' }]]);

  const server = respond([{ a: 1 }]);
  assert.deepEqual(await fetchFiltered({ url: '/api', params: { q: '1' }, callback: null, fetchImpl: server.fetch }), [{ a: 1 }]);
  assert.deepEqual(server.urls, ['/api?q=1']);

  assert.equal(await fetchFiltered({ url: undefined, params: {}, callback: null }), null);
});

test('trace data is indexed as it is', () => {
  const index = payloadToIndex(readDemoJson('otel-trace.json') as TraceData, {});
  assert.equal(index.size, demoOtelIndex().size);
});

test('raw logs are transformed first when the transform fields are configured', () => {
  const index = payloadToIndex(demoLogs(), DEMO_CONFIG);
  assert.ok(index.size > 10);
});
