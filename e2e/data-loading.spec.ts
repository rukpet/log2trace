import { expect, test, waterfallRows } from './support/harness.ts';
import { SAMPLE_LOGS, SAMPLE_LOG_CONFIG, SAMPLE_TRACE, SAMPLE_TRACE_ID } from './support/fixtures.ts';

test.describe('Data loading & status states', () => {
  test('shows empty status when mounted without data', async ({ harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({ attrs: { height: '420' } });

    const status = viz.locator('[role="status"]:not([aria-live])');
    await expect(status).toBeVisible();
    await expect(status).toContainText('No trace data loaded');
  });

  test('loads OTel trace from data-url and emits trace-loaded event', async ({ page, harness }) => {
    await harness.openBlank();

    const loadedDetail = await page.evaluate(async () => {
      const root = document.getElementById('root');
      if (root === null) throw new Error('Missing #root');
      const el = document.createElement('trace-visualizer');
      el.id = 'viz';
      el.setAttribute('height', '480');
      el.setAttribute('data-url', '/fixtures/trace.json');

      const detailPromise = new Promise<unknown>((resolve) => {
        el.addEventListener('trace-loaded', (event) => {
          resolve((event as CustomEvent).detail);
        }, { once: true });
      });
      root.append(el);
      return await detailPromise;
    });

    expect(loadedDetail).toEqual({ spans: 5, roots: 1, traceId: SAMPLE_TRACE_ID });

    const viz = page.locator('trace-visualizer#viz');
    await expect(viz.locator('[role="status"]:not([aria-live])')).toBeHidden();
    await expect(waterfallRows(viz)).toHaveCount(5);
  });

  test('loads and transforms raw logs from data-url with <span-kind-rule> children', async ({ harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: {
        height: '480',
        'data-url': '/fixtures/logs.json',
        'trace-id-field': 'traceId',
        'span-group-fields': 'service,action',
        'span-name-field': 'action',
        'service-name-field': 'service',
        'timestamp-field': 'timestamp',
        'status-code-field': 'status',
        'parent-span-lookup-fields': 'parentService',
      },
      children: [
        { tag: 'span-kind-rule', attrs: { 'match-field': 'layer', 'match-value': 'api', kind: 'Server' } },
        { tag: 'span-kind-rule', attrs: { 'match-field': 'layer', 'match-value': 'client', kind: 'Client' } },
      ],
    });

    const rows = waterfallRows(viz);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('handleCheckout');
    await expect(rows.nth(1)).toContainText('captureFunds');

    // Verify span kind classification from <span-kind-rule> carried into store
    const kinds = await viz.evaluate((el) => {
      const store = (el as HTMLElement & {
        store: { state: { data: { index: { table: { names: string[]; nameId: Uint32Array; kind: Uint8Array; length: number } } } } };
      }).store;
      const { names, nameId, kind, length } = store.state.data.index.table;
      const map: Record<string, number> = {};
      for (let i = 0; i < length; i++) map[names[nameId[i]]] = kind[i];
      return map;
    });
    expect(kinds).toEqual({ handleCheckout: 2, captureFunds: 3 });
  });

  test('supports programmatic traceData, logData, loadTraceData, and loadAndTransform', async ({ harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({ attrs: { height: '480' } });
    const rows = waterfallRows(viz);

    // traceData setter
    await viz.evaluate((el, data) => {
      (el as HTMLElement & { traceData: unknown }).traceData = data;
    }, SAMPLE_TRACE);
    await expect(rows).toHaveCount(5);

    // logData setter
    await viz.evaluate((el, input) => {
      (el as HTMLElement & { logData: unknown }).logData = input;
    }, { logs: SAMPLE_LOGS, config: SAMPLE_LOG_CONFIG });
    await expect(rows).toHaveCount(2);

    // loadTraceData(url)
    await viz.evaluate(async (el) => {
      await (el as HTMLElement & { loadTraceData(url: string): Promise<void> }).loadTraceData('/fixtures/trace.json');
    });
    await expect(rows).toHaveCount(5);

    // loadAndTransform(url, config)
    await viz.evaluate(async (el, cfg) => {
      await (el as HTMLElement & { loadAndTransform(url: string, config: unknown): Promise<void> })
        .loadAndTransform('/fixtures/logs.json', cfg);
    }, SAMPLE_LOG_CONFIG);
    await expect(rows).toHaveCount(2);
  });

  test('shows loading spinner for slow responses and error status for HTTP 500 or malformed JSON', async ({ harness }) => {
    harness.allowConsoleErrors();
    await harness.openBlank();

    const viz = await harness.mount({
      attrs: { height: '420', 'data-url': '/fixtures/slow-trace.json?delay=350' },
    });
    const status = viz.locator('[role="status"]:not([aria-live])');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Loading trace data...');
    await expect(waterfallRows(viz)).toHaveCount(5);
    await expect(status).toBeHidden();

    // HTTP 500 error state
    await viz.evaluate(async (el) => {
      await (el as HTMLElement & { loadTraceData(url: string): Promise<void> }).loadTraceData('/fixtures/error');
    });
    await expect(status).toBeVisible();
    await expect(status).toContainText('Error:');

    // Malformed JSON error state
    await viz.evaluate(async (el) => {
      await (el as HTMLElement & { loadTraceData(url: string): Promise<void> }).loadTraceData('/fixtures/bad-json');
    });
    await expect(status).toBeVisible();
    await expect(status).toContainText('Error:');
  });

  test('handles external filters: required status, auto-fetch="false", fetchCallback, and query-param data-url', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '480', 'auto-fetch': 'false' },
      children: [
        {
          tag: 'trace-filter',
          attrs: {
            field: 'service',
            label: 'Service',
            type: 'text',
            source: 'external',
            required: '',
            debounce: '10',
          },
        },
      ],
    });

    const status = viz.locator('[role="status"]:not([aria-live])');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Fill in required fields to load traces');

    // Attach fetchCallback that records (url, params) and returns SAMPLE_TRACE
    await viz.evaluate((el, trace) => {
      const host = el as HTMLElement & {
        fetchCallback: ((url: string | undefined, params: Record<string, string | string[]>) => Promise<unknown>) | null;
      };
      const calls: Array<Record<string, string | string[]>> = [];
      (window as unknown as Record<string, unknown>).__fetchCalls = calls;
      host.fetchCallback = async (_url, params) => {
        calls.push(params);
        return trace;
      };
    }, SAMPLE_TRACE);

    const input = viz.locator('[data-filter-field="service"][data-filter-source="external"]');
    await input.fill('order-service');

    // With auto-fetch="false", callback is not invoked until Search is clicked
    await page.waitForTimeout(60);
    const beforeClick = await page.evaluate(() => (window as unknown as { __fetchCalls: unknown[] }).__fetchCalls.length);
    expect(beforeClick).toBe(0);

    await viz.locator('[data-filter-action="search"]').click();
    await expect(waterfallRows(viz)).toHaveCount(5);
    const recordedCalls = await page.evaluate(() => (window as unknown as { __fetchCalls: Array<Record<string, string>> }).__fetchCalls);
    expect(recordedCalls).toEqual([{ service: 'order-service' }]);

    // Clearing fetchCallback and providing data-url fetches via query parameters
    await viz.evaluate((el) => {
      const host = el as HTMLElement & { fetchCallback: null };
      host.fetchCallback = null;
      host.setAttribute('data-url', '/fixtures/search');
    });
    await viz.locator('[data-filter-action="search"]').click();
    await expect(waterfallRows(viz)).toHaveCount(2);
    await expect(waterfallRows(viz).nth(0)).toContainText('createOrder');
  });
});
