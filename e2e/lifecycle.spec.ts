import { expect, test, waterfallRows } from './support/harness.ts';
import { SAMPLE_TRACE } from './support/fixtures.ts';

test.describe('Element lifecycle, carriers & theming', () => {
  for (const bundle of ['dev', 'min'] as const) {
    test(`registers all custom elements and adopts styles in ${bundle} bundle`, async ({ page, harness }) => {
      await harness.openBlank({ bundle });
      const viz = await harness.mount({ traceData: SAMPLE_TRACE });

      const registered = await page.evaluate(() => ({
        visualizer: customElements.get('trace-visualizer') !== undefined,
        filter: customElements.get('trace-filter') !== undefined,
        rule: customElements.get('span-kind-rule') !== undefined,
        view: customElements.get('trace-view') !== undefined,
      }));
      expect(registered).toEqual({ visualizer: true, filter: true, rule: true, view: true });

      const sheetInfo = await viz.evaluate((el) => {
        const root = el.shadowRoot;
        return {
          hasShadow: root !== null,
          sheetCount: root?.adoptedStyleSheets.length ?? 0,
          ruleCount: root?.adoptedStyleSheets[0]?.cssRules.length ?? 0,
        };
      });
      expect(sheetInfo.hasShadow).toBe(true);
      expect(sheetInfo.sheetCount).toBeGreaterThan(0);
      expect(sheetInfo.ruleCount).toBeGreaterThan(0);
    });
  }

  for (const mode of ['pre', 'post'] as const) {
    test(`declarative HTML upgrade (${mode}-script) picks up carriers and active tab`, async ({ harness }) => {
      const viz = await harness.openDeclarative({ mode });

      const tabs = viz.locator('[part="tabs"] [role="tab"]');
      await expect(tabs).toHaveCount(3);
      await expect(tabs.nth(0)).toHaveText('Timeline');
      await expect(tabs.nth(1)).toHaveText('Flame');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(2)).toHaveText('Services');

      await expect(viz.locator('[part="flame"]')).toBeVisible();
      await expect(viz.locator('[part="flame"]').getByText('handleCheckout')).toBeVisible();
      await expect(viz.locator('[part="filter-bar"] [data-filter-field="spanName"]')).toBeVisible();
      await expect(viz.locator('[part="legend"]')).toBeVisible();
    });
  }

  test('live mutations on <trace-view> and <trace-filter> carriers update tabs and filter bar', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '520' },
      children: [{ tag: 'trace-view', attrs: { type: 'waterfall', label: 'Waterfall' } }],
      traceData: SAMPLE_TRACE,
    });

    // Single declared view keeps tab bar hidden
    await expect(viz.locator('[part="tabs"]')).toBeHidden();

    // Append a second view carrier and a filter carrier
    await page.evaluate(() => {
      const el = document.getElementById('viz');
      if (el === null) throw new Error('Missing #viz');
      const flame = document.createElement('trace-view');
      flame.setAttribute('type', 'flame');
      flame.setAttribute('label', 'Flame View');
      el.append(flame);

      const filter = document.createElement('trace-filter');
      filter.setAttribute('field', 'spanName');
      filter.setAttribute('label', 'Operation');
      filter.setAttribute('type', 'text');
      filter.setAttribute('source', 'local');
      el.append(filter);
    });

    const tabs = viz.locator('[part="tabs"] [role="tab"]');
    await expect(viz.locator('[part="tabs"]')).toBeVisible();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveText('Flame View');
    await expect(viz.locator('[part="filter-bar"] [data-filter-field="spanName"]')).toBeVisible();

    // Mutate label attribute on existing <trace-view> carrier
    await page.evaluate(() => {
      const view = document.querySelector('#viz trace-view[type="flame"]');
      view?.setAttribute('label', 'Renamed Flame');
    });
    await expect(tabs.nth(1)).toHaveText('Renamed Flame');

    // Remove second <trace-view> and <trace-filter> carriers
    await page.evaluate(() => {
      document.querySelector('#viz trace-view[type="flame"]')?.remove();
      document.querySelector('#viz trace-filter')?.remove();
    });
    await expect(viz.locator('[part="tabs"]')).toBeHidden();
    await expect(viz.locator('[part="filter-bar"]')).toBeHidden();
  });

  test('theme attributes, prefers-color-scheme, kind-colors, and --l2t-* tokens resolve in Shadow DOM', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '480', 'show-legend': '' },
      traceData: SAMPLE_TRACE,
    });

    const hostBg = (): Promise<string> =>
      viz.evaluate((el) => getComputedStyle(el).backgroundColor);

    // Default follows page preference (light)
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(hostBg).toBe('rgb(255, 255, 255)');

    // Follows dark prefers-color-scheme when theme is unset
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(hostBg).toBe('rgb(27, 29, 35)');

    // Explicit theme="light" overrides dark media preference
    await viz.evaluate((el) => el.setAttribute('theme', 'light'));
    await expect.poll(hostBg).toBe('rgb(255, 255, 255)');

    // Explicit theme="dark" overrides light media preference
    await page.emulateMedia({ colorScheme: 'light' });
    await viz.evaluate((el) => el.setAttribute('theme', 'dark'));
    await expect.poll(hostBg).toBe('rgb(27, 29, 35)');

    // Custom host CSS variable override + refreshTheme()
    await viz.evaluate((el) => {
      const host = el as HTMLElement & { refreshTheme(): void };
      host.style.setProperty('--l2t-color-background', 'rgb(12, 34, 56)');
      host.refreshTheme();
    });
    await expect.poll(hostBg).toBe('rgb(12, 34, 56)');

    // kind-colors attribute sets --l2t-color-kindServer on the host element
    await viz.evaluate((el) => el.setAttribute('kind-colors', '{"Server":"rgb(1, 2, 3)"}'));
    const kindServerVar = await viz.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--l2t-color-kindServer').trim(),
    );
    expect(kindServerVar).toBe('rgb(1, 2, 3)');

    // height and full-width layout attributes reflect on host box and classList
    const box = await viz.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box?.height ?? 0)).toBe(480);

    await viz.evaluate((el) => el.setAttribute('full-width', ''));
    await expect(viz).toHaveClass(/full-width/);
  });

  test('disconnecting and reconnecting <trace-visualizer> cleans up and remounts cleanly', async ({ page, harness }) => {
    await harness.openBlank();
    const viz = await harness.mount({
      attrs: { height: '480' },
      traceData: SAMPLE_TRACE,
    });

    await expect(waterfallRows(viz)).toHaveCount(5);

    await page.evaluate(() => {
      const el = document.getElementById('viz');
      const root = document.getElementById('root');
      if (el === null || root === null) throw new Error('Missing elements');
      el.remove();
      root.append(el);
    });

    await expect(waterfallRows(viz)).toHaveCount(5);
  });
});
