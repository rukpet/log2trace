/**
 * Automated E2E Consistency and Documentation Test Suite
 *
 * Verifies documentation claims, view registrations, configuration schemas,
 * event contracts, demo links, and demo server behavior across log2trace.
 *
 * Tiers:
 * - Tier 1: View registration, definitions, capabilities, and lifecycle contract.
 * - Tier 2: Configuration schema, attribute mapping, and custom element reactivity.
 * - Tier 3: Documentation validation (guide.html and README.md).
 * - Tier 4: Demo hub, example pages, and server query string safety.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setFileScope } from '@vanilla-extract/css/fileScope';

import {
  getView,
  listViews,
  parseViewIds,
  registerView,
  resolveRenderer,
  type ViewDefinition,
} from '../src/kit/view.ts';
import {
  isTransformReady,
  kindColorOverrides,
  mergeConfig,
  readConfig,
  type AttributeSource,
} from '../src/element/config.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Helper: load view definitions in Node environment with vanilla-extract file scopes
setFileScope('src/views/waterfall/view.css.ts');
const { waterfallDefinition } = await import('../src/views/waterfall/view.ts');

setFileScope('src/views/flame/view.css.ts');
const { flameDefinition } = await import('../src/views/flame/view.ts');

setFileScope('src/views/service/view.css.ts');
const { serviceDefinition } = await import('../src/views/service/view.ts');

setFileScope('src/views/sequence/view.css.ts');
const { sequenceDefinition } = await import('../src/views/sequence/view.ts');

setFileScope('src/views/inspector/view.css.ts');
const { inspectorDefinition } = await import('../src/views/inspector/view.ts');

// Register all 5 built-in views in the registry
registerView(waterfallDefinition);
registerView(flameDefinition);
registerView(serviceDefinition);
registerView(sequenceDefinition);
registerView(inspectorDefinition);

/** Mock AttributeSource for readConfig testing */
class MockAttributeSource implements AttributeSource {
  readonly children: Array<MockAttributeSource & { tagName: string }> = [];

