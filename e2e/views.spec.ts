import { clickCenter, expect, test, waterfallRows } from './support/harness.ts';
import { SAMPLE_TRACE } from './support/fixtures.ts';

test.describe('DOM & SVG views and real input gestures', () => {
  test('waterfall (DOM): tree hierarchy, collapse/expand, time window, wheel zoom, and drag pan', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', 'wheel-zoom': '' },
      traceData: SAMPLE_TRACE,
    });

    const rows = waterfallRows(viz);
    const toolbar = viz.locator('[role="toolbar"][aria-label="Trace view controls"]');
    const zoomReadout = toolbar.locator('span[aria-live="off"]');

    // Initial expanded tree renders all 5 spans with expected hierarchy ARIA attributes
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toHaveAttribute('aria-level', '1');
    await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(rows.nth(2)).toHaveAttribute('aria-level', '2');
    await expect(rows.nth(2)).toHaveAttribute('aria-expanded', 'true');
    await expect(rows.nth(3)).toHaveAttribute('aria-level', '3');

    // Click chevron on createOrder row to collapse its 2 children (SELECT inventory, chargeCard)
    await clickCenter(page, viz.locator('[data-span-id="span-order"] [data-part="chevron"]'));
    await expect(rows).toHaveCount(3);
    await expect(viz.locator('[data-span-id="span-order"]')).toHaveAttribute('aria-expanded', 'false');

    // Programmatic expandAll / collapseAll
    await viz.evaluate((el) => {
      (el as HTMLElement & { expandAll(): void }).expandAll();
    });
    await expect(rows).toHaveCount(5);

    await viz.evaluate((el) => {
      (el as HTMLElement & { collapseAll(): void }).collapseAll();
    });
    await expect(rows).toHaveCount(1);

    await viz.evaluate((el) => {
      (el as HTMLElement & { expandAll(): void }).expandAll();
    });
    await expect(rows).toHaveCount(5);

    // Programmatic setTimeWindow narrows the timeline zoom level
    await expect(zoomReadout).toHaveText('100%');
    await viz.evaluate((el) => {
      (el as HTMLElement & { setTimeWindow(w: { t0: number; t1: number } | null): void })
        .setTimeWindow({ t0: 50, t1: 150 });
    });
    await expect(zoomReadout).toHaveText('200%');

    await viz.evaluate((el) => {
      (el as HTMLElement & { setTimeWindow(w: { t0: number; t1: number } | null): void })
        .setTimeWindow({ t0: 0, t1: 200 });
    });
    await expect(zoomReadout).toHaveText('100%');

    // Real mouse wheel zooms when wheel-zoom attribute is enabled
    const plotBox = await viz.locator('[part="plot"]').boundingBox();
    expect(plotBox).not.toBeNull();
    if (plotBox) {
      const targetX = plotBox.x + plotBox.width * 0.7;
      const targetY = plotBox.y + 80;
      await page.mouse.move(targetX, targetY);
      await page.mouse.wheel(0, -180);
      await expect(zoomReadout).not.toHaveText('100%');

      // Real pointer drag pans the zoomed timeline and shifts rendered span bars horizontally
      const authBar = viz.locator('[data-span-id="span-auth"] [data-part="bar"]');
      const barBeforeDrag = await authBar.boundingBox();
      await page.mouse.move(targetX, targetY);
      await page.mouse.down();
      await page.mouse.move(targetX - 120, targetY, { steps: 6 });
      await page.mouse.up();

      await expect.poll(async () => (await authBar.boundingBox())?.x ?? 0).not.toBe(barBeforeDrag?.x ?? 0);
    }
  });

  test('flame view: call-stack geometry, click selection, double-click/Escape focus, and arrow navigation', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', view: 'flame' },
      children: [{ tag: 'trace-view', attrs: { type: 'flame' } }],
      traceData: SAMPLE_TRACE,
    });

    const flame = viz.locator('[part="flame"][aria-label="Flame graph"]');
    const toolbar = viz.locator('[role="toolbar"][aria-label="Trace view controls"]');
    const readout = toolbar.locator('span[aria-live="off"]');
    await expect(flame).toBeVisible();

    const rootBox = flame.getByText('GET /orders', { exact: true });
    const orderBox = flame.getByText('createOrder', { exact: true });
    const payBox = flame.getByText('chargeCard', { exact: true });

    await expect(rootBox).toBeVisible();
    await expect(orderBox).toBeVisible();
    await expect(payBox).toBeVisible();

    // Vertical call-stack geometry: parent row sits strictly above child row, which sits above grandchild
    const [rRect, oRect, pRect] = await Promise.all([
      rootBox.boundingBox(),
      orderBox.boundingBox(),
      payBox.boundingBox(),
    ]);
    expect(rRect && oRect && pRect).toBeTruthy();
    if (rRect && oRect && pRect) {
      expect(rRect.y).toBeLessThan(oRect.y);
      expect(oRect.y).toBeLessThan(pRect.y);
      expect(rRect.width).toBeGreaterThan(oRect.width);
    }

    // Click selects span and opens detail panel
    await orderBox.click();
    await expect(viz.locator('aside[aria-label="Span details"]')).toContainText('createOrder');

    // Focus selected box with keyboard 'f', then unfocus with Escape
    await flame.focus();
    await page.keyboard.press('f');
    await expect(readout).toHaveText('createOrder');

    const focusedOrderRect = await orderBox.boundingBox();
    expect(focusedOrderRect?.width ?? 0).toBeGreaterThan((oRect?.width ?? 0) + 10);

    await page.keyboard.press('Escape');
    await expect(readout).toHaveText('Whole trace');

    // ArrowUp moves selection from createOrder back to parent GET /orders
    await page.keyboard.press('ArrowUp');
    await expect(viz.locator('aside[aria-label="Span details"]')).toContainText('GET /orders');
  });

  test('service graph view: nodes, inferred peer, SVG edges, selection, and 2D pan/zoom', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', view: 'service' },
      children: [{ tag: 'trace-view', attrs: { type: 'service' } }],
      traceData: SAMPLE_TRACE,
    });

    const serviceView = viz.locator('[part="service"][aria-label="Service dependency graph"]');
    const toolbar = viz.locator('[role="toolbar"][aria-label="Trace view controls"]');
    const zoomReadout = toolbar.locator('span[aria-live="off"]');
    await expect(serviceView).toBeVisible();

    // Renders all 4 instrumented services plus the inferred inventory-db peer node
    const nodes = serviceView.locator('[data-service-name]');
    await expect(nodes).toHaveCount(5);
    await expect(serviceView.locator('[data-service-name="api-gateway"]')).toBeVisible();
    await expect(serviceView.locator('[data-service-name="auth-service"]')).toBeVisible();
    await expect(serviceView.locator('[data-service-name="order-service"]')).toBeVisible();
    await expect(serviceView.locator('[data-service-name="payment-service"]')).toBeVisible();
    await expect(serviceView.locator('[data-service-name="inventory-db"]')).toBeVisible();

    // Directed SVG edges connect caller -> callee
    const edges = serviceView.locator('svg g[data-edge-id]');
    await expect(edges).toHaveCount(4);

    // Click a service node selects its spans and opens details
    await serviceView.locator('[data-service-name="payment-service"]').click();
    await expect(viz.locator('aside[aria-label="Span details"]')).toContainText('chargeCard');

    // Click an edge label selects spans for that call edge
    const edgeLabel = serviceView.locator('div[data-edge-id]').first();
    await edgeLabel.click();
    await expect(viz.locator('aside[aria-label="Span details"]')).toBeVisible();

    // Wheel zoom changes the 2D camera scale readout
    const initialScale = await zoomReadout.textContent();
    const viewBox = await serviceView.boundingBox();
    expect(viewBox).not.toBeNull();
    if (viewBox) {
      await page.mouse.move(viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height / 2);
      await page.mouse.wheel(0, -240);
      await expect(zoomReadout).not.toHaveText(initialScale ?? '');

      // Drag on background pans the world container position
      const gateway = serviceView.locator('[data-service-name="api-gateway"]');
      const beforePan = await gateway.boundingBox();
      await page.mouse.move(viewBox.x + 20, viewBox.y + 20);
      await page.mouse.down();
      await page.mouse.move(viewBox.x + 120, viewBox.y + 80, { steps: 5 });
      await page.mouse.up();
      const afterPan = await gateway.boundingBox();
      expect(beforePan && afterPan).toBeTruthy();
      if (beforePan && afterPan) {
        expect(Math.abs(afterPan.x - beforePan.x) + Math.abs(afterPan.y - beforePan.y)).toBeGreaterThan(20);
      }
    }
  });

  test('sequence diagram view: participant columns, causal message rows, click & keyboard selection', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', view: 'sequence' },
      children: [{ tag: 'trace-view', attrs: { type: 'sequence' } }],
      traceData: SAMPLE_TRACE,
    });

    const seq = viz.locator('[role="treegrid"][aria-label="Sequence diagram"]');
    await expect(seq).toBeVisible();

    // Column headers include the "time" corner plus participant lifelines
    const headers = seq.locator('[role="columnheader"]');
    await expect(headers.first()).toHaveText('time');
    await expect(seq.locator('[role="columnheader"]', { hasText: 'api-gateway' })).toBeVisible();
    await expect(seq.locator('[role="columnheader"]', { hasText: 'order-service' })).toBeVisible();
    await expect(seq.locator('[role="columnheader"]', { hasText: 'payment-service' })).toBeVisible();

    // Message rows (exclude header row by matching rows with aria-level)
    const messageRows = seq.locator('[role="row"][aria-level]');
    const rowCount = await messageRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(4);

    // Click first message row's time gutter to select GET /orders (highlights both request & return rows)
    await messageRows.nth(0).locator('[data-part="gutter"]').click();
    await expect(seq.locator('[role="row"][aria-selected="true"]')).toHaveCount(2);
    await expect(viz.locator('aside[aria-label="Span details"]')).toBeVisible();

    const firstActiveId = await seq.getAttribute('aria-activedescendant');
    expect(firstActiveId).toBeTruthy();

    // ArrowDown advances selection to the next step
    await seq.focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => seq.getAttribute('aria-activedescendant')).not.toBe(firstActiveId);
  });

  test('stats view: column sorting, group selection & expansion, flat Spans mode, filter toggle, and keyboard nav', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', view: 'stats' },
      children: [
        { tag: 'trace-filter', attrs: { field: 'hasError', label: 'Errors Only', type: 'checkbox', source: 'local' } },
        { tag: 'trace-view', attrs: { type: 'stats', active: '' } },
        { tag: 'trace-view', attrs: { type: 'waterfall' } },
      ],
      traceData: SAMPLE_TRACE,
    });

    const stats = viz.locator('[role="treegrid"][aria-label="Trace statistics"]');
    const toolbar = viz.locator('[role="toolbar"][aria-label="Trace view controls"]');
    await expect(stats).toBeVisible();

    // Default grouped mode: 5 distinct (service, operation) rows, sorted by Self Time descending
    const rows = stats.locator('[role="row"][data-display-row]');
    await expect(rows).toHaveCount(5);
    const selfHeader = stats.locator('[role="columnheader"][data-sort-col="self"]');
    await expect(selfHeader).toHaveAttribute('aria-sort', 'descending');

    // Click Errors column header -> sorts chargeCard (1 error) to top row
    const errorsHeader = stats.locator('[role="columnheader"][data-sort-col="errors"]');
    await errorsHeader.click();
    await expect(errorsHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(rows.nth(0)).toContainText('chargeCard');

    // Click row 0 -> selects span and opens DetailPanel
    await rows.nth(0).click();
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(viz.locator('aside[aria-label="Span details"]')).toContainText('chargeCard');

    // Expand group 0 via chevron -> splices member span row below it (5 -> 6 rows)
    await rows.nth(0).locator('[data-part="chevron"]').click();
    await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(rows).toHaveCount(6);
    await expect(rows.nth(1)).toHaveAttribute('aria-level', '2');

    // Keyboard ArrowDown + ArrowLeft navigates back to parent group and collapses it
    await stats.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(rows).toHaveCount(5);

    // Filter Errors Only: Matches only ON shows 1 group; toggling Matches only to dim shows all 5
    await viz.locator('[data-filter-field="hasError"][data-filter-type="checkbox"]').check();
    await expect(rows).toHaveCount(1);
    await toolbar.getByRole('button', { name: 'Matches only' }).click();
    await expect(rows).toHaveCount(5);
    await viz.locator('[data-filter-field="hasError"][data-filter-type="checkbox"]').uncheck();

    // Cycle Group by to flat Spans mode (service-operation -> service -> operation -> kind -> none)
    const groupBtn = toolbar.getByRole('button', { name: 'Group by' });
    for (let i = 0; i < 4; i++) await groupBtn.click();
    await expect(stats.locator('[role="columnheader"]')).toHaveCount(7);
    await expect(stats.locator('[role="columnheader"][data-sort-col="start"]')).toBeVisible();
    await expect(rows).toHaveCount(5);
  });
});
