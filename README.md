# log2trace-ui

[![npm version](https://img.shields.io/npm/v/log2trace-ui.svg)](https://www.npmjs.com/package/log2trace-ui)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Zero-dependency Web Component that renders OpenTelemetry traces with built-in log-to-trace transformation.

[**Interactive Guide**](https://rukpet.github.io/log2trace/guide.html) &middot;
[**API Reference**](https://rukpet.github.io/log2trace/api/)

---

## What It Is

Most distributed systems already produce structured logs. Tools like Jaeger, Zipkin, and Grafana Tempo visualize traces, but they require adopting new collector infrastructure, exporting data to external backends, and instrumenting services with tracing SDKs.

**Log2Trace** takes a different approach: visualize traces client-side directly in the browser—with zero backend dependencies. It works in two modes:

1. **Native OpenTelemetry traces**: Pass pre-collected OTel `TraceData` JSON directly to `<trace-visualizer>`.
2. **Log-to-trace transformation**: Pass raw logs in any JSON schema. Define a field mapping once via HTML attributes (or JavaScript), and the component groups, timestamps, correlates parent-child hierarchies, and structures spans automatically.

---

## Installation

### Via CDN (no build step)

```html
<script type="module" src="https://unpkg.com/log2trace-ui/dist/log2trace.js"></script>
```

### Via npm

```sh
npm install log2trace-ui
```

---

## Quick Start

### 1. View Existing OpenTelemetry Traces

If you already have standard OpenTelemetry trace data:

```html
<trace-visualizer data-url="./trace.json"></trace-visualizer>
```

### 2. Transform Raw Logs into Traces

Point the element at an array of JSON log records and describe your schema with dot-paths:

```html
<trace-visualizer
  data-url="./logs.json"
  trace-id-field="correlationId"
  span-group-fields="service,operation"
  span-name-field="operation"
  service-name-field="service"
  timestamp-field="timestamp"
  status-code-field="errorCode"
  parent-span-lookup-fields="calledBy"
  show-legend
></trace-visualizer>
```

Each original log line is preserved as an OpenTelemetry event on its corresponding span, so clicking any span reveals the underlying log entries.

---

## Multi-View Visualization

`<trace-visualizer>` renders one view at a time or provides switchable tabs when multiple views are specified in `views`. All views share a single synchronized store for selection, hover, time windows, and filtering:

```html
<trace-visualizer
  views="waterfall,flame,service,sequence"
  view="waterfall"
  data-url="./logs.json"
  ...
></trace-visualizer>
```

* **`waterfall`** *(default)*: Timeline displaying spans horizontally in execution order. Supports collapsing/expanding subtrees, synchronized tooltips, and time-range scrubbing.
* **`flame`**: Flame graph aggregating cumulative execution time across identical call paths. Identifies bottlenecks answering *"where did the time go"*.
* **`service`**: Directed topology graph displaying services, external peers (databases, queues, HTTP endpoints), request counts, latencies, and error rates.
* **`sequence`**: Causal sequence diagram with participant lifelines, synchronous request/response pairs, asynchronous message flows, and loop folding.
* **`inspector`**: Shared store state inspector table, exposing raw reactive store events and spans.

Custom views can also be registered at runtime with `registerView()`.

---

## Declarative Filters & Span Classification

Customize filtering and span metadata directly in HTML using child elements:

```html
<trace-visualizer data-url="./logs.json" ...>
  <!-- Classify span kinds based on log properties -->
  <span-kind-rule match-field="layer" match-value="controller" kind="Server"></span-kind-rule>
  <span-kind-rule match-field="layer" match-value="client" kind="Client"></span-kind-rule>
  <span-kind-rule match-field="worker" match-value="queue-consumer" kind="Consumer"></span-kind-rule>

  <!-- Interactive filter bar inputs -->
  <trace-filter field="*" label="Search" type="text" source="local" placeholder="Search all fields..."></trace-filter>
  <trace-filter field="service" label="Service" type="select" source="local" options-source="auto"></trace-filter>
  <trace-filter field="hasError" label="Errors Only" type="checkbox" source="local"></trace-filter>
</trace-visualizer>
```

---

## Configuration

The component is configured via HTML attributes or programmatically via the JavaScript `config` property. Attribute names use `kebab-case` and map to `camelCase` configuration object properties.

### Display and View Options

| Attribute | Property | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `views` | `views` | `string` | `'waterfall'` | Comma-separated list of view IDs to enable in tabs (`waterfall`, `flame`, `service`, `sequence`, `inspector`). |
| `view` | `view` | `string` | `'waterfall'` | Active view ID shown on mount. |
| `renderer` | `renderer` | `'dom' \| 'canvas'` | `'dom'` | Waterfall rendering engine (`'dom'` for selectable DOM rows, `'canvas'` for Canvas 2D). |
| `theme` | `theme` | `'auto' \| 'light' \| 'dark'` | `'auto'` | Visual theme. By default follows system/page theme. |
| `height` | `height` | `number` | `480` | Element height in pixels. |
| `span-height` | `spanHeight` | `number` | `20` | Waterfall span bar height in CSS pixels. |
| `span-padding` | `spanPadding` | `number` | `4` | Vertical spacing between waterfall rows in CSS pixels. |
| `gutter-width` | `gutterWidth` | `number` | `250` | Width of the waterfall label column/gutter in CSS pixels. |
| `row-height` | `rowHeight` | `number` | `28` | Row height for sequence diagram in CSS pixels (clamped between 18 and 48). |
| `wheel-zoom` | `wheelZoom` | `boolean` | `false` | When true, mouse wheel zooms the time/density axis instead of scrolling. |
| `show-legend` | `showLegend` | `boolean` | `false` | Show span kind color legend in views that support it. |
| `full-width` | `fullWidth` | `boolean` | `true` | Stretch to container width (the element fills container width by default). |
| `detail-panel-width` | `detailPanelWidth` | `string` | `undefined` | CSS width of the side span detail panel (e.g., `'360px'`). |
| `kind-colors` | `kindColors` | `Record<string, string>` | `undefined` | Map of span kinds to CSS colors (e.g., `{"Server": "#2563eb"}`). |
| `auto-fetch` | `autoFetch` | `boolean` | `true` | Whether external filter changes trigger data fetch immediately. |
| `sequence-internal` | `sequenceInternal` | `'auto' \| 'hide' \| 'show'` | `'auto'` | How internal spans within the same service are shown in the sequence diagram. |
| `sequence-returns` | `sequenceReturns` | `'all' \| 'errors' \| 'none'` | `'all'` | Which synchronous return arrows are drawn in the sequence diagram. |
| `sequence-fold` | `sequenceFold` | `number` | `3` | Minimum consecutive identical sibling calls to fold into a `loop ×N` row; `0` disables folding. |

### Log Transform Options

Configure how raw log records are mapped and transformed into OpenTelemetry spans:

| Attribute | Property | Type | Description |
|-----------|----------|------|-------------|
| `data-url` | `dataUrl` | `string` | URL to fetch trace or log JSON data from. |
| `trace-id-field` | `traceIdField` | `string` | Dot-path to trace identifier in log records (required). |
| `span-group-fields` | `spanGroupFields` | `string \| string[]` | Comma-separated dot-paths to cluster log records into distinct spans (e.g., `'service,operation'`). |
| `span-name-field` | `spanNameField` | `string` | Dot-path to span operation or method name (required). |
| `service-name-field` | `serviceNameField` | `string` | Dot-path to service name (required). |
| `timestamp-field` | `timestampField` | `string` | Dot-path to start timestamp (ISO 8601 string or numeric ms/ns, required). |
| `end-time-field` | `endTimeField` | `string` | Dot-path to end timestamp (optional; computed from subsequent logs if omitted). |
| `parent-span-id-field` | `parentSpanIdField` | `string` | Dot-path to direct parent span ID if log records already contain explicit span identifiers. |
| `parent-span-lookup-fields` | `parentSpanLookupFields` | `string \| string[]` | Comma-separated dot-paths matched against other span groups to establish parent-child hierarchy (e.g., `'calledBy'`). |
| `span-id-field` | `spanIdField` | `string` | Dot-path to unique span identifier in log records. |
| `status-code-field` | `statusCodeField` | `string` | Dot-path to HTTP or status code (status >= 400 or `"ERROR"` marks span as error). |
| `default-span-kind` | `defaultSpanKind` | `string` | Default fallback span kind (`'INTERNAL'`, `'SERVER'`, `'CLIENT'`, `'PRODUCER'`, `'CONSUMER'`). |

---

## Events

`<trace-visualizer>` dispatches standard DOM CustomEvents that bubble and are composed across shadow DOM boundaries.

### `trace-loaded`

Fired when trace data is loaded, transformed, and indexed into the store.

- **Detail payload**: `{ spans: number, roots: number, traceId: string }`
  - `spans`: Total number of spans in the trace index.
  - `roots`: Number of root spans (spans without parents).
  - `traceId`: The trace identifier string.

```js
const visualizer = document.querySelector('trace-visualizer');
visualizer.addEventListener('trace-loaded', (e) => {
  const { spans, roots, traceId } = e.detail;
  console.log(`Loaded trace ${traceId} with ${spans} spans (${roots} root spans)`);
});
```

### `span-selected`

Fired when a user selects a span via mouse click or keyboard navigation (does not fire on programmatic `selectSpan()`).

- **Detail payload**: `{ span: Span, spanId: string, spanIds: string[], view: string }`
  - `span`: The primary selected OpenTelemetry span object.
  - `spanId`: ID of the primary selected span.
  - `spanIds`: Array of all currently selected span IDs.
  - `view`: ID of the view where selection occurred (`waterfall`, `flame`, `service`, `sequence`, `inspector`).

```js
visualizer.addEventListener('span-selected', (e) => {
  const { span, spanId, spanIds, view } = e.detail;
  console.log(`Selected span ${span.name} (${spanId}) in view "${view}"`);
});
```

### `view-changed`

Fired when switching between active views.

- **Detail payload**: `{ view: string, previous: string }`
  - `view`: The newly active view ID.
  - `previous`: The previously active view ID.

```js
visualizer.addEventListener('view-changed', (e) => {
  const { view, previous } = e.detail;
  console.log(`Switched view from ${previous} to ${view}`);
});
```

---

## Programmatic JavaScript API

Control the element or feed data dynamically from JavaScript/TypeScript:

```ts
import 'log2trace-ui';

const visualizer = document.querySelector('trace-visualizer');

// Provide OTel trace directly
visualizer.traceData = myOtelJson;

// Or feed raw logs with a transformation config
visualizer.logData = {
  logs: myLogsArray,
  config: {
    traceIdField: 'correlationId',
    spanNameField: 'operation',
    serviceNameField: 'service',
    timestampField: 'timestamp',
  },
};

// Programmatic navigation & selection
visualizer.selectSpan('span-id-123', { reveal: true });
visualizer.expandAll();
visualizer.collapseAll();
visualizer.setTimeWindow({ startMs: 100, endMs: 800 });

// Listen to events
visualizer.addEventListener('span-selected', (event) => {
  console.log('Selected span:', event.detail.span);
});
```

---

## Upgrading from 1.0.0-RC2

1.0.0-RC3 rebuilds the drawing layer; the data side is unchanged. Markup, the data attributes, `<trace-filter>`, `<span-kind-rule>`, `traceData`, `logData`, `config`, `fetchCallback`, `loadTraceData()` and `loadAndTransform()` work as before. What changed:

- The wheel scrolls instead of zooming; use `wheel-zoom` for the old behaviour.
- The `width` and `background-color` attributes are gone: size and colour the element with CSS (`style="width: 700px; --l2t-color-background: #f8f9ff"`). `full-width` is accepted and does nothing, because the element always fills its container. The element is 480 px tall unless you set `height`.
- `color-scheme` still works; `kind-colors` is its new name. Span-kind colours can also be set with the `--l2t-color-kindServer`-style custom properties (`kindInternal`, `kindClient`, …).
- The `virtual-scroll-activated` event is gone: rows are always virtualized.
- `span-selected` fires only for the user's own clicks and keys, not for `selectSpan()`.
- New: `views` and `view` attributes (tabs), the `flame` (Flame graph), `service` (Service graph), `sequence` (Sequence diagram), and `inspector` views (see Views above), the `view-changed` event, and `registerView()` for views of your own.
- The exports `TraceViewModel`, `Template`, `resolveDisplayDefaults`, `DisplayConfig` and `ViewSpan` are removed. `TraceVisualizerConfig` remains (without the removed display fields). The headless functions (`transformLogs`, `buildSpanIndex`, `matchSpans`, …) are unchanged.
- The inner DOM changed (`[data-role]` hooks and the old class names are gone); style through the custom properties and the exposed `part` names (`root`, `plot`, `filter-bar`, `legend`).

---

## How the Transformation Works

`transformLogs(logs, config)` converts arbitrary log arrays into OpenTelemetry `TraceData` in five phases:

1. **Group by trace ID**: Clusters records sharing the `traceIdField`.
2. **Group into spans**: Sub-clusters logs within each trace by composite `spanGroupFields`.
3. **Build span objects**: Extracts timestamps (`timestampField`, `endTimeField`), status codes, operation names, and maps all log fields to OTel span attributes.
4. **Resolve call hierarchy**: Links parent-child relationships using `parentSpanIdField` or matches `parentSpanLookupFields` against sibling span groups.
5. **Structure by service**: Organizes spans into `ResourceSpans → ScopeSpans → Spans` following the OpenTelemetry specification.

---

## License

[MIT](LICENSE)