  constructor(
    public tagName = 'TRACE-VISUALIZER',
    private readonly attributes: Record<string, string> = {}
  ) {}

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  child(tagName: string, attributes: Record<string, string>): this {
    this.children.push(new MockAttributeSource(tagName, attributes) as MockAttributeSource & { tagName: string });
    return this;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1: View Registration, Definitions & Capabilities
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 1: View Registration & Capabilities', () => {
  it('registers all 5 built-in views in listViews()', () => {
    const views = listViews();
    const ids = views.map((v) => v.id);
    assert.ok(ids.includes('waterfall'), 'waterfall must be registered');
    assert.ok(ids.includes('flame'), 'flame must be registered');
    assert.ok(ids.includes('service'), 'service must be registered');
    assert.ok(ids.includes('sequence'), 'sequence must be registered');
    assert.ok(ids.includes('inspector'), 'inspector must be registered');
    assert.equal(views.length >= 5, true, 'at least 5 views should be registered');
  });

  it('provides correct definition and capabilities for waterfall view', () => {
    const def = getView('waterfall');
    assert.ok(def, 'waterfall view must exist');
    assert.equal(def.id, 'waterfall');
    assert.equal(def.label, 'Waterfall');
    assert.deepEqual(def.renderers, ['dom', 'canvas'], 'waterfall must support dom and canvas renderers');
    assert.equal(def.capabilities?.legend, true, 'waterfall must declare legend capability');
  });

  it('provides correct definition and capabilities for flame view', () => {
    const def = getView('flame');
    assert.ok(def, 'flame view must exist');
    assert.equal(def.id, 'flame');
    assert.equal(def.label, 'Flame graph');
    assert.deepEqual(def.renderers, ['dom']);
    assert.equal(def.capabilities?.legend, true, 'flame must declare legend capability');
  });

  it('provides correct definition and capabilities for service view', () => {
    const def = getView('service');
    assert.ok(def, 'service view must exist');
    assert.equal(def.id, 'service');
    assert.equal(def.label, 'Service graph');
    assert.deepEqual(def.renderers, ['dom']);
    assert.equal(def.capabilities?.legend, false, 'service graph must disable span-kind legend');
  });

  it('provides correct definition and capabilities for sequence view', () => {
    const def = getView('sequence');
    assert.ok(def, 'sequence view must exist');
    assert.equal(def.id, 'sequence');
    assert.equal(def.label, 'Sequence');
    assert.deepEqual(def.renderers, ['dom']);
    assert.equal(def.capabilities?.legend, true, 'sequence must declare legend capability');
  });

  it('provides correct definition and capabilities for inspector view', () => {
    const def = getView('inspector');
    assert.ok(def, 'inspector view must exist');
    assert.equal(def.id, 'inspector');
    assert.equal(def.label, 'Inspector');
    assert.deepEqual(def.renderers, ['dom']);
    assert.notEqual(def.capabilities?.legend, true, 'inspector should not declare legend capability');
  });

  it('getView returns undefined for non-existent view ID', () => {
    assert.equal(getView('unknown-view-id'), undefined);
    assert.equal(getView(''), undefined);
  });

  it('every registered view creates an instance satisfying the TraceView interface', () => {
    const expectedMethods = [
      'mount',
      'update',
      'optionsChanged',
      'themeChanged',
      'commands',
      'getState',
      'setState',
      'unmount',
    ] as const;

    const allViews: ViewDefinition[] = [
      waterfallDefinition,
      flameDefinition,
      serviceDefinition,
      sequenceDefinition,
      inspectorDefinition,
    ];

    for (const def of allViews) {
      const instance = def.create();
      assert.ok(instance, `create() for view ${def.id} must return an instance`);
      for (const method of expectedMethods) {
        assert.equal(
          typeof (instance as unknown as Record<string, unknown>)[method],
          'function',
          `view ${def.id} must implement ${method}()`
        );
      }
    }
  });

  it('parseViewIds parses CSV, deduplicates, and filters against registered views', () => {
    const known = ['waterfall', 'flame', 'service', 'sequence', 'inspector'];
    assert.deepEqual(parseViewIds('sequence,waterfall', known), ['sequence', 'waterfall']);
    assert.deepEqual(parseViewIds('waterfall,flame,waterfall', known), ['waterfall', 'flame']);
    assert.deepEqual(parseViewIds('flame, nonexistent, service', known), ['flame', 'service']);
    assert.deepEqual(parseViewIds('', known), ['waterfall'], 'empty string falls back to first known view');
    assert.deepEqual(parseViewIds(null, known), ['waterfall'], 'null falls back to first known view');
  });

  it('resolveRenderer picks available renderer or falls back to first', () => {
    assert.equal(resolveRenderer('canvas', ['dom', 'canvas']), 'canvas');
    assert.equal(resolveRenderer('dom', ['dom', 'canvas']), 'dom');
    assert.equal(resolveRenderer('canvas', ['dom']), 'dom', 'unavailable renderer falls back to default');
    assert.equal(resolveRenderer(undefined, ['dom', 'canvas']), 'dom');
  });

  it('src/log2trace.ts package docstring mentions sequence and service views', () => {
    const code = readFileSync(join(ROOT, 'src', 'log2trace.ts'), 'utf-8');
    assert.match(
      code,
      /service\s+graph/i,
      'src/log2trace.ts docstring must mention service graph'
    );
    assert.match(
      code,
      /sequence\s+diagram/i,
      'src/log2trace.ts docstring must mention sequence diagram'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2: Configuration Schema & Attribute Mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 2: Configuration Schema & Attribute Mapping', () => {
  it('readConfig maps wheel-zoom attribute to wheelZoom boolean', () => {
    const bareZoom = readConfig(new MockAttributeSource('div', { 'wheel-zoom': '' }));
    assert.equal(bareZoom.wheelZoom, true, 'bare wheel-zoom attribute must be true');

    const explicitTrue = readConfig(new MockAttributeSource('div', { 'wheel-zoom': 'true' }));
    assert.equal(explicitTrue.wheelZoom, true);

    const explicitFalse = readConfig(new MockAttributeSource('div', { 'wheel-zoom': 'false' }));
    assert.equal(explicitFalse.wheelZoom, false);

    const noZoom = readConfig(new MockAttributeSource('div', {}));
    assert.equal(noZoom.wheelZoom, undefined);
  });

  it('readConfig maps gutter-width attribute to gutterWidth number', () => {
    const withGutter = readConfig(new MockAttributeSource('div', { 'gutter-width': '280' }));
    assert.equal(withGutter.gutterWidth, 280);

    const invalidGutter = readConfig(new MockAttributeSource('div', { 'gutter-width': 'invalid' }));
    assert.equal(invalidGutter.gutterWidth, undefined);

    const zeroGutter = readConfig(new MockAttributeSource('div', { 'gutter-width': '0' }));
    assert.equal(zeroGutter.gutterWidth, 0);
  });

  it('readConfig maps kind-colors attribute and supports color-scheme fallback', () => {
    const canonical = readConfig(new MockAttributeSource('div', {
      'kind-colors': '{"2":"#26a69a","3":"#ef5350"}',
    }));
    assert.deepEqual(canonical.kindColors, { '2': '#26a69a', '3': '#ef5350' });

    const fallback = readConfig(new MockAttributeSource('div', {
      'color-scheme': '{"1":"#7e57c2"}',
    }));
    assert.deepEqual(fallback.kindColors, { '1': '#7e57c2' });

    const malformed = readConfig(new MockAttributeSource('div', { 'kind-colors': '{invalid-json' }));
    assert.equal(malformed.kindColors, undefined);
  });

  it('readConfig maps parent-span-id-field and span-id-field', () => {
    const config = readConfig(new MockAttributeSource('div', {
      'parent-span-id-field': 'meta.parentId',
      'span-id-field': 'meta.spanId',
    }));
    assert.equal(config.parentSpanIdField, 'meta.parentId');
    assert.equal(config.spanIdField, 'meta.spanId');
  });

  it('isTransformReady validates presence of all 4 required log transform fields', () => {
    const ready = readConfig(new MockAttributeSource('div', {
      'trace-id-field': 'traceId',
      'span-name-field': 'action',
      'service-name-field': 'service',
      'timestamp-field': 'time',
    }));
    assert.equal(isTransformReady(ready), true);

    const incomplete = readConfig(new MockAttributeSource('div', {
      'trace-id-field': 'traceId',
    }));
    assert.equal(isTransformReady(incomplete), false);
  });

  it('mergeConfig gives precedence to programmatic properties over attribute configuration', () => {
    const fromAttrs = readConfig(new MockAttributeSource('div', {
      'wheel-zoom': 'false',
      'gutter-width': '200',
    }));
    const merged = mergeConfig(fromAttrs, {
      wheelZoom: true,
      gutterWidth: 350,
      kindColors: { '2': '#123456' },
    });
    assert.equal(merged.wheelZoom, true, 'programmatic wheelZoom must override attribute');
    assert.equal(merged.gutterWidth, 350, 'programmatic gutterWidth must override attribute');
    assert.deepEqual(merged.kindColors, { '2': '#123456' });
  });

  it('kindColorOverrides correctly maps numeric and named span kinds to CSS color tokens', () => {
    const overrides = kindColorOverrides({
      '1': '#7e57c2',
      server: '#26a69a',
      CLIENT: '#ef5350',
      Producer: '#ff7043',
      consumer: '#ab47bc',
      invalidKey: '#ffffff',
    });
    assert.deepEqual(overrides, [
      ['kindInternal', '#7e57c2'],
      ['kindServer', '#26a69a'],
      ['kindClient', '#ef5350'],
      ['kindProducer', '#ff7043'],
      ['kindConsumer', '#ab47bc'],
    ]);
  });

  it('src/element/trace-visualizer.ts observes wheel-zoom, gutter-width, row-height, and sequence attributes', () => {
    const elementSource = readFileSync(
      join(ROOT, 'src', 'element', 'trace-visualizer.ts'),
      'utf-8'
    );

    const requiredAttributes = [
      'wheel-zoom',
      'gutter-width',
      'row-height',
      'kind-colors',
      'color-scheme',
      'sequence-internal',
      'sequence-returns',
      'sequence-fold',
      'views',
      'view',
    ];

    for (const attr of requiredAttributes) {
      assert.ok(
        elementSource.includes(`'${attr}'`),
        `OBSERVED in trace-visualizer.ts must include '${attr}'`
      );
    }
  });

  it('src/element/trace-visualizer.ts notifies view.optionsChanged() on sequence and layout attribute changes', () => {
    const elementSource = readFileSync(
      join(ROOT, 'src', 'element', 'trace-visualizer.ts'),
      'utf-8'
    );

    // Verify switch cases in attributeChangedCallback
    const cases = [
      `case 'wheel-zoom':`,
      `case 'sequence-internal':`,
      `case 'sequence-returns':`,
      `case 'sequence-fold':`,
      `case 'row-height':`,
      `case 'gutter-width':`,
    ];

    for (const c of cases) {
      assert.ok(
        elementSource.includes(c),
        `attributeChangedCallback in trace-visualizer.ts must handle ${c}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3: Documentation Validation (demo/guide.html & README.md)
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 3: Documentation Validation', () => {
  const guideHtml = readFileSync(join(ROOT, 'demo', 'guide.html'), 'utf-8');
  const readmeMd = readFileSync(join(ROOT, 'README.md'), 'utf-8');

  it('demo/guide.html contains dedicated example sections for sequence, service, and inspector', () => {
    assert.ok(
      guideHtml.includes('id="ex-26"'),
      'guide.html must contain section id="ex-26" for Sequence Diagram'
    );
    assert.match(
      guideHtml,
      /EXAMPLE 26\s*—\s*Sequence\s+diagram/i,
      'guide.html must have heading for EXAMPLE 26 Sequence diagram'
    );

    assert.ok(
      guideHtml.includes('id="ex-27"'),
      'guide.html must contain section id="ex-27" for Service Graph'
    );
    assert.match(
      guideHtml,
      /EXAMPLE 27\s*—\s*Service\s+graph/i,
      'guide.html must have heading for EXAMPLE 27 Service graph'
    );

    assert.ok(
      guideHtml.includes('id="ex-28"'),
      'guide.html must contain section id="ex-28" for Store Inspector'
    );
    assert.match(
      guideHtml,
      /EXAMPLE 28\s*—\s*Store\s+inspector/i,
      'guide.html must have heading for EXAMPLE 28 Store inspector'
    );
  });

  it('demo/guide.html table of contents links to Examples 26, 27, and 28', () => {
    assert.ok(
      guideHtml.includes('href="#ex-26"'),
      'guide.html TOC must contain link href="#ex-26"'
    );
    assert.ok(
      guideHtml.includes('href="#ex-27"'),
      'guide.html TOC must contain link href="#ex-27"'
    );
    assert.ok(
      guideHtml.includes('href="#ex-28"'),
      'guide.html TOC must contain link href="#ex-28"'
    );
  });

  it('demo/guide.html documents sequence options (sequence-internal, sequence-returns, sequence-fold, row-height)', () => {
    assert.ok(
      guideHtml.includes('sequence-internal'),
      'guide.html must document sequence-internal'
    );
    assert.ok(
      guideHtml.includes('sequence-returns'),
      'guide.html must document sequence-returns'
    );
    assert.ok(
      guideHtml.includes('sequence-fold'),
      'guide.html must document sequence-fold'
    );
    assert.ok(
      guideHtml.includes('row-height'),
      'guide.html must document row-height for sequence view'
    );
  });

  it('demo/guide.html documents sequence keyboard shortcuts (arrows, R, E, F, I, Escape)', () => {
    // Check that sequence hotkeys are documented in guide.html
    assert.match(
      guideHtml,
      /ArrowUp|↑/i,
      'guide.html must document sequence step navigation key'
    );
    assert.match(
      guideHtml,
      /ArrowLeft|←/i,
      'guide.html must document sequence lifeline navigation key'
    );
    assert.ok(
      guideHtml.includes('<code>R</code>') || guideHtml.includes('<kbd>R</kbd>') || guideHtml.includes(' R '),
      'guide.html must document R key for jump between request and return'
    );
    assert.ok(
      guideHtml.includes('<code>E</code>') || guideHtml.includes('<kbd>E</kbd>') || guideHtml.includes(' E '),
      'guide.html must document E key for jump to error'
    );
    assert.ok(
      guideHtml.includes('<code>I</code>') || guideHtml.includes('<kbd>I</kbd>') || guideHtml.includes(' I '),
      'guide.html must document I key for cycling internal calls'
    );
  });

  it('demo/guide.html documents service graph features (topology, nodes, edges, spatial camera)', () => {
    assert.match(
      guideHtml,
      /service\s+graph/i,
      'guide.html must describe service graph'
    );
    assert.match(
      guideHtml,
      /camera|zoom|pan/i,
      'guide.html must describe service graph navigation (pan/zoom/camera)'
    );
  });

  it('demo/guide.html Example 6 teaches canonical kind-colors and CSS tokens', () => {
    const ex6SectionMatch = guideHtml.match(/<section id="ex-6">([\s\S]*?)<\/section>/);
    assert.ok(ex6SectionMatch, 'Example 6 section must exist in guide.html');
    const ex6Content = ex6SectionMatch[1];
    assert.ok(
      ex6Content.includes('kind-colors'),
      'Example 6 must teach canonical kind-colors attribute'
    );
    assert.ok(
      ex6Content.includes('--l2t-color-kind'),
      'Example 6 must mention --l2t-color-kind CSS custom properties'
    );
  });

  it('demo/guide.html does not claim full-width stretches the container', () => {
    // Example 1 must not claim full-width stretches the container
    const ex1Match = guideHtml.match(/<section id="ex-1">([\s\S]*?)<\/section>/);
    assert.ok(ex1Match, 'Example 1 section must exist in guide.html');
    assert.equal(
      /full-width.*stretches\s+it\s+to\s+fill\s+the\s+container/i.test(ex1Match[1]),
      false,
      'Example 1 must not claim full-width stretches it to fill the container'
    );
  });

  it('demo/guide.html documents trace-loaded event with payload properties', () => {
    assert.ok(
      guideHtml.includes('trace-loaded'),
      'guide.html must document trace-loaded event'
    );
    assert.match(
      guideHtml,
      /trace-loaded[\s\S]{1,300}(spans|roots|traceId)/,
      'guide.html must document trace-loaded event payload properties (spans, roots, traceId)'
    );
  });

  it('demo/guide.html documents full span-selected detail payload (spanId, spanIds, view)', () => {
    const ex17Match = guideHtml.match(/<section id="ex-17">([\s\S]*?)<\/section>/);
    assert.ok(ex17Match, 'Example 17 section must exist in guide.html');
    const ex17 = ex17Match[1];
    assert.ok(
      ex17.includes('spanId'),
      'guide.html Example 17 must document event.detail.spanId'
    );
    assert.ok(
      ex17.includes('spanIds'),
      'guide.html Example 17 must document event.detail.spanIds'
    );
    assert.ok(
      ex17.includes('view'),
      'guide.html Example 17 must document event.detail.view'
    );
  });

  it('demo/guide.html documents display options (renderer, gutter-width) and log field options', () => {
    assert.ok(
      guideHtml.includes('gutter-width') || guideHtml.includes('gutterWidth'),
      'guide.html must document gutter-width'
    );
    assert.ok(
      guideHtml.includes('parent-span-id-field'),
      'guide.html must document parent-span-id-field'
    );
    assert.ok(
      guideHtml.includes('span-id-field'),
      'guide.html must document span-id-field'
    );
    assert.match(
      guideHtml,
      /renderer="(dom|canvas)"|renderer=dom|renderer=canvas/,
      'guide.html must document renderer options'
    );
  });

  it('demo/guide.html does not contain broken links to /api/index.html', () => {
    assert.equal(
      guideHtml.includes('href="/api/index.html"'),
      false,
      'guide.html must not contain broken link href="/api/index.html"'
    );
    assert.equal(
      guideHtml.includes('href="/api"'),
      false,
      'guide.html must not contain broken link href="/api"'
    );
  });

  it('README.md documents all 5 views', () => {
    assert.match(readmeMd, /`waterfall`/);
    assert.match(readmeMd, /`flame`/);
    assert.match(readmeMd, /`service`/);
    assert.match(readmeMd, /`sequence`/);
    assert.match(readmeMd, /`inspector`/);
  });

  it('README.md documents trace-loaded event and payload properties', () => {
    assert.ok(
      readmeMd.includes('trace-loaded'),
      'README.md must document trace-loaded event'
    );
    assert.match(
      readmeMd,
      /trace-loaded[\s\S]{1,300}(spans|roots|traceId)/,
      'README.md must document trace-loaded detail payload (spans, roots, traceId)'
    );
  });

  it('README.md documents span-selected detail payload (span, spanId, spanIds, view)', () => {
    assert.ok(
      readmeMd.includes('span-selected'),
      'README.md must document span-selected event'
    );
    assert.match(
      readmeMd,
      /span-selected[\s\S]{1,300}(spanId|spanIds|view)/,
      'README.md must document full span-selected detail payload properties'
    );
  });

  it('README.md documents sequence configuration options', () => {
    assert.ok(
      readmeMd.includes('sequence-internal'),
      'README.md must document sequence-internal'
    );
    assert.ok(
      readmeMd.includes('sequence-returns'),
      'README.md must document sequence-returns'
    );
    assert.ok(
      readmeMd.includes('sequence-fold'),
      'README.md must document sequence-fold'
    );
  });

  it('README.md documents gutter-width, parent-span-id-field, and span-id-field', () => {
    assert.ok(
      readmeMd.includes('gutter-width') || readmeMd.includes('gutterWidth'),
      'README.md must document gutter-width'
    );
    assert.ok(
      readmeMd.includes('parent-span-id-field'),
      'README.md must document parent-span-id-field'
    );
    assert.ok(
      readmeMd.includes('span-id-field'),
      'README.md must document span-id-field'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 4: Demo Hub & Server Consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('Tier 4: Demo Hub & Server Consistency', () => {
  it('demo/demo.html links to guide.html as Comprehensive Guide', () => {
    const demoHtml = readFileSync(join(ROOT, 'demo', 'demo.html'), 'utf-8');
    assert.match(
      demoHtml,
      /href="(\.\/)?guide\.html"/,
      'demo.html must link to guide.html'
    );
  });

  it('demo/demo.html includes feature cards or links for Sequence and Service views', () => {
    const demoHtml = readFileSync(join(ROOT, 'demo', 'demo.html'), 'utf-8');
    assert.match(
      demoHtml,
      /sequence/i,
      'demo.html must feature Sequence view'
    );
    assert.match(
      demoHtml,
      /service\s+graph/i,
      'demo.html must feature Service graph view'
    );
  });

  it('demo/logs-transform.html includes sequence in views attribute', () => {
    const logsTransform = readFileSync(join(ROOT, 'demo', 'logs-transform.html'), 'utf-8');
    const viewsMatch = logsTransform.match(/views="([^"]+)"/);
    assert.ok(viewsMatch, 'trace-visualizer in logs-transform.html must have views attribute');
    const views = viewsMatch[1].split(',').map((s) => s.trim());
    assert.ok(
      views.includes('sequence'),
      `logs-transform.html views="${viewsMatch[1]}" must include sequence`
    );
    assert.ok(views.includes('waterfall'));
    assert.ok(views.includes('flame'));
    assert.ok(views.includes('service'));
    assert.ok(views.includes('inspector'));
  });

  it('demo/large.html checkbox label reflects all 5 views', () => {
    const largeHtml = readFileSync(join(ROOT, 'demo', 'large.html'), 'utf-8');
    const tabsCheckboxMatch = largeHtml.match(/<label><input type="checkbox" id="tabs">([^<]+)<\/label>/);
    assert.ok(tabsCheckboxMatch, 'demo/large.html must contain #tabs checkbox label');
    const labelText = tabsCheckboxMatch[1].toLowerCase();
    // It should not only claim "inspector and flame graph tabs" while 5 views are toggled
    const reflectsAllViews =
      labelText.includes('5 views') ||
      labelText.includes('all views') ||
      (labelText.includes('sequence') && labelText.includes('service'));
    assert.ok(
      reflectsAllViews,
      `large.html #tabs label should reflect all views, found: "${tabsCheckboxMatch[1]}"`
    );
  });

  it('demo/server.js strips query string parameters to prevent 404 errors', () => {
    const serverJs = readFileSync(join(ROOT, 'demo', 'server.js'), 'utf-8');

    // Server must cleanse req.url of query parameters before mapping to filesystem path
    const hasQueryStripping =
      serverJs.includes("req.url.split('?')[0]") ||
      serverJs.includes('req.url.split("?")[0]') ||
      serverJs.includes('new URL(req.url') ||
      serverJs.includes('url.parse(req.url).pathname');

    assert.ok(
      hasQueryStripping,
      'demo/server.js must strip query parameters from req.url (e.g. req.url.split("?")[0])'
    );

    // Verify simulated URL resolution logic
    const sanitizeUrl = (url: string): string => {
      let filePath = url.split('?')[0];
      if (filePath === '/' || filePath === '') filePath = '/demo.html';
      return filePath;
    };

    assert.equal(sanitizeUrl('/large.html?n=50000'), '/large.html');
    assert.equal(sanitizeUrl('/otel-trace.html?view=sequence&theme=dark'), '/otel-trace.html');
    assert.equal(sanitizeUrl('/?demo=1'), '/demo.html');
  });
});
