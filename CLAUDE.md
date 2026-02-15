# CLAUDE.md

## Project Overview

**log2trace-viewer** is an interactive web component library for visualizing OpenTelemetry trace data as waterfall/timeline diagrams. It is built as a pure Web Component (Custom Element + Shadow DOM) with zero runtime dependencies.

The custom element `<trace-visualizer>` renders hierarchical span data with zoom, pan, click-to-inspect, and color-coded span kinds.

## Repository Structure

```
src/
  index.ts                  # Entry point; auto-registers the <trace-visualizer> element
  component.ts              # TraceVisualizerElement — the core web component
  trace-tree.ts             # TraceTree — builds a parent/child tree from flat OTel spans
  template.ts               # Template — static methods that produce all HTML markup
  visualization-config.ts   # VisualizationConfig — layout/color defaults and overrides
  time.ts                   # nanoToMilli() utility (nanosecond string → milliseconds)
  styles.css                # Shadow DOM stylesheet for the component
  css.d.ts                  # TypeScript declaration for CSS module imports
  opentelemetry/
    trace.ts                # OTel trace types (Span, SpanKind, TraceData, etc.)
    common.ts               # OTel common types (AnyValue, KeyValue, InstrumentationScope)
    resource.ts             # OTel Resource type
    logs.ts                 # OTel log record types (currently unused)
demo/
  demo.html                 # Demo page that uses the component
  server.js                 # Simple Node.js HTTP server for local development
  example.json              # Sample OpenTelemetry trace data
  favicon.svg               # Favicon
dist/                       # Build output (gitignored)
.github/workflows/
  deploy.yml                # CI — builds and deploys demo to GitHub Pages on push to main
```

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Module system:** ESM (`"type": "module"`)
- **Build:** esbuild (bundling) + tsc (type checking / declaration emit)
- **Target:** esnext (modern browsers)
- **Framework:** None — pure Web Components API (Custom Elements v1, Shadow DOM, Adopted Stylesheets)
- **Runtime dependencies:** None

## Common Commands

```bash
# Install dependencies
npm install

# Type-check only (no emit)
npm run check

# Build for development (unminified)
npm run build-simple

# Build for production (minified + sourcemap + metafile)
npm run build

# Build and start local demo server
npm run demo
```

There are currently no tests configured (`npm test` exits with an error).

## Build Details

- `tsc` runs first to type-check and emit `.d.ts` declaration files into `dist/`
- `esbuild` bundles `src/index.ts` into `dist/index.js` as ESM, inlining CSS via `--loader:.css=text`
- Production build adds `--minify`, `--sourcemap`, and `--metafile=dist/meta.json`

The `package.json` `"files"` field ships both `dist/` and `src/` in the npm package.

## Architecture & Key Concepts

### Component Lifecycle

1. `<trace-visualizer>` is registered as a custom element on import
2. Data is loaded either via the `data-url` HTML attribute (fetched) or the `.traceData` JS property
3. `TraceTree.build()` organizes flat `ResourceSpans` → `ScopeSpans` → `Span[]` into a parent/child tree
4. `Template` generates the full HTML markup (waterfall rows, labels, timeline ticks, legend, detail panel)
5. `component.ts` attaches event listeners for click-to-inspect, zoom (wheel + buttons), and pan (drag)

### Data Flow

```
TraceData (OTel JSON) → TraceTree.build() → TraceTree (roots, childrenOf, serviceNameOf)
                                                ↓
                                          Template.getTraceMarkup() → Shadow DOM innerHTML
                                                ↓
                                          Event listeners (zoom/pan/click) attached
```

### Key Classes

| Class | File | Role |
|---|---|---|
| `TraceVisualizerElement` | `src/component.ts` | Web component; owns Shadow DOM, zoom/pan state, event wiring |
| `TraceTree` | `src/trace-tree.ts` | Immutable tree built from OTel data; provides `flatten()` and `getTimeRange()` |
| `Template` | `src/template.ts` | Pure static HTML generators (no state) |
| `VisualizationConfig` | `src/visualization-config.ts` | Config defaults + override merging |

### OpenTelemetry Types

Types in `src/opentelemetry/` mirror the [OpenTelemetry proto definitions](https://github.com/open-telemetry/opentelemetry-proto). The root input type is `TraceData` which contains `resourceSpans: ResourceSpans[]`.

### Configurable Attributes

The component observes these HTML attributes: `data-url`, `width`, `height`, `show-legend`, `full-width`, `detail-panel-width`.

Programmatic configuration is available via the `.config` property (accepts `Partial<VisualizationConfig>`).

## Code Conventions

- **Strict TypeScript** — `"strict": true` in tsconfig; do not use `any` unless unavoidable
- **No framework dependencies** — all DOM manipulation uses native Web APIs
- **Static Template methods** — all markup generation lives in `Template` as static methods; no instance state
- **Immutable data structures** — `TraceTree` fields are `readonly`; a new tree is built on each data change
- **CSS via Shadow DOM** — styles are loaded as text via esbuild's CSS loader and applied with `adoptedStyleSheets`
- **Nanosecond strings** — OTel timestamps are nanosecond strings; use `BigInt` for arithmetic, convert to milliseconds via `nanoToMilli()` for display
- **No linter/formatter configured** — maintain consistency with existing code style (2-space indent, single quotes in templates, no semicolons are not enforced but current code uses semicolons)

## CI/CD

The GitHub Actions workflow (`.github/workflows/deploy.yml`):
- Triggers on push to `main` or manual dispatch
- Runs on `ubuntu-latest` with Node 20
- Steps: `npm ci` → `npm run build` → assemble `_site/` directory → deploy to GitHub Pages
- The demo page (`demo/demo.html`) is served as the GitHub Pages index

## Working with This Codebase

- When adding new OTel types, follow the proto-based pattern in `src/opentelemetry/`
- When adding visual features, add markup in `Template`, styling in `styles.css`, and interaction wiring in `component.ts`
- The `TraceTree` class is the single source of truth for span hierarchy — extend it if new span metadata is needed
- Keep the library zero-dependency; avoid importing external packages at runtime
