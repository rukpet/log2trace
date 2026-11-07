/**
 * The `<trace-visualizer>` element: the trace view.
 *
 * It owns what every view shares and hosts one view at a time. The shared part: the store (data,
 * selection, hover, collapse, filter result, time window), the filter bar and its controller, the
 * toolbar with the legend, the view tabs, the tooltip, the detail panel, the status message, the
 * live region, the configuration and the data loading. The view is whatever `view` names
 * (`waterfall`, `inspector` or `flame` out of the box, anything registered with `registerView`): it is
 * mounted into one surface, reads and writes the store, and reports hovers through its context.
 * Only the active view is mounted; switching saves its state (`getState`) and restores it when
 * the tab is shown again.
 *
 * Data comes from `traceData`, `logData`, `data-url` (OTel trace data, or raw logs when the
 * transform attributes are given) or from external filters and `fetchCallback`. Configuration is
 * the set of attributes and `<trace-filter>` and `<span-kind-rule>` children, plus `theme`
 * (`light`, `dark`, default follows the page), `wheel-zoom`, `gutter-width`, `kind-colors`,
 * `renderer` (`canvas`, `dom`, or `auto`, the default, which is `dom`), `view` (the active view) and
 * `views` (a comma-separated list of view ids; with more than one, tabs appear).
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
import * as a11yStyles from '../kit/a11y.css.ts';
import { h } from '../kit/dom.ts';
import { getFrameScheduler } from '../kit/scheduler.ts';
import { KIND_TOKENS, cssVariableName } from '../kit/theme/theme.ts';
import { vars } from '../kit/theme/tokens.css.ts';
import {
  getView,
  listViews,
  parseViewIds,
  registerView,
  resolveRenderer,
  type RendererKind,
  type TraceView,
  type ViewContext,
  type ViewDefinition,
  type ViewHit,
} from '../kit/view.ts';
import type { ViewOptions } from '../kit/view-options.ts';
import { DetailPanel } from '../shell/detail.ts';
import { FilterBar } from '../shell/filter-bar.ts';
import { createLegend } from '../shell/legend.ts';
import * as shellStyles from '../shell/shell.css.ts';
import { createToolbar, type Toolbar } from '../shell/toolbar.ts';
import { Tooltip } from '../shell/tooltip.ts';
import { createViewTabs, type ViewTabs } from '../shell/view-tabs.ts';
import { flameDefinition } from '../views/flame/view.ts';
import { inspectorDefinition } from '../views/inspector/view.ts';
import { serviceDefinition } from '../views/service/view.ts';
import type { WaterfallController } from '../views/waterfall/controller.ts';
import type { PainterStats, WaterfallPainter } from '../views/waterfall/paint/painter.ts';
import { readWaterfallSettings } from '../views/waterfall/settings.ts';
import { WaterfallView, waterfallDefinition } from '../views/waterfall/view.ts';
import { isTransformReady, kindColorOverrides, mergeConfig, readConfig, type TraceVisualizerConfig } from './config.ts';
import { fetchJson, payloadToIndex } from './data-source.ts';
import { FilterController } from './filter-controller.ts';
import * as styles from './element.css.ts';

registerView(waterfallDefinition);
registerView(inspectorDefinition);
registerView(flameDefinition);
registerView(serviceDefinition);

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(componentCss);

/** Raw logs and how to read them, as the `logData` setter takes them. */
export interface LogDataInput {
  readonly logs: LogEntry[];
  readonly config: TransformConfig;
}

/** Options of {@link TraceVisualizerElement.selectSpan}. */
export interface SelectSpanOptions {
  /** Bring the span into view in the active view. Default true. */
  readonly reveal?: boolean;
}

let instances = 0;

/** The attributes the element reacts to. */
const OBSERVED = [
  'data-url', 'theme', 'wheel-zoom', 'renderer', 'view', 'views',
  'trace-id-field', 'span-group-fields', 'span-name-field', 'service-name-field', 'timestamp-field',
  'end-time-field', 'parent-span-id-field', 'parent-span-lookup-fields', 'span-id-field', 'status-code-field', 'default-span-kind',
  'height', 'span-height', 'span-padding', 'gutter-width', 'show-legend', 'full-width', 'detail-panel-width',
  'kind-colors', 'color-scheme', 'auto-fetch',
];

