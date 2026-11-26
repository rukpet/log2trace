import { clickCenter, expect, hoverCenter, test, waterfallRows } from './support/harness.ts';
import { SAMPLE_TRACE } from './support/fixtures.ts';

test.describe('Shell chrome, events & accessibility', () => {
  test('view tabs switch views, update aria-selected, fire view-changed, and preserve per-view state', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', 'show-legend': '' },
      children: [
        { tag: 'trace-view', attrs: { type: 'waterfall' } },
        { tag: 'trace-view', attrs: { type: 'flame' } },
        { tag: 'trace-view', attrs: { type: 'service' } },
        { tag: 'trace-view', attrs: { type: 'sequence' } },
      ],
      traceData: SAMPLE_TRACE,
    });

    await viz.evaluate((el) => {
      const events: Array<{ view: string; previous: string }> = [];
      (window as unknown as Record<string, unknown>).__viewEvents = events;
      el.addEventListener('view-changed', (e) => {
        events.push((e as CustomEvent<{ view: string; previous: string }>).detail);
      });
    });

    const tabs = viz.locator('[part="tabs"] [role="tab"]');
    const toolbar = viz.locator('[role="toolbar"][aria-label="Trace view controls"]');
    const readout = toolbar.locator('span[aria-live="off"]');
    const legend = viz.locator('[part="legend"]');

    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(legend).toBeVisible();

    // Zoom waterfall in via toolbar buttons so we verify both toolbar command wiring and state preservation across tab switches
    const dbBar = viz.locator('[data-span-id="span-db"] [data-part="bar"]');
    const widthBeforeZoom = (await dbBar.boundingBox())?.width ?? 0;
    await toolbar.getByRole('button', { name: 'Zoom in' }).click();
    await toolbar.getByRole('button', { name: 'Zoom in' }).click();
    await expect(readout).not.toHaveText('100%');
    await expect.poll(async () => (await dbBar.boundingBox())?.width ?? 0).toBeGreaterThan(widthBeforeZoom);
    const zoomedReadout = (await readout.textContent()) ?? '';

    // Switch to Flame tab via click
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(viz.locator('[part="flame"]')).toBeVisible();
    await expect(legend).toBeVisible();

    // Double-click createOrder in Flame to focus it
    const createOrderBox = viz.locator('[part="flame"]').getByText('createOrder', { exact: true });
    await expect(createOrderBox).toBeVisible();
    await createOrderBox.dblclick();
    await expect(readout).toHaveText('createOrder');

    // Switch to Service tab via property setter — Service has capabilities.legend === false
    await viz.evaluate((el) => {
      (el as HTMLElement & { view: string }).view = 'service';
    });
    await expect(viz.locator('[part="service"]')).toBeVisible();
    await expect(legend).toBeHidden();

    // Switch back to Waterfall: zoom readout must be preserved
    await tabs.nth(0).click();
    await expect(readout).toHaveText(zoomedReadout);

    // Switch back to Flame: focused box must be preserved
    await tabs.nth(1).click();
    await expect(readout).toHaveText('createOrder');

    const events = await page.evaluate(
      () => (window as unknown as { __viewEvents: Array<{ view: string; previous: string }> }).__viewEvents,
    );
    expect(events).toEqual([
      { view: 'flame', previous: 'waterfall' },
      { view: 'service', previous: 'flame' },
      { view: 'waterfall', previous: 'service' },
      { view: 'flame', previous: 'waterfall' },
    ]);
  });

  test('detail panel opens on span click (with span-selected event), closes cleanly, and selectSpan() stays silent', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520', 'detail-panel-width': '340px' },
      traceData: SAMPLE_TRACE,
    });

    await viz.evaluate((el) => {
      const selected: Array<{ spanId: string; view: string }> = [];
      (window as unknown as Record<string, unknown>).__selected = selected;
      el.addEventListener('span-selected', (e) => {
        const detail = (e as CustomEvent<{ spanId: string; view: string }>).detail;
        selected.push({ spanId: detail.spanId, view: detail.view });
      });
    });

    const detail = viz.locator('aside[aria-label="Span details"]');
    const live = viz.locator('[role="status"][aria-live="polite"]');
    await expect(detail).toBeHidden();

    // Click the payment error span row in waterfall
    const payRow = waterfallRows(viz).filter({ hasText: 'chargeCard' });
    await clickCenter(page, payRow);

    await expect(detail).toBeVisible();
    await expect(detail).toContainText('chargeCard');
    await expect(detail).toContainText('payment-service');
    await expect(detail).toContainText('Card declined');
    await expect(detail).toContainText('payment.failed');
    await expect(live).toHaveText('Selected chargeCard');

    const detailBox = await detail.boundingBox();
    expect(detailBox).not.toBeNull();
    expect(Math.round(detailBox?.width ?? 0)).toBe(340);

    const eventsAfterClick = await page.evaluate(
      () => (window as unknown as { __selected: Array<{ spanId: string; view: string }> }).__selected,
    );
    expect(eventsAfterClick).toEqual([{ spanId: 'span-pay', view: 'waterfall' }]);

    // Close details via close button
    await detail.getByRole('button', { name: 'Close details' }).click();
    await expect(detail).toBeHidden();

    // Programmatic selectSpan() opens details WITHOUT firing span-selected
    await viz.evaluate((el) => {
      (el as HTMLElement & { selectSpan(id: string): void }).selectSpan('span-root');
    });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('GET /orders');
    await expect(detail).toContainText('request.received');

    const eventsAfterApi = await page.evaluate(
      () => (window as unknown as { __selected: Array<{ spanId: string; view: string }> }).__selected,
    );
    expect(eventsAfterApi).toHaveLength(1);
  });

  test('hover tooltip appears within stage bounds and hides on pointer leave', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      traceData: SAMPLE_TRACE,
    });

    const tooltip = viz.locator('[role="tooltip"]');
    await expect(tooltip).toBeHidden();

    const authRow = waterfallRows(viz).filter({ hasText: 'verifyToken' });
    await hoverCenter(page, authRow);

    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('verifyToken');

    const stageBox = await viz.locator('[role="tabpanel"]').boundingBox();
    const tipBox = await tooltip.boundingBox();
    expect(stageBox).not.toBeNull();
    expect(tipBox).not.toBeNull();
    if (stageBox && tipBox) {
      expect(tipBox.width).toBeGreaterThan(0);
      expect(tipBox.height).toBeGreaterThan(0);
      expect(tipBox.x).toBeGreaterThanOrEqual(stageBox.x - 1);
      expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 1);
    }

    // Move pointer completely outside the component
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  test('keyboard shortcuts move focus between view, detail panel, and filter bar', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      children: [
        {
          tag: 'trace-filter',
          attrs: { field: 'spanName', label: 'Operation', type: 'text', source: 'local', debounce: '10' },
        },
      ],
      traceData: SAMPLE_TRACE,
    });

    const plot = viz.locator('[part="plot"]');
    const detail = viz.locator('aside[aria-label="Span details"]');
    const filterInput = viz.locator('[data-filter-field="spanName"]');

    // Click a span so plot is focused and a span is selected
    const authRow = waterfallRows(viz).filter({ hasText: 'verifyToken' });
    await clickCenter(page, authRow);
    await expect(detail).toBeVisible();

    // Enter on selected span moves focus into the detail panel
    await plot.focus();
    await page.keyboard.press('Enter');
    const focusedTagInDetail = await viz.evaluate((el) => {
      const active = el.shadowRoot?.activeElement;
      return active?.getAttribute('aria-label') ?? null;
    });
    expect(focusedTagInDetail).toBe('Span details');

    // Escape in detail panel returns focus to the active view
    await page.keyboard.press('Escape');
    const returnedToPlot = await viz.evaluate((el) => el.shadowRoot?.activeElement?.getAttribute('part'));
    expect(returnedToPlot).toBe('plot');

    // Ctrl+F moves focus to the first filter bar input
    await page.keyboard.press('Control+f');
    const focusedFilterField = await viz.evaluate(
      (el) => el.shadowRoot?.activeElement?.getAttribute('data-filter-field') ?? null,
    );
    expect(focusedFilterField).toBe('spanName');

    // Escape in text filter returns focus to the active view
    await expect(filterInput).toBeFocused();
    await page.keyboard.press('Escape');
    const returnedFromFilter = await viz.evaluate((el) => el.shadowRoot?.activeElement?.getAttribute('part'));
    expect(returnedFromFilter).toBe('plot');
  });
});
