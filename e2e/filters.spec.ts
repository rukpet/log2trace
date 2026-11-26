import { expect, test, waterfallRows } from './support/harness.ts';
import { SAMPLE_TRACE } from './support/fixtures.ts';

test.describe('Interactive filter bar', () => {
  test('text debounce, filter-changed event, no-match status, and Clear button', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      children: [
        {
          tag: 'trace-filter',
          attrs: { field: 'spanName', label: 'Operation', type: 'text', source: 'local', debounce: '40' },
        },
      ],
      traceData: SAMPLE_TRACE,
    });

    await viz.evaluate((el) => {
      const events: Array<{ field: string; source: string; value: unknown }> = [];
      (window as unknown as Record<string, unknown>).__filterEvents = events;
      el.addEventListener('filter-changed', (e) => {
        const d = (e as CustomEvent<{ field: string; source: string; value: unknown }>).detail;
        events.push({ field: d.field, source: d.source, value: d.value });
      });
    });

    const input = viz.locator('[data-filter-field="spanName"][data-filter-type="text"]');
    const status = viz.locator('[role="status"]:not([aria-live])');
    const live = viz.locator('[role="status"][aria-live="polite"]');

    await input.fill('chargeCard');
    await expect(live).toHaveText('1 of 5 spans match');

    const events = await page.evaluate(
      () => (window as unknown as { __filterEvents: Array<{ field: string; source: string; value: unknown }> }).__filterEvents,
    );
    expect(events).toEqual([{ field: 'spanName', source: 'local', value: 'chargeCard' }]);

    // Zero matches displays no-match status banner
    await input.fill('does-not-exist');
    await expect(status).toBeVisible();
    await expect(status).toContainText('No spans match current filters');
    await expect(live).toHaveText('0 of 5 spans match');

    // Clear resets local filter and restores all spans
    await viz.locator('[data-filter-action="clear-local"]').click();
    await expect(input).toHaveValue('');
    await expect(status).toBeHidden();
    await expect(waterfallRows(viz)).toHaveCount(5);
  });

  test('checkbox, auto-populated dropdown, and static dropdown filter spans accurately', async ({ harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      children: [
        {
          tag: 'trace-filter',
          attrs: { field: 'hasError', label: 'Errors Only', type: 'checkbox', source: 'local' },
        },
        {
          tag: 'trace-filter',
          attrs: {
            field: 'serviceName',
            label: 'Service',
            type: 'dropdown',
            source: 'local',
            'options-source': 'auto',
          },
        },
        {
          tag: 'trace-filter',
          attrs: {
            field: 'spanKind',
            label: 'Span Kind',
            type: 'dropdown',
            source: 'local',
            options: JSON.stringify([
              { value: '2', label: 'Server' },
              { value: '3', label: 'Client' },
            ]),
          },
        },
      ],
      traceData: SAMPLE_TRACE,
    });

    const live = viz.locator('[role="status"][aria-live="polite"]');
    const errorBox = viz.locator('[data-filter-field="hasError"][data-filter-type="checkbox"]');
    const serviceSelect = viz.locator('[data-filter-field="serviceName"][data-filter-type="dropdown"]');
    const kindSelect = viz.locator('[data-filter-field="spanKind"][data-filter-type="dropdown"]');

    // Auto-populated service dropdown includes placeholder + 4 distinct services
    await expect(serviceSelect.locator('option')).toHaveCount(5);

    // Checkbox: only payment-service's chargeCard has an error
    await errorBox.check();
    await expect(live).toHaveText('1 of 5 spans match');
    await errorBox.uncheck();

    // Auto dropdown: order-service owns 2 spans (createOrder + SELECT inventory)
    await serviceSelect.selectOption('order-service');
    await expect(live).toHaveText('2 of 5 spans match');
    await serviceSelect.selectOption('');

    // Static dropdown: Client (3) matches only SELECT inventory
    await kindSelect.selectOption('3');
    await expect(live).toHaveText('1 of 5 spans match');
  });

  test('multiselect toggles options, filters spans, and closes on outside click inside Shadow DOM', async ({ harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      children: [
        {
          tag: 'trace-filter',
          attrs: {
            field: 'serviceName',
            label: 'Services',
            type: 'multiselect',
            source: 'local',
            'options-source': 'auto',
          },
        },
      ],
      traceData: SAMPLE_TRACE,
    });

    const wrapper = viz.locator('[data-filter-field="serviceName"][data-filter-type="multiselect"]');
    const trigger = wrapper.locator('button[aria-haspopup="listbox"]');
    const panel = wrapper.locator('[role="listbox"]');
    const live = viz.locator('[role="status"][aria-live="polite"]');

    await expect(trigger).toHaveText('All');
    await expect(panel).toHaveAttribute('data-open', 'false');

    // Open listbox and select 2 services (auth-service + payment-service = 2 spans)
    await trigger.click();
    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await panel.locator('input[type="checkbox"][value="auth-service"]').check();
    await panel.locator('input[type="checkbox"][value="payment-service"]').check();
    await expect(trigger).toHaveText('2 selected');
    await expect(live).toHaveText('2 of 5 spans match');

    // Clicking outside the filter bar (on the waterfall plot inside the Shadow DOM) closes the panel
    await viz.locator('[part="plot"]').click({ position: { x: 20, y: 20 } });
    await expect(panel).toHaveAttribute('data-open', 'false');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('datetime-range filter populates auto-range bounds and narrows spans by start time', async ({ harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      children: [
        {
          tag: 'trace-filter',
          attrs: {
            field: 'startTime',
            label: 'Time Range',
            type: 'datetime-range',
            source: 'local',
            'auto-range': '',
          },
        },
      ],
      traceData: SAMPLE_TRACE,
    });

    const fromInput = viz.locator('[data-filter-field="startTime"][data-filter-range="from"]');
    const toInput = viz.locator('[data-filter-field="startTime"][data-filter-range="to"]');
    const live = viz.locator('[role="status"][aria-live="polite"]');

    // auto-range fills both bounds from the loaded trace
    await expect(fromInput).not.toHaveValue('');
    await expect(toInput).not.toHaveValue('');

    // Narrow the "from" bound to +100ms after trace start (leaves only span-pay starting at +115ms)
    const fromValue = await fromInput.inputValue();
    const parsedFrom = new Date(fromValue).getTime();
    const narrowedFrom = new Date(parsedFrom + 100);
    const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
    const localIso =
      `${narrowedFrom.getFullYear()}-${pad(narrowedFrom.getMonth() + 1)}-${pad(narrowedFrom.getDate())}`
      + `T${pad(narrowedFrom.getHours())}:${pad(narrowedFrom.getMinutes())}:${pad(narrowedFrom.getSeconds())}.${pad(narrowedFrom.getMilliseconds(), 3)}`;

    await fromInput.fill(localIso);
    await expect(live).toHaveText('1 of 5 spans match');
  });
});
