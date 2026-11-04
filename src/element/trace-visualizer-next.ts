/**
 * The `<trace-visualizer-next>` element: the 2.0 trace view.
 *
 * It joins the pieces: the shared store (data, selection, collapse, filter result), the waterfall
 * controller and its painter (Canvas 2D or the virtualized DOM, chosen by `renderer`), the input
 * binding on the native scroller, the frame scheduler, the theme probe and the shell (filter bar,
 * toolbar with legend, tooltip, detail panel). It holds no trace logic of its own.
 *
 * DOM, from the back: the stage holds what the painter adds (two canvases, or a layer of row
 * elements) and the scroller (`part="plot"`), a transparent native scroller whose spacer gives the
 * rows their scroll range, so the wheel, touch, keyboard and scrollbar all work natively while the
 * painter redraws from the scroll position. The status message, the tooltip and, for the canvas, a
 * visually hidden accessibility tree sit above.
 *
 * Data comes from `traceData`, `logData`, `data-url` (OTel trace data, or raw logs when the
 * transform attributes are given) or from external filters and `fetchCallback`. Configuration is
 * the same set of attributes and `<trace-filter>` and `<span-kind-rule>` children as ever, plus
 * `theme` (`light`, `dark`, default follows the page), `wheel-zoom`, `gutter-width`, `kind-colors`
 * and `renderer` (`canvas`, `dom`, or `auto`, the default, which is `dom`). Changing `renderer`
 * swaps the painter and keeps the camera, scroll and selection.
 */

import componentCss from 'virtual:component-css';
import {
  API_ORIGIN,
  Slice,
  SpanKind,
  createTraceStore,
  describeSpan,
  spanKindName,
  touches,
  transformLogs,
  type ChangeSet,
  type FetchCallback,
  type LogEntry,
  type SpanId,
  type TimeWindow,
  type TraceData,
  type TraceStore,
  type TransformConfig,
} from '../core.ts';
import { measure } from '../core/instrumentation.ts';
import type { SpanIndex } from '../core/span-index.ts';
import { h } from '../kit/dom.ts';
import { createTextMeter, measureWithContext, type TextMeter } from '../kit/canvas/text-cache.ts';
import { bindInput } from '../kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../kit/input/types.ts';
import { getFrameScheduler, type FrameHandle } from '../kit/scheduler.ts';
import { KIND_TOKENS, ThemeProbe, cssVariableName } from '../kit/theme/theme.ts';
import * as probeStyles from '../kit/theme/probe.css.ts';
import { vars } from '../kit/theme/tokens.css.ts';
import { DEFAULT_METRICS, metricsFromSpanSizes, type WaterfallMetrics } from '../views/waterfall/model/layout.ts';
import { WaterfallController, type UpdateResult } from '../views/waterfall/controller.ts';
import { WaterfallDirty, type Cursor, type WaterfallInput } from '../views/waterfall/model/interaction.ts';
import { mountCanvasPainter } from '../views/waterfall/paint/canvas.ts';
import { mountDomPainter } from '../views/waterfall/paint/dom-mount.ts';
import type { PainterFactory, PainterStats, RendererKind, WaterfallPainter } from '../views/waterfall/paint/painter.ts';
import { DetailPanel } from '../shell/detail.ts';
import { FilterBar } from '../shell/filter-bar.ts';
import { createLegend } from '../shell/legend.ts';
import * as shellStyles from '../shell/shell.css.ts';
import { createToolbar, type Toolbar } from '../shell/toolbar.ts';
import { Tooltip } from '../shell/tooltip.ts';
import { isTransformReady, kindColorOverrides, mergeConfig, readConfig, type ElementConfig } from './config.ts';
import { fetchJson, payloadToIndex } from './data-source.ts';
import { FilterController } from './filter-controller.ts';
import * as styles from './element.css.ts';

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(componentCss);

/** Raw logs and how to read them, as the `logData` setter takes them. */
export interface LogDataInput {
  readonly logs: LogEntry[];
  readonly config: TransformConfig;
}

