import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import {
  SAMPLE_LOGS,
  SAMPLE_TRACE,
  filterSampleTraceByService,
} from './fixtures.ts';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function blankPageHtml(bundle: 'dev' | 'min'): string {
  const src = bundle === 'min' ? '/dist/log2trace.min.js' : '/dist/log2trace.js';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>log2trace E2E Harness</title>',
    '  <style>body { margin: 0; padding: 16px; box-sizing: border-box; }</style>',
    `  <script type="module" src="${src}"></script>`,
    '</head>',
    '<body>',
    '  <div id="root"></div>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Server-rendered declarative HTML fixture to exercise real HTML parser upgrade order
 * without using innerHTML in test scripts.
 */
function declarativePageHtml(mode: 'pre' | 'post', bundle: 'dev' | 'min'): string {
  const src = bundle === 'min' ? '/dist/log2trace.min.js' : '/dist/log2trace.js';
  const scriptTag = `<script type="module" src="${src}"></script>`;
  const visualizerMarkup = [
    '<trace-visualizer',
    '  id="viz"',
    '  data-url="/fixtures/logs.json"',
    '  trace-id-field="traceId"',
    '  span-group-fields="service,action"',
    '  span-name-field="action"',
    '  service-name-field="service"',
    '  timestamp-field="timestamp"',
    '  status-code-field="status"',
    '  parent-span-lookup-fields="parentService"',
    '  show-legend',
    '  height="520"',
    '>',
    '  <trace-view type="waterfall" label="Timeline"></trace-view>',
    '  <trace-view type="flame" label="Flame" active></trace-view>',
    '  <trace-view type="service" label="Services"></trace-view>',
    '  <span-kind-rule match-field="layer" match-value="api" kind="Server"></span-kind-rule>',
    '  <span-kind-rule match-field="layer" match-value="client" kind="Client"></span-kind-rule>',
    '  <trace-filter field="spanName" label="Operation" type="text" source="local" debounce="20"></trace-filter>',
    '</trace-visualizer>',
  ].join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>log2trace Declarative Upgrade</title>',
    '  <style>body { margin: 0; padding: 16px; box-sizing: border-box; }</style>',
    mode === 'post' ? `  ${scriptTag}` : '',
    '</head>',
    '<body>',
    visualizerMarkup,
    mode === 'pre' ? `  ${scriptTag}` : '',
    '</body>',
    '</html>',
  ].join('\n');
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function createHarnessServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const { pathname, searchParams } = requestUrl;

      if (pathname === '/blank') {
        const bundle = searchParams.get('bundle') === 'min' ? 'min' : 'dev';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(blankPageHtml(bundle));
        return;
      }

      if (pathname === '/declarative') {
        const mode = searchParams.get('mode') === 'post' ? 'post' : 'pre';
        const bundle = searchParams.get('bundle') === 'min' ? 'min' : 'dev';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(declarativePageHtml(mode, bundle));
        return;
      }

      if (pathname === '/fixtures/trace.json') {
        sendJson(res, 200, SAMPLE_TRACE);
        return;
      }

      if (pathname === '/fixtures/logs.json') {
        sendJson(res, 200, SAMPLE_LOGS);
        return;
      }

      if (pathname === '/fixtures/slow-trace.json') {
        const delayMs = Math.min(2000, Math.max(50, Number(searchParams.get('delay') ?? '300')));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        sendJson(res, 200, SAMPLE_TRACE);
        return;
      }

      if (pathname === '/fixtures/search') {
        const service = searchParams.get('service') ?? '';
        sendJson(res, 200, filterSampleTraceByService(service));
        return;
      }

      if (pathname === '/fixtures/error') {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal server error');
        return;
      }

      if (pathname === '/fixtures/bad-json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{not valid json');
        return;
      }

      if (pathname.startsWith('/dist/')) {
        const rel = pathname.slice('/dist/'.length);
        const resolved = path.resolve(DIST_DIR, rel);
        if (!resolved.startsWith(DIST_DIR + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        try {
          const data = await fs.readFile(resolved);
          const ext = path.extname(resolved);
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
          res.end(data);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface CarrierSpec {
  readonly tag: 'trace-view' | 'trace-filter' | 'span-kind-rule';
  readonly attrs: Readonly<Record<string, string>>;
}

export interface MountOptions {
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly CarrierSpec[];
  readonly traceData?: unknown;
  readonly logData?: unknown;
  readonly id?: string;
}

export interface Harness {
  readonly baseUrl: string;
  openBlank(options?: { readonly bundle?: 'dev' | 'min' }): Promise<void>;
  openDeclarative(options?: { readonly mode?: 'pre' | 'post'; readonly bundle?: 'dev' | 'min' }): Promise<Locator>;
  mount(options?: MountOptions): Promise<Locator>;
  allowConsoleErrors(): void;
}

interface WorkerFixtures {
  readonly harnessServer: { readonly url: string };
}

interface TestFixtures {
  readonly harness: Harness;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  harnessServer: [
    async ({}, use) => {
      const server = await createHarnessServer();
      await use({ url: server.url });
      await server.close();
    },
    { scope: 'worker' },
  ],

  harness: async ({ page, harnessServer }, use) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let ignoreConsoleErrors = false;

    const onPageError = (error: Error): void => {
      pageErrors.push(error.message);
    };
    const onConsole = (msg: { type(): string; text(): string }): void => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    };

    page.on('pageerror', onPageError);
    page.on('console', onConsole);

    const openBlank = async (options?: { readonly bundle?: 'dev' | 'min' }): Promise<void> => {
      const bundle = options?.bundle ?? 'dev';
      await page.goto(`${harnessServer.url}/blank?bundle=${bundle}`);
      await page.evaluate(() => customElements.whenDefined('trace-visualizer'));
    };

    const openDeclarative = async (
      options?: { readonly mode?: 'pre' | 'post'; readonly bundle?: 'dev' | 'min' },
    ): Promise<Locator> => {
      const mode = options?.mode ?? 'pre';
      const bundle = options?.bundle ?? 'dev';
      await page.goto(`${harnessServer.url}/declarative?mode=${mode}&bundle=${bundle}`);
      await page.evaluate(() => customElements.whenDefined('trace-visualizer'));
      return page.locator('trace-visualizer#viz');
    };

    const mount = async (options: MountOptions = {}): Promise<Locator> => {
      const id = options.id ?? 'viz';
      await page.evaluate(
        ({ id: elId, attrs, children, traceData, logData }) => {
          const root = document.getElementById('root');
          if (root === null) throw new Error('Missing #root container');
          root.replaceChildren();

          const el = document.createElement('trace-visualizer') as HTMLElement & {
            traceData?: unknown;
            logData?: unknown;
          };
          el.id = elId;
          for (const [name, value] of Object.entries(attrs ?? {})) {
            el.setAttribute(name, value);
          }
          for (const childSpec of children ?? []) {
            const child = document.createElement(childSpec.tag);
            for (const [name, value] of Object.entries(childSpec.attrs)) {
              child.setAttribute(name, value);
            }
            el.append(child);
          }
          root.append(el);
          if (traceData !== undefined) el.traceData = traceData;
          if (logData !== undefined) el.logData = logData;
        },
        {
          id,
          attrs: options.attrs ?? { height: '520' },
          children: options.children ?? [],
          traceData: options.traceData,
          logData: options.logData,
        },
      );
      return page.locator(`trace-visualizer#${id}`);
    };

    await use({
      baseUrl: harnessServer.url,
      openBlank,
      openDeclarative,
      mount,
      allowConsoleErrors: () => {
        ignoreConsoleErrors = true;
      },
    });

    page.off('pageerror', onPageError);
    page.off('console', onConsole);

    expect(pageErrors, 'Expected no uncaught page errors').toEqual([]);
    if (!ignoreConsoleErrors) {
      expect(consoleErrors, 'Expected no console errors').toEqual([]);
    }
  },
});

export function waterfallRows(viz: Locator): Locator {
  return viz.locator('[role="tree"][aria-label="Spans"]').getByRole('treeitem');
}

/**
 * Click the visual center of a rendered element via page.mouse so views that place
 * a transparent scroll/input overlay (`[part="plot"]`) above painted rows receive
 * real pointer coordinates just as a user click does.
 */
export async function clickCenter(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (box === null) throw new Error('Target element has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Move the pointer to the visual center of a rendered element via page.mouse. */
export async function hoverCenter(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (box === null) throw new Error('Target element has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

export { expect, type Locator, type Page };
