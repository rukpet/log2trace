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

`<trace-visualizer>` renders one view at a time or provides switchable tabs when child `<trace-view>` elements are declared (`active` specifies which view is shown initially). All views share a single synchronized store for selection, hover, time windows, and filtering:

```html
<trace-visualizer data-url="./logs.json">
  <trace-view type="waterfall" active></trace-view>
  <trace-view type="flame"></trace-view>
  <trace-view type="service"></trace-view>
  <trace-view type="sequence"></trace-view>
</trace-visualizer>
```

* **`waterfall`** *(default)*: Timeline displaying spans horizontally in execution order. Supports collapsing/expanding subtrees, synchronized tooltips, and time-range scrubbing.
* **`flame`**: Flame graph aggregating cumulative execution time across identical call paths. Identifies bottlenecks answering *"where did the time go"*.
* **`service`**: Directed topology graph displaying services, external peers (databases, queues, HTTP endpoints), request counts, latencies, and error rates.
* **`sequence`**: Causal sequence diagram with participant lifelines, synchronous request/response pairs, asynchronous message flows, and loop folding.

> [!NOTE]
> **Migration note**: The `views="a,b"` attribute is deprecated in favor of declarative child `<trace-view type="a"></trace-view>` elements. The `inspector` view has been removed.

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