/** Options of {@link TraceVisualizerNextElement.selectSpan}. */
export interface SelectSpanOptions {
  /** Scroll and pan so the span is in view. Default true. */
  readonly reveal?: boolean;
}

let instances = 0;

/** Maps the keys of the input kit to the `KeyboardEvent.key` values the view's reducer knows. */
const KEY_NAMES: Readonly<Record<Key, string>> = {
  [Key.ArrowUp]: 'ArrowUp',
  [Key.ArrowDown]: 'ArrowDown',
  [Key.ArrowLeft]: 'ArrowLeft',
  [Key.ArrowRight]: 'ArrowRight',
  [Key.Home]: 'Home',
  [Key.End]: 'End',
  [Key.PageUp]: 'PageUp',
  [Key.PageDown]: 'PageDown',
  [Key.Enter]: 'Enter',
  [Key.Space]: ' ',
  [Key.Escape]: 'Escape',
  [Key.Plus]: '+',
  [Key.Minus]: '-',
  [Key.Zero]: '0',
};

/** The attributes the element reacts to. */
const OBSERVED = [
  'data-url', 'theme', 'wheel-zoom', 'renderer',
  'trace-id-field', 'span-group-fields', 'span-name-field', 'service-name-field', 'timestamp-field',
  'end-time-field', 'parent-span-id-field', 'parent-span-lookup-fields', 'span-id-field', 'status-code-field', 'default-span-kind',
  'height', 'span-height', 'span-padding', 'gutter-width', 'show-legend', 'full-width', 'detail-panel-width',
  'kind-colors', 'color-scheme', 'auto-fetch',
];

/** Everything that exists only while the element is in a document. */
interface Mounted {
  painter: WaterfallPainter | null;
  readonly probe: ThemeProbe;
  readonly meter: TextMeter;
  readonly a11y: FrameHandle;
  readonly cleanups: Array<() => void>;
}

/** What the status message says, or nothing when the view is showing data. */
interface Status {
  readonly kind: 'loading' | 'required' | 'error' | 'empty' | 'no-match';
  readonly text: string;
  readonly spinner?: boolean;
}

