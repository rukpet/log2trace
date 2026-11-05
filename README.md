# log2trace-ui

[![npm version](https://img.shields.io/npm/v/log2trace-ui.svg)](https://www.npmjs.com/package/log2trace-ui)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Zero-dependency Web Component that renders OpenTelemetry traces as an interactive waterfall timeline, with built-in log-to-trace transformation.

## What it is

Most distributed systems already produce logs. Tools like Jaeger, Zipkin, and Grafana Tempo can visualize traces, but they require adopting new infrastructure, exporting data to an external platform, and instrumenting each service. Log2Trace takes a different approach: transform the logs you already have.

`<trace-visualizer>` is a custom HTML element that reads raw log records, applies a configurable field mapping to discover trace structure, and renders an interactive waterfall timeline — all client-side. Data never leaves the browser.

The element accepts logs in any JSON shape. You describe your log schema once via HTML attributes (or a JavaScript config object), and the component handles grouping, hierarchy, timing, and layout automatically.

## Installation

**Via CDN** (no build step required):

```html
<script type="module" src="https://unpkg.com/log2trace-ui@1.0.0-RC4/dist/log2trace.js"></script>
```

**Via npm**:

```sh
npm install log2trace-ui
```

## Quick Start

Add the element to any HTML page and point it at your log data:

```html
<script type="module" src="https://unpkg.com/log2trace-ui@1.0.0-RC4/dist/log2trace.js"></script>

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

Each attribute is a dot-path into your log records (e.g. `text.Application`, `resource.attributes.host` for nested fields). The component groups logs into traces, builds a span hierarchy from parent references, and renders the result as a zoomable, pannable waterfall.

You can also configure the component and feed data programmatically via the JavaScript API — see the [Interactive Demo Guide](https://rukpet.github.io/log2trace/guide.html) for live examples, or the [API Reference](https://rukpet.github.io/log2trace/api/) for full type documentation.

## Performance and rendering

This release is built for large traces: about 50,000 spans in one diagram, with smooth zoom and pan and instant hover, selection and collapse. The element draws only the rows in view, with one of two painters behind the same model:

- `renderer="dom"` (what `auto` picks today): a small pool of reused row elements, so text stays selectable and the browser's find-in-page works.
- `renderer="canvas"`: Canvas 2D, with the least JavaScript per frame.

The wheel scrolls the rows, and <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + wheel (or a pinch) zooms the time axis; add `wheel-zoom` to make the plain wheel zoom. `theme` (`light`, `dark`; by default it follows the page) and the `--l2t-color-*` custom properties restyle the element. Open `demo/large.html#n=50000` for a generated 50,000-span trace, and `demo/perf.html` for the measurement harness.

The data side works without a DOM. `log2trace-ui/core` (transform, span index, filtering, the shared store, `describeSpan`) loads in Node and in a Worker, and it is what future views (flame graph, service graph, sequence diagram) will build on.

## Views

The element draws the trace with one view at a time. List several in the `views` attribute and tabs appear; `view` says which one is shown first. They share one store, so a span selected, hovered or filtered in one view is the same in the others, and each view keeps its own camera or focus when you switch away.

```html
<trace-visualizer views="waterfall,flame,inspector" view="waterfall" data-url="./logs.json"></trace-visualizer>
```

- `waterfall` (the default): one row per span on a time axis. It answers "when did it happen".
- `flame`: a flame graph. Spans with the same call path (service, name and kind of the span and of each ancestor) fold into one box, as wide as the time those spans take together, so it answers "where did the time go". Click or hover a box to select all its spans, double-click or press `F` to make it fill the width, `Escape` to leave. It draws with the DOM.
- `inspector`: the shared state as text, mostly there to prove the view contract.

The `view-changed` event reports a switch, and `registerView()` adds views of your own.

## Upgrading from 1.0.0-RC2

1.0.0-RC3 rebuilds the drawing layer; the data side is unchanged. Markup, the data attributes, `<trace-filter>`, `<span-kind-rule>`, `traceData`, `logData`, `config`, `fetchCallback`, `loadTraceData()` and `loadAndTransform()` work as before. What changed:

- The wheel scrolls instead of zooming; use `wheel-zoom` for the old behaviour.
- The `width` and `background-color` attributes are gone: size and colour the element with CSS (`style="width: 700px; --l2t-color-background: #f8f9ff"`). `full-width` is accepted and does nothing, because the element always fills its container. The element is 480 px tall unless you set `height`.
- `color-scheme` still works; `kind-colors` is its new name. Span-kind colours can also be set with the `--l2t-color-kindServer`-style custom properties (`kindInternal`, `kindClient`, …).
- The `virtual-scroll-activated` event is gone: rows are always virtualized.
- `span-selected` fires only for the user's own clicks and keys, not for `selectSpan()`.
- New: `views` and `view` attributes (tabs), the `flame` and `inspector` views (see Views above), the `view-changed` event, and `registerView()` for views of your own.
- The exports `TraceViewModel`, `Template`, `resolveDisplayDefaults`, `DisplayConfig` and `ViewSpan` are removed. `TraceVisualizerConfig` remains (without the removed display fields). The headless functions (`transformLogs`, `buildSpanIndex`, `matchSpans`, …) are unchanged.
- The inner DOM changed (`[data-role]` hooks and the old class names are gone); style through the custom properties and the exposed `part` names (`root`, `plot`, `filter-bar`, `legend`).

## Documentation

- [Interactive Demo Guide](https://rukpet.github.io/log2trace/guide.html) — step-by-step examples covering every configurable feature, from a one-liner to a full advanced setup
- [API Reference](https://rukpet.github.io/log2trace/api/) — TypeDoc documentation for `TraceVisualizerConfig`, `TransformConfig`, and all exported types
- [Source code](https://github.com/rukpet/log2trace)

## How the transformation works

`transformLogs(logs, config)` converts an arbitrary log array into an OpenTelemetry `TraceData` object in five phases:

1. **Group by trace ID** — cluster all logs that share the same `traceIdField` value
2. **Group into spans** — sub-cluster logs within each trace by the composite `spanGroupFields` key
3. **Build span objects** — extract start time, status, name, and convert all log fields to OTel attributes
4. **Resolve parent-child links** — match `parentSpanLookupFields` values against other span groups to establish the call hierarchy
5. **Structure by service** — arrange spans into `ResourceSpans → ScopeSpans → Spans` per the OTel protocol

Every original log entry is preserved as an OpenTelemetry event on its parent span, so clicking any span in the timeline shows the exact log lines that produced it.

## License

MIT