/** What the status message says, or nothing when the view is showing data. */
interface Status {
  readonly kind: 'loading' | 'required' | 'error' | 'empty' | 'no-match';
  readonly text: string;
  readonly spinner?: boolean;
}

/** The view being shown. */
interface ActiveView {
  readonly definition: ViewDefinition;
  readonly view: TraceView;
}

/** Everything that exists only while the element is in a document. */
interface Connected {
  readonly cleanups: Array<() => void>;
}

/** Custom element backing the `<trace-visualizer>` tag. */
export class TraceVisualizerElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return OBSERVED;
  }

  private readonly shared: TraceStore;
  private readonly shadow: ShadowRoot;
  private readonly stage: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly message: HTMLElement;
  private readonly live: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly toolbarSlot: HTMLElement;
  private readonly tabs: ViewTabs;
  private readonly tooltip = new Tooltip();
  private readonly detail: DetailPanel;
  private readonly filters: FilterController<FilterBar>;
  private readonly instance = ++instances;
  private toolbar: Toolbar | null = null;
  private connected: Connected | null = null;
  private active: ActiveView | null = null;
  private readonly viewStates = new Map<string, unknown>();
  private readonly selectionWhenHidden = new Map<string, SpanId | null>();
  private programmatic: TraceVisualizerConfig = {};
  private fetchCallbackValue: FetchCallback | null = null;
  private statusKey = '';
  private loadToken = 0;
  private apiSelecting = false;
  private appliedHeight: number | undefined;
  private appliedKindVars = new Set<string>();

  constructor() {
    super();
    const scheduler = getFrameScheduler();
    this.shared = createTraceStore({ schedule: scheduler.schedule });

    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];

    const panelId = `l2t-view-${this.instance}`;
    this.surface = h('div', { class: styles.surface });
    this.message = h('div', { class: styles.message, role: 'status', hidden: true });
    this.live = h('div', { class: a11yStyles.visuallyHidden, role: 'status', 'aria-live': 'polite' });
    this.stage = h('div', { class: styles.stage, id: panelId, role: 'tabpanel' }, this.surface, this.message, this.tooltip.element, this.live);
    this.detail = new DetailPanel({
      onClose: () => this.shared.setSelection([], { origin: 'shell' }),
      onReturn: () => this.active?.view.focus?.(),
    });
    this.tabs = createViewTabs((id) => { this.view = id; }, panelId);
    this.toolbarSlot = h('div', { class: styles.toolbarSlot });

    const kinds = KIND_TOKENS.map((token, kind) => ({ token, kind })).filter(({ kind }) => kind !== SpanKind.Unspecified);
    this.legend = createLegend(kinds.map(({ token, kind }) => ({ token, label: spanKindName(kind) || 'Unknown' })));
    this.legend.hidden = true;

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

    this.shadow.append(
      h('div', { class: styles.root, part: 'root' }, this.filters.bar.element, this.tabs.element, this.toolbarSlot, h('div', { class: styles.body }, this.stage, this.detail.element)),
    );

    this.shared.subscribe((change) => this.onStoreChange(change));
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
  get config(): TraceVisualizerConfig {
    return mergeConfig(readConfig(this), this.programmatic);
  }

  set config(config: TraceVisualizerConfig) {
    for (const key of Object.keys(config) as Array<keyof TraceVisualizerConfig>) {
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

  /** The id of the view being shown. Setting it switches the view (and the `view` attribute follows). */
  get view(): string {
    return this.active?.definition.id ?? this.wantedView();
  }

  set view(id: string) {
    if (this.getAttribute('view') !== id) this.setAttribute('view', id);
    else this.showView(id);
  }

  /** Select a span and, by default, bring it into view. Does not fire `span-selected`. */
  selectSpan(id: SpanId, options: SelectSpanOptions = {}): void {
    if (!this.shared.state.data.index.spans.has(id)) return;
    this.apiSelecting = true;
    try {
      this.shared.expandAncestors(id, { origin: API_ORIGIN });
      this.shared.setSelection([id], { origin: API_ORIGIN, primary: id });
      // the rows change when ancestors expand: bring the view up to date before it looks for the span
      this.shared.flushSync();
      if (options.reveal !== false) this.active?.view.reveal?.(id);
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

  /** The backend of the active view, or the one the waterfall will use once the element is in a document. */
  get renderer(): RendererKind {
    return this.active?.view.renderer ?? resolveRenderer(readWaterfallSettings(this.viewOptions()).renderer, waterfallDefinition.renderers);
  }

  /** Parts of the active waterfall for tests and the performance harness; not a public API. */
  get internals(): { readonly controller: WaterfallController | null; readonly store: TraceStore; readonly painter: WaterfallPainter | null; readonly plot: HTMLElement | null } {
    const view = this.active?.view;
    const inner = view instanceof WaterfallView ? view.internals : null;
    return { controller: inner?.controller ?? null, store: this.shared, painter: inner?.painter ?? null, plot: inner?.plot ?? null };
  }

  /** What the recent frames cost and how much the painter drew, for the performance harness. */
  frameStats(): { readonly frames: ReturnType<ReturnType<typeof getFrameScheduler>['stats']>; readonly painter: PainterStats | null } {
    const view = this.active?.view;
    return { frames: getFrameScheduler().stats(), painter: view instanceof WaterfallView ? view.painterStats : null };
  }

  /** Read the theme tokens again and repaint: after the host changed a `--l2t-*` property from script. */
  refreshTheme(): void {
    this.active?.view.themeChanged();
  }

  /** Called by `<trace-filter>` and `<span-kind-rule>` children when their attributes change. */
  _rerender(): void {
    if (this.connected !== null) this.configChanged();
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
    if (oldValue === newValue || this.connected === null) return;
    switch (name) {
      case 'theme':
        this.refreshTheme();
        break;
      case 'renderer':
      case 'wheel-zoom':
        this.active?.view.optionsChanged();
        break;
      case 'view':
        this.showView(this.wantedView());
        break;
      case 'views':
        this.syncTabs();
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
    if (this.connected !== null) return;
    const cleanups: Array<() => void> = [];

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

    // Enter or Space on a selected span moves the focus to its details, Ctrl/Cmd+F to the filter bar, and
    // Escape in a text filter back to the view; the page's own find still works when there is no bar
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey) return;
      const target = event.target;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement;
      if ((event.key === 'Enter' || event.key === ' ') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !editing && this.stage.contains(target as Node)
        && this.shared.state.selection.primary !== null) {
        if (this.detail.focus()) event.preventDefault();
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        if (this.filters.bar.focusFirst()) event.preventDefault();
      } else if (event.key === 'Escape' && target instanceof HTMLInputElement && target.type === 'text' && this.filters.bar.element.contains(target)) {
        event.preventDefault();
        this.active?.view.focus?.();
      }
    };
    this.shadow.addEventListener('keydown', onKey as EventListener);
    cleanups.push(() => this.shadow.removeEventListener('keydown', onKey as EventListener));

    this.connected = { cleanups };
    this.syncTabs();
    this.renderStatus();
    this.renderSelection();
  }

  private unmount(): void {
    const connected = this.connected;
    if (connected === null) return;
    this.connected = null;
    for (const cleanup of connected.cleanups) cleanup();
    this.leaveView();
    this.filters.dispose();
    this.tooltip.hide();
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /** The ids shown as tabs: the `views` attribute, limited to the registered views. */
  private viewIds(): string[] {
    return parseViewIds(this.getAttribute('views'), listViews().map((definition) => definition.id));
  }

  /** The view the attributes ask for: `view` when it is among the tabs, else the first tab. */
  private wantedView(): string {
    const ids = this.viewIds();
    const asked = this.getAttribute('view');
    return asked !== null && ids.includes(asked) ? asked : ids[0];
  }

  /** Draw the tabs for the current `views` and show the view that is wanted. */
  private syncTabs(): void {
    const tabs = this.viewIds().flatMap((id) => {
      const definition = getView(id);
      return definition === undefined ? [] : [{ id, label: definition.label }];
    });
    const wanted = this.wantedView();
    this.tabs.set(tabs, wanted);
    this.showView(wanted);
  }

  /** The configuration as every view sees it; each view reads the options it knows. */
  private viewOptions(): ViewOptions {
    return { config: { ...this.config }, attribute: (name) => this.getAttribute(name) };
  }

  private viewContext(definition: ViewDefinition): ViewContext {
    return {
      origin: `${definition.id}-${this.instance}`,
      store: this.shared,
      options: () => this.viewOptions(),
      hover: (hit) => this.showHover(hit),
      refreshCommands: () => this.toolbar?.refresh(),
    };
  }

  /** Unmount the active view, keeping what it needs to come back as it was. */
  private leaveView(): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    this.viewStates.set(active.definition.id, active.view.getState());
    this.selectionWhenHidden.set(active.definition.id, this.shared.state.selection.primary);
    active.view.unmount();
    this.surface.replaceChildren();
    this.tooltip.hide();
    this.toolbar = null;
    this.toolbarSlot.replaceChildren();
  }

  /** Show a view: the same one again does nothing, another one replaces the active view. */
  private showView(id: string): void {
    if (this.connected === null) return;
    const definition = getView(id);
    if (definition === undefined || this.active?.definition.id === id) return;

    const previous = this.active?.definition.id;
    this.leaveView();

    const view = definition.create();
    this.active = { definition, view };
    view.mount(this.surface, this.viewContext(definition));
    this.toolbar = createToolbar(view.commands(), [this.legend]);
    this.toolbarSlot.replaceChildren(this.toolbar.element);
    this.tabs.setActive(id);
    this.syncLegend();

    const saved = this.viewStates.get(id);
    if (saved !== undefined && saved !== null) view.setState(saved);
    // a span selected while this view was away is brought into view; otherwise the view stays where it was left
    const primary = this.shared.state.selection.primary;
    if (primary !== null && this.selectionWhenHidden.has(id) && this.selectionWhenHidden.get(id) !== primary) view.reveal?.(primary);

    this.renderStatus();
    if (previous !== undefined) this.emit('view-changed', { view: id, previous });
  }

  /** The legend shows when the configuration asks for it and the active view has colours to explain. */
  private syncLegend(): void {
    this.legend.hidden = !(this.config.showLegend === true && this.active?.definition.capabilities.legend === true);
  }

  private showHover(hit: ViewHit | null): void {
    const model = hit?.info() ?? null;
    if (hit === null || model === null) {
      this.tooltip.hide();
      return;
    }
    this.tooltip.show(hit.key, model, hit.anchor, hit.bounds);
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Apply the configuration to everything it touches. */
  private configChanged(): void {
    if (this.connected === null) return;
    const config = this.config;
    this.syncLegend();
    if (config.fullWidth !== undefined) this.classList.toggle('full-width', config.fullWidth);
    this.detail.setWidth(config.detailPanelWidth);
    this.applyHeight(config.height);
    this.applyKindColors(config.kindColors);
    this.active?.view.optionsChanged();
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
  // Store
  // ---------------------------------------------------------------------------

  private onStoreChange(change: ChangeSet): void {
    this.active?.view.update(change);
    if (touches(change, Slice.Data)) this.filters.refresh();
    if (touches(change, Slice.Data | Slice.Filter | Slice.Collapse)) {
      this.renderStatus();
      if (touches(change, Slice.Filter)) this.announceMatches();
    }
    if (touches(change, Slice.Selection)) {
      this.renderSelection();
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
    this.emit('span-selected', { span: indexed.span, spanId: primary, spanIds: [...selection.ids], view: this.active?.definition.id ?? '' });
  }

  private announceMatches(): void {
    const { matched, data } = this.shared.state;
    this.live.textContent = matched === null ? '' : `${matched.size} of ${data.index.size} spans match`;
  }

  // ---------------------------------------------------------------------------
  // Rendering of the parts around the view
  // ---------------------------------------------------------------------------

  /** What the status message says now. */
  private status(): Status | null {
    const { data, matched } = this.shared.state;
    if (this.filters.fetching) return { kind: 'loading', text: 'Loading traces...', spinner: true };
    if (this.filters.model.requiredUnfilled()) return { kind: 'required', text: 'Fill in required fields to load traces' };
    if (data.phase === 'loading') return { kind: 'loading', text: 'Loading trace data...', spinner: true };
    if (data.phase === 'error') return { kind: 'error', text: `Error: ${data.error ?? 'Failed to load trace data'}` };
    if (data.index.size === 0) return { kind: 'empty', text: 'No trace data loaded. Set the data-url attribute or use the traceData property.' };
    if (matched !== null && matched.size === 0) return { kind: 'no-match', text: 'No spans match current filters' };
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
}

if (!customElements.get('trace-visualizer')) customElements.define('trace-visualizer', TraceVisualizerElement);