/** Custom element backing the `<trace-visualizer-next>` tag. */
export class TraceVisualizerNextElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return OBSERVED;
  }

  private readonly shared: TraceStore;
  private readonly controller: WaterfallController;
  private readonly shadow: ShadowRoot;
  private readonly plot: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly message: HTMLElement;
  private readonly a11yRoot: HTMLElement;
  private readonly live: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly tooltip = new Tooltip();
  private readonly detail: DetailPanel;
  private readonly toolbar: Toolbar;
  private readonly filters: FilterController<FilterBar>;
  private mounted: Mounted | null = null;
  private programmatic: ElementConfig = {};
  private fetchCallbackValue: FetchCallback | null = null;
  private a11yKey = '';
  private statusKey = '';
  private cursorName: Cursor = 'default';
  private loadToken = 0;
  private apiSelecting = false;
  private appliedHeight: number | undefined;
  private appliedKindVars = new Set<string>();

  constructor() {
    super();
    const scheduler = getFrameScheduler();
    this.shared = createTraceStore({ schedule: scheduler.schedule });
    this.controller = new WaterfallController({ store: this.shared, origin: `waterfall-${++instances}` });

    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];

    this.spacer = h('div', { class: styles.spacer });
    this.plot = h('div', { class: [styles.plot, styles.cursor.default], part: 'plot', tabindex: 0, role: 'application', 'aria-label': 'Trace waterfall' }, this.spacer);
    this.message = h('div', { class: styles.message, role: 'status', hidden: true });
    this.a11yRoot = h('div', { class: styles.visuallyHidden });
    this.live = h('div', { class: styles.visuallyHidden, role: 'status', 'aria-live': 'polite' });
    this.stage = h('div', { class: styles.stage }, this.plot, this.message, this.tooltip.element, this.a11yRoot, this.live);
    this.detail = new DetailPanel(() => this.shared.setSelection([], { origin: 'shell' }));

    const kinds = KIND_TOKENS.map((token, kind) => ({ token, kind })).filter(({ kind }) => kind !== SpanKind.Unspecified);
    this.legend = createLegend(kinds.map(({ token, kind }) => ({ token, label: spanKindName(kind) || 'Unknown' })));
    this.legend.hidden = true;
    this.toolbar = createToolbar(this.controller.commands(), [this.legend]);

    this.filters = new FilterController(
      {
        store: this.shared,
        config: () => this.config,
        fetchCallback: () => this.fetchCallbackValue,
        dispatch: (type, detail) => this.emit(type, detail),
        statusChanged: () => this.renderStatus(),
      },
      (events) => new FilterBar(events),
    );

    this.shadow.append(h('div', { class: styles.root, part: 'root' }, this.filters.bar.element, this.toolbar.element, h('div', { class: styles.body }, this.stage, this.detail.element)));

    this.shared.subscribe((change) => this.onStoreChange(change));
    this.plot.addEventListener('scroll', () => this.run({ type: 'scroll', top: this.plot.scrollTop }));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Show a pre-built OTel trace. */
  set traceData(data: TraceData) {
    this.loadToken++;
    this.accept(payloadToIndex(data, {}));
  }

  /** Transform raw logs with a config and show the result. */
  set logData(input: LogDataInput) {
    this.loadToken++;
    this.accept(payloadToIndex(measure('transformLogs', () => transformLogs(input.logs, input.config)), {}));
  }

  /**
   * The configuration: attributes and `<trace-filter>` and `<span-kind-rule>` children, with what
   * was assigned to the property on top. Assigning merges field by field; a field set to
   * `undefined` falls back to its attribute.
   */
  get config(): ElementConfig {
    return mergeConfig(readConfig(this), this.programmatic);
  }

  set config(config: ElementConfig) {
    for (const key of Object.keys(config) as Array<keyof ElementConfig>) {
      if (config[key] === undefined) delete this.programmatic[key];
      else (this.programmatic as Record<string, unknown>)[key] = config[key];
    }
    this.configChanged();
  }

  /** Supplies the data for external filters, instead of fetching `data-url` with query parameters. */
  get fetchCallback(): FetchCallback | null {
    return this.fetchCallbackValue;
  }

  set fetchCallback(callback: FetchCallback | null) {
    this.fetchCallbackValue = callback;
  }

  /** The shared store: selection, collapse and filter state, and the loaded trace. Experimental. */
  get store(): TraceStore {
    return this.shared;
  }

  /** The ids of the selected spans. */
  get selection(): readonly SpanId[] {
    return [...this.shared.state.selection.ids];
  }

  /** Select a span and, by default, bring it into view. Does not fire `span-selected`. */
  selectSpan(id: SpanId, options: SelectSpanOptions = {}): void {
    this.apiSelecting = true;
    try {
      this.controller.select(id, options.reveal !== false);
      this.shared.flushSync();
    } finally {
      this.apiSelecting = false;
    }
  }

  /** Expand every span. */
  expandAll(): void {
    this.shared.expandAll();
    this.shared.flushSync();
  }

  /** Collapse every span that has children. */
  collapseAll(): void {
    this.shared.collapseAll();
    this.shared.flushSync();
  }

  /** Show a stretch of time (ms after the start of the trace), or the whole trace with `null`. */
  setTimeWindow(window: TimeWindow | null): void {
    this.shared.setWindow(window);
    this.shared.flushSync();
  }

  /** Fetch a JSON file of OTel trace data and show it. Errors are shown in the view, not thrown. */
  async loadTraceData(url: string): Promise<void> {
    await this.loadFrom(url, undefined);
  }

  /** Fetch a JSON array of raw logs, transform it and show the result. Errors are shown in the view. */
  async loadAndTransform(url: string, config: TransformConfig): Promise<void> {
    await this.loadFrom(url, config);
  }

  /** The painter in use, or the one that will be used once the element is in a document. */
  get renderer(): RendererKind {
    return this.mounted?.painter?.kind ?? this.chooseRenderer();
  }

  /** Parts of the element for tests and the performance harness; not a public API. */
  get internals(): { readonly controller: WaterfallController; readonly store: TraceStore; readonly painter: WaterfallPainter | null; readonly plot: HTMLElement } {
    return { controller: this.controller, store: this.shared, painter: this.mounted?.painter ?? null, plot: this.plot };
  }

  /** What the recent frames cost and how much the painter drew, for the performance harness. */
  frameStats(): { readonly frames: ReturnType<ReturnType<typeof getFrameScheduler>['stats']>; readonly painter: PainterStats | null } {
    return { frames: getFrameScheduler().stats(), painter: this.mounted?.painter?.stats ?? null };
  }

  /** Read the theme tokens again and repaint: after the host changed a `--l2t-*` property from script. */
  refreshTheme(): void {
    const mounted = this.mounted;
    if (mounted === null) return;
    mounted.painter?.setTheme(mounted.probe.resolve());
  }

  /** Called by `<trace-filter>` and `<span-kind-rule>` children when their attributes change. */
  _rerender(): void {
    if (this.mounted !== null) this.configChanged();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  connectedCallback(): void {
    this.mount();
    this.configChanged();
    const { dataUrl } = this.config;
    if (dataUrl !== undefined && !this.filters.hasExternal() && this.shared.state.data.index.size === 0 && this.shared.state.data.phase !== 'loading') {
      void this.loadConfigured();
    }
  }

  disconnectedCallback(): void {
    this.unmount();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || this.mounted === null) return;
    switch (name) {
      case 'theme':
        this.refreshTheme();
        break;
      case 'renderer':
        this.swapPainter();
        break;
      case 'wheel-zoom':
        this.controller.wheelZoom = newValue !== null;
        break;
      case 'data-url':
        this.configChanged();
        if (newValue !== null && !this.filters.hasExternal()) void this.loadConfigured();
        break;
      default:
        this.configChanged();
        break;
    }
  }

  private mount(): void {
    if (this.mounted !== null) return;
    const scheduler = getFrameScheduler();
    const cleanups: Array<() => void> = [];

    const probe = new ThemeProbe(this.shadow, {
      container: probeStyles.container,
      color: probeStyles.color,
      font: probeStyles.font,
    });
    const measureContext = document.createElement('canvas').getContext('2d');
    if (measureContext === null) throw new Error('trace-visualizer-next needs a 2D canvas');
    const meter = createTextMeter({ measure: measureWithContext(measureContext) });
    cleanups.push(bindInput(this.plot, {
      onAction: (action) => this.onAction(action),
      wheelZoom: () => this.controller.wheelZoom,
    }));

    const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (query !== undefined) {
      const onScheme = (): void => this.refreshTheme();
      query.addEventListener('change', onScheme);
      cleanups.push(() => query.removeEventListener('change', onScheme));
    }

    // a click anywhere but in the filter bar closes its open multiselect
    const onOutside = (event: Event): void => {
      if (!event.composedPath().includes(this.filters.bar.element)) this.filters.bar.closePanels();
    };
    this.shadow.addEventListener('click', onOutside, true);
    cleanups.push(() => this.shadow.removeEventListener('click', onOutside, true));

    const a11y = scheduler.register({ paint: () => this.renderA11y() });
    this.mounted = { painter: null, probe, meter, a11y, cleanups };
    this.mountPainter();

    this.controller.wheelZoom = this.hasAttribute('wheel-zoom');
    this.syncSpacer();
    this.renderStatus();
    this.renderSelection();
    a11y.mark(1);
  }

  private unmount(): void {
    const mounted = this.mounted;
    if (mounted === null) return;
    this.mounted = null;
    for (const cleanup of mounted.cleanups) cleanup();
    mounted.a11y.dispose();
    mounted.painter?.dispose();
    mounted.probe.dispose();
    this.filters.dispose();
    this.tooltip.hide();
  }

  /**
   * The renderer the attribute asks for. `auto` is the DOM painter: at 50,000 spans it keeps the frame
   * interval of the canvas on every scenario of the harness (see the stage 3 A/B in the plan), and it brings
   * text selection, find-in-page, a real accessibility tree and forced colours for free.
   */
  private chooseRenderer(): RendererKind {
    return this.getAttribute('renderer') === 'canvas' ? 'canvas' : 'dom';
  }

  private mountPainter(): void {
    const mounted = this.mounted;
    if (mounted === null) return;
    const factory: PainterFactory = this.chooseRenderer() === 'dom' ? mountDomPainter : mountCanvasPainter;
    mounted.painter = factory({
      controller: this.controller,
      host: this.stage,
      meter: mounted.meter,
      theme: mounted.probe.resolve(),
      scheduler: getFrameScheduler(),
      onSize: (width, height) => this.apply(this.controller.resize(width, height)),
    });
    this.a11yKey = '';
    mounted.a11y.mark(1);
    mounted.painter.mark(WaterfallDirty.Rows | WaterfallDirty.Scroll | WaterfallDirty.Camera | WaterfallDirty.Selection | WaterfallDirty.Hover | WaterfallDirty.Theme | WaterfallDirty.Size);
  }

  /** Replace the painter after `renderer` changed; the camera, scroll position and selection stay, they are not the painter's. */
  private swapPainter(): void {
    const mounted = this.mounted;
    if (mounted === null) return;
    if (mounted.painter !== null && mounted.painter.kind === this.chooseRenderer()) return;
    mounted.painter?.dispose();
    this.mountPainter();
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Apply the configuration to everything it touches. */
  private configChanged(): void {
    if (this.mounted === null) return;
    const config = this.config;
    this.legend.hidden = config.showLegend !== true;
    if (config.fullWidth !== undefined) this.classList.toggle('full-width', config.fullWidth);
    this.detail.setWidth(config.detailPanelWidth);
    this.applyHeight(config.height);
    this.applyKindColors(config.kindColors);
    this.applyMetrics(config);
    this.filters.configure();
  }

  private applyHeight(height: number | undefined): void {
    if (height === this.appliedHeight) return;
    this.appliedHeight = height;
    this.style.height = height !== undefined && height > 0 ? `${height}px` : '';
  }

  /** Span-kind colours become custom properties on the host, which the theme tokens inherit. */
  private applyKindColors(colors: Record<string, string> | undefined): void {
    const next = new Map<string, string>();
    for (const [token, color] of kindColorOverrides(colors)) next.set(cssVariableName(vars.color[token]), color);
    const unchanged = next.size === this.appliedKindVars.size && [...next.keys()].every((name) => this.appliedKindVars.has(name));
    for (const name of this.appliedKindVars) if (!next.has(name)) this.style.removeProperty(name);
    for (const [name, color] of next) this.style.setProperty(name, color);
    this.appliedKindVars = new Set(next.keys());
    if (!unchanged || next.size > 0) this.refreshTheme();
  }

  private applyMetrics(config: ElementConfig): void {
    const metrics: Partial<WaterfallMetrics> = {
      ...metricsFromSpanSizes(config.spanHeight ?? Number.NaN, config.spanPadding ?? Number.NaN),
      gutterWidth: config.gutterWidth ?? DEFAULT_METRICS.gutterWidth,
    };
    this.apply(this.controller.setMetrics(metrics));
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  /** Put an index into the store and tell the page. */
  private accept(index: SpanIndex): void {
    this.shared.setData(index);
    this.shared.flushSync();
    this.emit('trace-loaded', { spans: index.size, roots: index.roots.length, traceId: index.traceId });
  }

  /** Load `data-url` as logs or as trace data, whichever the transform attributes say. */
  private async loadConfigured(): Promise<void> {
    const config = this.config;
    if (config.dataUrl === undefined) return;
    await this.loadFrom(config.dataUrl, isTransformReady(config) ? (config as TransformConfig) : undefined);
  }

  private async loadFrom(url: string, transform: TransformConfig | undefined): Promise<void> {
    const token = ++this.loadToken;
    this.shared.setPhase('loading');
    try {
      const payload = await fetchJson<TraceData | LogEntry[]>(url);
      if (token === this.loadToken) this.accept(payloadToIndex(payload, transform ?? {}));
    } catch (error) {
      if (token === this.loadToken) this.shared.setPhase('error', error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ---------------------------------------------------------------------------
  // Store and input
  // ---------------------------------------------------------------------------

  private onStoreChange(change: ChangeSet): void {
    this.apply(this.controller.update(change));
    if (touches(change, Slice.Data)) {
      this.syncSpacer();
      this.filters.refresh();
    }
    if (touches(change, Slice.Data | Slice.Filter | Slice.Collapse)) {
      this.renderStatus();
      if (touches(change, Slice.Filter)) this.announceMatches();
    }
    if (touches(change, Slice.Selection)) {
      this.renderSelection();
      this.mounted?.a11y.mark(1);
      if (change.origin !== API_ORIGIN && !this.apiSelecting) this.announceSelection();
    }
  }

  private announceSelection(): void {
    const { selection, data } = this.shared.state;
    const primary = selection.primary;
    if (primary === null) return;
    const indexed = data.index.spans.get(primary);
    if (indexed === undefined) return;
    this.live.textContent = `Selected ${indexed.span.name}`;
    this.emit('span-selected', { span: indexed.span, spanId: primary, spanIds: [...selection.ids], view: 'waterfall' });
  }

  private announceMatches(): void {
    const { matched, data } = this.shared.state;
    this.live.textContent = matched === null ? '' : `${matched.size} of ${data.index.size} spans match`;
  }

  /** Run an input through the controller and carry out what it asks for. */
  private run(input: WaterfallInput): boolean {
    const result = this.controller.input(input);
    this.apply({ dirty: result.dirty, scrollTo: result.scrollTo });
    if (result.cursor !== this.cursorName) {
      this.plot.classList.replace(styles.cursor[this.cursorName], styles.cursor[result.cursor]);
      this.cursorName = result.cursor;
    }
    return result.handled;
  }

  private onAction(action: InputAction): boolean {
    switch (action.kind) {
      case InputActionKind.Hover:
        this.run({ type: 'hover', x: action.x, y: action.y });
        return true;
      case InputActionKind.HoverEnd:
        this.run({ type: 'leave' });
        return true;
      case InputActionKind.Click:
        this.run({ type: 'click', x: action.x, y: action.y, additive: action.ctrlKey || action.metaKey || action.shiftKey });
        return true;
      case InputActionKind.DoubleClick:
        this.run({ type: 'doubleClick', x: action.x, y: action.y });
        return true;
      case InputActionKind.Pan:
        if (action.dx !== 0) this.run({ type: 'pan', dx: action.dx });
        if (action.dy !== 0) this.plot.scrollTop -= action.dy;
        return true;
      case InputActionKind.Zoom:
        this.run({ type: 'pinch', x: action.x, scale: 1 / action.factor });
        return true;
      case InputActionKind.KeyDown:
        if (action.key === Key.Escape) {
          if (this.shared.state.selection.ids.size === 0) return false;
          this.shared.setSelection([], { origin: 'shell' });
          return true;
        }
        return this.run({ type: 'key', key: KEY_NAMES[action.key], shift: action.shiftKey, ctrl: false, alt: false });
      default:
        return true;
    }
  }

  /** Carry out what the controller asked for after a change of the store, an input or a resize. */
  private apply(result: UpdateResult): void {
    const { dirty } = result;
    if (dirty === 0 && !result.scrollTo) return;

    if ((dirty & (WaterfallDirty.Rows | WaterfallDirty.Size)) !== 0) this.syncSpacer();
    if (result.scrollTo && this.plot.scrollTop !== this.controller.state.scrollTop) this.plot.scrollTop = this.controller.state.scrollTop;
    if ((dirty & (WaterfallDirty.Camera | WaterfallDirty.Rows)) !== 0) this.toolbar.refresh();

    const mounted = this.mounted;
    if (mounted !== null) {
      mounted.painter?.mark(dirty);
      if ((dirty & (WaterfallDirty.Rows | WaterfallDirty.Scroll | WaterfallDirty.Selection | WaterfallDirty.Size)) !== 0) mounted.a11y.mark(1);
    }
    this.renderTooltip(dirty);
  }

  // ---------------------------------------------------------------------------
  // Rendering of the parts around the painter
  // ---------------------------------------------------------------------------

  /** The height of the spacer gives the scroller exactly the scroll range of the rows. */
  private syncSpacer(): void {
    const { layout, projection } = this.controller;
    this.spacer.style.height = `${layout.headerHeight + projection.count * layout.rowHeight}px`;
  }

  /** What the status message says now. */
  private status(): Status | null {
    const { data, matched } = this.shared.state;
    if (this.filters.fetching) return { kind: 'loading', text: 'Loading traces...', spinner: true };
    if (this.filters.model.requiredUnfilled()) return { kind: 'required', text: 'Fill in required fields to load traces' };
    if (data.phase === 'loading') return { kind: 'loading', text: 'Loading trace data...', spinner: true };
    if (data.phase === 'error') return { kind: 'error', text: `Error: ${data.error ?? 'Failed to load trace data'}` };
    if (data.index.size === 0) return { kind: 'empty', text: 'No trace data loaded. Set the data-url attribute or use the traceData property.' };
    if (matched !== null && this.controller.projection.count === 0) return { kind: 'no-match', text: 'No spans match current filters' };
    return null;
  }

  private renderStatus(): void {
    const status = this.status();
    const key = status === null ? '' : `${status.kind}|${status.text}`;
    if (key === this.statusKey) return;
    this.statusKey = key;

    this.message.hidden = status === null;
    this.message.classList.toggle(styles.messageError, status?.kind === 'error');
    this.message.replaceChildren(...(status === null ? [] : [h('div', null, status.spinner === true && h('span', { class: shellStyles.spinner }), status.text)]));
  }

  private renderSelection(): void {
    const { selection, data } = this.shared.state;
    const primary = selection.primary;
    this.detail.show(primary === null ? null : `${data.generation}:${primary}`, primary === null ? null : describeSpan(data.index, primary, 'full'));
  }

  private renderTooltip(dirty: number): void {
    const hover = this.controller.state.hover;
    if (hover === null || (dirty & (WaterfallDirty.Camera | WaterfallDirty.Scroll | WaterfallDirty.Rows)) !== 0) {
      this.tooltip.hide();
      return;
    }
    const { index } = this.controller;
    const id = index.table.ids[hover.span];
    const model = describeSpan(index, id, 'brief');
    if (model === null) {
      this.tooltip.hide();
      return;
    }
    const { layout } = this.controller;
    this.tooltip.show(`${id}:${hover.event}`, model, hover, { width: layout.width, height: layout.height });
  }

  /** Rebuild the accessibility tree of the rows in view when it changed (canvas only). */
  private renderA11y(): void {
    if (this.mounted?.painter?.kind !== 'canvas') {
      // the DOM painter's rows are the tree
      if (this.a11yKey !== 'dom') this.a11yRoot.replaceChildren();
      this.a11yKey = 'dom';
      return;
    }
    const tree = this.controller.a11y('Spans');
    const first = tree.items[0]?.position ?? 0;
    const key = `${tree.size}|${first}|${tree.items.length}|${tree.activeId ?? ''}`;
    if (key === this.a11yKey) return;
    this.a11yKey = key;

    this.a11yRoot.replaceChildren(
      h(
        'div',
        { role: 'tree', 'aria-label': tree.label },
        tree.items.map((item) =>
          h('div', {
            role: 'treeitem',
            'aria-level': item.level + 1,
            'aria-expanded': item.expanded,
            'aria-selected': item.selected,
            'aria-posinset': item.position,
            'aria-setsize': tree.size,
          }, item.label)),
      ),
    );
  }
}

if (!customElements.get('trace-visualizer-next')) customElements.define('trace-visualizer-next', TraceVisualizerNextElement);
