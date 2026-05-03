/**
 * Data flow steps 1 & 5: Component
 *
 * Registers <trace-visualizer> custom element. Owns the Shadow DOM,
 * event handling (click, hover, keyboard), zoom/pan, and the detail panel.
 * Accepts data via HTML attributes, .traceData setter, or .logData setter.
 * CSS is injected via adoptedStyleSheets from the virtual:component-css module.
 */

import { TraceData } from './opentelemetry/trace.ts';
import { buildSpanIndex, type SpanIndex, type IndexedSpan } from './span-index.ts';
import { TraceViewModel, type ViewSpan } from './trace-view-model.ts';
import { Template } from './template.ts';
import { transformLogs, getField } from './transform.ts';
import {
  type TraceVisualizerConfig, type TransformConfig, type DisplayConfig,
  type FilterFieldConfig, type FilterFieldType, type FilterSource, type FilterTarget,
  type FilterValue, type Filter, type FetchCallback, type OptionsSource,
  type FilterOption, type SpanKindRule, type LogEntry,
  resolveDisplayDefaults, normalizeOptions,
} from './config.ts';
import { filterSpanIds, areRequiredExternalFiltersFilled, buildQueryParams } from './filter.ts';
import { mark, measure, measureAsync } from './instrumentation.ts';
import componentCss from 'virtual:component-css';
import * as styles from './styles.css.ts';

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(componentCss);

/**
 * Custom element backing the `<trace-visualizer>` tag.
 *
 * Renders an OpenTelemetry-style waterfall inside a Shadow DOM and owns
 * the supporting interactions: zoom and pan, keyboard navigation, the
 * detail side-panel, and the optional filter bar (`<trace-filter>` and
 * `<span-kind-rule>` children).
 *
 * Data can be supplied three ways:
 *
 * - Declaratively via the `data-url` attribute, optionally combined with
 *   transform attributes (`trace-id-field`, `timestamp-field`, etc.) to
 *   load and transform raw logs in one step.
 * - Programmatically via the {@link TraceVisualizerElement.traceData}
 *   setter when you already have OTel-shaped data.
 * - Programmatically via {@link TraceVisualizerElement.logData} when you
 *   have raw logs and want the component to run {@link transformLogs}.
 *
 * Display, transform, and filter options are unified under
 * {@link TraceVisualizerConfig}; they can be set per-attribute or in
 * bulk via the {@link TraceVisualizerElement.config} setter.
 *
 * @example
 * ```html
 * <trace-visualizer data-url="./trace.json" show-legend></trace-visualizer>
 * ```
 *
 * @example
 * ```ts
 * const el = document.querySelector('trace-visualizer');
 * el.logData = {
 *   logs: myLogs,
 *   config: {
 *     traceIdField: 'text.BTMID',
 *     spanNameField: 'text.Action',
 *     serviceNameField: 'text.MachineName',
 *     timestampField: 'text.Timestamp',
 *   },
 * };
 * ```
 */
export class TraceVisualizerElement extends HTMLElement {
  private _index: SpanIndex | null = null;
  private _viewModel: TraceViewModel | null = null;
  private _programmatic: TraceVisualizerConfig = {};
  private shadow: ShadowRoot;
  private zoomLevel: number = 1;
  private panOffset: number = 0;
  private isPanning: boolean = false;
  private panStartX: number = 0;
  private panStartOffset: number = 0;
  private resizeObserver: ResizeObserver;
  private selectedSpanIndex: number = -1;
  private filterController!: FilterBarController;

  // Virtual scroll state

  private _vsStart = 0;
  private _vsEnd = 0;
  private _vsScrollHandler: (() => void) | null = null;

  /** Span count threshold above which virtual scrolling activates. */
  static VIRTUAL_SCROLL_THRESHOLD = 200;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];
    this.filterController = new FilterBarController(this);
    this.resizeObserver = new ResizeObserver(() => {
      this.clampPanOffset();
      this.recalculateTimelineTicks();
      if (this.zoomLevel > 1) {
        this.updateZoomPan();
      }
    });
  }

  static get observedAttributes() {
    return [
      'data-url',
      // Transform
      'trace-id-field', 'span-group-fields', 'span-name-field', 'service-name-field',
      'timestamp-field', 'end-time-field', 'parent-span-id-field', 'parent-span-lookup-fields',
      'span-id-field', 'status-code-field', 'default-span-kind',
      // Display
      'width', 'height', 'background-color', 'span-height', 'span-padding',
      'show-legend', 'full-width', 'detail-panel-width', 'color-scheme',
      // Filter
      'auto-fetch',
    ];
  }

  connectedCallback() {
    this.setupKeyboardNavigation();

    this.render();
    if (!this.filterController.hasExternalFilters()) {
      const merged = this.config;
      if (merged.dataUrl) {
        if (this.isTransformReady(merged)) {
          this.loadAndTransform(merged.dataUrl, merged);
        } else {
          this.loadTraceData(merged.dataUrl);
        }
      }
    }
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
    this.removeKeyboardNavigation();
    this.filterController.destroy();
    this.detachVirtualScroll();
  }

  attributeChangedCallback(_name: string, oldValue: string, newValue: string) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  /**
   * Replace the rendered trace with a new pre-built {@link TraceData} payload.
   *
   * Triggers an immediate re-render and resets the cached tree used for
   * local filtering. Use this when you fetch trace data yourself or
   * already have OTel-shaped output from another source.
   *
   * @param data - OTel trace data, typically from {@link transformLogs}.
   */
  set traceData(data: TraceData) {
    this._index = measure('buildSpanIndex', () => buildSpanIndex(data));
    this._viewModel = new TraceViewModel(this._index);
    this.filterController.activeIndex = this._index;
    this.render();
    this.dispatchEvent(new CustomEvent('trace-loaded', {
      detail: { spans: this._index.size, roots: this._index.roots.length, traceId: this._index.traceId },
      bubbles: true, composed: true,
    }));
  }

  /**
   * The active view model for the current trace data.
   *
   * Returns `null` before any data has been supplied. The view model
   * provides the visible spans (accounting for collapse and filter state),
   * the precomputed time range, and collapse/expand controls.
   */
  get viewModel(): TraceViewModel | null {
    return this.activeViewModel;
  }

  /**
   * Convenience setter for raw logs plus a transform config.
   *
   * Equivalent to calling `transformLogs(logs, config)` and assigning
   * the result to {@link TraceVisualizerElement.traceData}. Useful when
   * the consumer holds logs in memory and does not need to keep the
   * intermediate {@link TraceData} representation around.
   *
   * @param input - The raw logs and the {@link TransformConfig} that
   *   describes how to map them onto spans.
   */
  set logData(input: { logs: LogEntry[]; config: TransformConfig }) {
    this.traceData = measure('transformLogs', () => transformLogs(input.logs, input.config));
  }

  /**
   * Install or remove a custom data-fetching callback.
   *
   * When set, the callback replaces the component's built-in `fetch(url)`
   * call for both initial loads and external-filter refetches. Pass
   * `null` to restore the built-in behaviour. See {@link FetchCallback}
   * for the contract.
   */
  set fetchCallback(cb: FetchCallback | null) {
    this.filterController.fetchCallback = cb;
  }

  /** The currently installed {@link FetchCallback}, or `null` when using built-in `fetch`. */
  get fetchCallback(): FetchCallback | null {
    return this.filterController.fetchCallback;
  }

  /**
   * Apply a partial {@link TraceVisualizerConfig} programmatically.
   *
   * The assignment shallow-merges into an internal "programmatic" config
   * layer that takes precedence over HTML attributes; repeated calls
   * accumulate fields rather than replacing the whole config:
   *
   * ```ts
   * el.config = { width: 500 };
   * el.config = { height: 300 };
   * // Both width and height are now overridden
   * ```
   *
   * Pass `undefined` for a field to clear that override and let the
   * matching HTML attribute take over again:
   *
   * ```ts
   * el.config = { width: undefined };  // fall back to the `width` attribute
   * ```
   *
   * @param config - Partial config to merge in. Any subset of fields is allowed.
   */
  set config(config: TraceVisualizerConfig) {
    for (const key of Object.keys(config) as Array<keyof TraceVisualizerConfig>) {
      if (config[key] === undefined) {
        // Unset override — fall back to HTML attribute
        delete this._programmatic[key];
      } else {
        (this._programmatic as Record<string, unknown>)[key] = config[key];
      }
    }
    this.render();
  }

  /**
   * Read the merged effective configuration.
   *
   * Combines values parsed from HTML attributes with the programmatic
   * overrides set via the {@link TraceVisualizerElement.config} setter.
   * Programmatic values win on conflict.
   *
   * @returns A fresh {@link TraceVisualizerConfig} snapshot — mutating
   *   the result does not affect the component.
   */
  get config(): TraceVisualizerConfig {
    return this._mergedConfig();
  }

  /**
   * Fetch a JSON file containing pre-built OTel {@link TraceData} and render it.
   *
   * On error the shadow DOM is replaced with an error placeholder
   * instead of throwing. Use this when the URL serves data already in
   * OTel shape; for raw logs use {@link TraceVisualizerElement.loadAndTransform}.
   *
   * @param url - Absolute or relative URL of the JSON resource.
   * @returns A promise that resolves once the data has been parsed and rendered.
   */
  async loadTraceData(url: string): Promise<void> {
    try {
      this.shadow.innerHTML = Template.getLoadingMarkup();
      const data = await measureAsync('fetch', () => this.fetchJson<TraceData>(url));
      this.traceData = data;
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  /**
   * Fetch a JSON array of raw logs, transform it, and render the result.
   *
   * Internally fetches the URL, runs {@link transformLogs} with the
   * supplied {@link TransformConfig}, then assigns the resulting
   * {@link TraceData}. On error the shadow DOM shows an error placeholder
   * rather than throwing.
   *
   * @param url - Absolute or relative URL of the JSON resource.
   * @param config - Field-mapping configuration. Must include the four
   *   required transform fields (`traceIdField`, `spanNameField`,
   *   `serviceNameField`, `timestampField`).
   * @returns A promise that resolves once the data has been transformed and rendered.
   */
  async loadAndTransform(url: string, config: TransformConfig): Promise<void> {
    try {
      this.shadow.innerHTML = Template.getLoadingMarkup();
      const logs = await measureAsync('fetch', () => this.fetchJson<LogEntry[]>(url));
      this.traceData = measure('transformLogs', () => transformLogs(logs, config));
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load: ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /** Parse all HTML attributes into a flat TraceVisualizerConfig. */
  private _attrConfig(): TraceVisualizerConfig {
    const str = (attr: string) => this.getAttribute(attr) ?? undefined;
    const csv = (attr: string) => {
      const v = this.getAttribute(attr);
      return v ? v.split(',').map(s => s.trim()) : undefined;
    };
    const num = (attr: string) => {
      const v = this.getAttribute(attr);
      return v ? parseInt(v, 10) : undefined;
    };
    const bool = (attr: string) => {
      const v = this.getAttribute(attr);
      return v !== null ? v !== 'false' : undefined;
    };

    const json = (attr: string) => {
      const v = this.getAttribute(attr);
      if (!v) return undefined;
      try { return JSON.parse(v); } catch { return undefined; }
    };
    const set = <K extends keyof TraceVisualizerConfig>(key: K, value: TraceVisualizerConfig[K]) => {
      if (value !== undefined) config[key] = value;
    };

    const config: TraceVisualizerConfig = {};

    // Data
    set('dataUrl',               str('data-url'));
    // Transform fields
    set('traceIdField',          str('trace-id-field'));
    set('spanGroupFields',       csv('span-group-fields'));
    set('spanNameField',         str('span-name-field'));
    set('serviceNameField',      str('service-name-field'));
    set('timestampField',        str('timestamp-field'));
    set('endTimeField',          str('end-time-field'));
    set('parentSpanIdField',     str('parent-span-id-field'));
    set('parentSpanLookupFields', csv('parent-span-lookup-fields'));
    set('spanIdField',           str('span-id-field'));
    set('statusCodeField',       str('status-code-field'));
    // Child elements: <span-kind-rule> and <trace-filter>
    const spanKindRules: SpanKindRule[] = [];
    const filterConfigs: FilterFieldConfig[] = [];

    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      const tag = child.tagName.toLowerCase();

      if (tag === 'span-kind-rule') {
        const rule = this._parseSpanKindRuleElement(child);
        if (rule) spanKindRules.push(rule);
      }

      if (tag === 'trace-filter') {
        const fc = this._parseFilterElement(child);
        if (fc) filterConfigs.push(fc);
      }
    }

    const mergedRules = spanKindRules;
    if (mergedRules.length > 0) set('spanKindRules', mergedRules);
    if (filterConfigs.length > 0) set('filterConfigs', filterConfigs);
    set('defaultSpanKind',       str('default-span-kind'));
    // Display fields
    set('width',                 num('width'));
    set('height',                num('height'));
    set('backgroundColor',       str('background-color'));
    set('spanHeight',            num('span-height'));
    set('spanPadding',           num('span-padding'));
    set('showLegend',            bool('show-legend'));
    set('fullWidth',             bool('full-width'));
    set('detailPanelWidth',      str('detail-panel-width'));
    set('colorScheme',           json('color-scheme'));
    // Filter
    set('autoFetch',             bool('auto-fetch'));

    return config;
  }

  private _parseSpanKindRuleElement(el: Element): SpanKindRule | null {
    const kind = el.getAttribute('kind');
    if (!kind) return null;
    const matchField = el.getAttribute('match-field');
    const matchValue = el.getAttribute('match-value');
    if (matchField && matchValue) return { match: { [matchField]: matchValue }, kind };
    const matchAttr = el.getAttribute('match');
    if (matchAttr) {
      try {
        const match = JSON.parse(matchAttr);
        if (typeof match === 'object' && match !== null) return { match, kind };
      } catch {
        console.warn('Invalid JSON in span-kind-rule match attribute:', matchAttr);
      }
    }
    return null;
  }

  private _parseFilterElement(el: Element): FilterFieldConfig | null {
    const field = el.getAttribute('field');
    const label = el.getAttribute('label');
    const type = el.getAttribute('type') as FilterFieldType | null;
    const source = el.getAttribute('source') as FilterSource | null;
    if (!field || !label || !type || !source) return null;
    let options: (string | FilterOption)[] = [];
    const optionsAttr = el.getAttribute('options');
    if (optionsAttr) { try { options = JSON.parse(optionsAttr); } catch { /* ignore */ } }
    return {
      field, label, type, source,
      target: (el.getAttribute('target') as FilterTarget) || 'span',
      required: el.hasAttribute('required'),
      options: normalizeOptions(options),
      optionsSource: (el.getAttribute('options-source') as OptionsSource) || 'static',
      placeholder: el.getAttribute('placeholder') || '',
      debounce: parseInt(el.getAttribute('debounce') || '400', 10),
      width: parseInt(el.getAttribute('width') || '300', 10),
      autoRange: el.hasAttribute('auto-range'),
    };
  }

  private isTransformReady(config: TraceVisualizerConfig): config is TransformConfig {
    return [
      config.traceIdField,
      config.spanNameField,
      config.serviceNameField,
      config.timestampField,
    ].every(Boolean);
  }

  private _mergedConfig(): TraceVisualizerConfig {
    const config = { ...this._attrConfig(), ...this._programmatic };
    // Normalize spanGroupFields to always be string[] (or undefined)
    if (config.spanGroupFields && typeof config.spanGroupFields === 'string') {
      config.spanGroupFields = [config.spanGroupFields];
    }
    return config;
  }

  private resolveConfig(): DisplayConfig {
    return resolveDisplayDefaults(this._mergedConfig());
  }

  /** Resolve the active view model (prefers filter controller's, falls back to component's). */
  private get activeViewModel(): TraceViewModel | null {
    return this.filterController.activeViewModel ?? this._viewModel;
  }

  /** Resolve the active time range (O(1) from precomputed index). */
  private get activeTimeRange(): { min: number; max: number } {
    return this.activeViewModel?.timeRange ?? { min: 0, max: 0 };
  }



  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    const mergedConfig = this._mergedConfig();
    const config = resolveDisplayDefaults(mergedConfig);
    // 'full-width' is a public API class applied to the host element from outside
    this.classList.toggle('full-width', config.fullWidth);

    const fc = this.filterController;
    fc.applyConfigs(mergedConfig.filterConfigs ?? []);
    const hasFilters = fc.hasFilters();

    const filterBarHtml = hasFilters ? fc.renderFilterBar() : '';

    if (hasFilters) {
      const emptyState = fc.getFilterEmptyStateMarkup();
      if (emptyState) {
        this.shadow.innerHTML = Template.getFilteredEmptyMarkup(filterBarHtml, emptyState, config);
        fc.attachFilterListeners(this.shadow);
        return;
      }
    }

    // Apply local filters to view model if active
    const vm = this.activeViewModel;
    if (vm && hasFilters) {
      fc.applyLocalFiltersToViewModel(vm);
    }

    if (!vm || vm.isEmpty) {
      if (hasFilters) {
        this.shadow.innerHTML = Template.getFilteredEmptyMarkup(filterBarHtml, '', config);
        fc.attachFilterListeners(this.shadow);
      } else {
        this.shadow.innerHTML = Template.getEmptyMarkup();
      }
      return;
    }

    try {
      this.detachVirtualScroll();
      measure('render', () => {
        this.shadow.innerHTML = Template.getViewModelMarkup(vm, config, filterBarHtml);
      });

      const tooltip = document.createElement('div');
      tooltip.className = styles.spanTooltip;
      tooltip.style.display = 'none';
      this.shadow.appendChild(tooltip);

      if (hasFilters) fc.attachFilterListeners(this.shadow);

      this.attachViewModelEventListeners(vm);
      this.attachZoomPanListeners();
      this.observeTimelineResize();
      this.recalculateTimelineTicks();

      // Activate virtual scrolling for large datasets
      if (this.shouldVirtualScroll(vm)) {
        mark('virtual-scroll-activated', { spanCount: vm.visibleSpans.length });
        this.attachVirtualScroll(vm);
        this.dispatchEvent(new CustomEvent('virtual-scroll-activated', {
          detail: { spanCount: vm.visibleSpans.length, threshold: TraceVisualizerElement.VIRTUAL_SCROLL_THRESHOLD },
          bubbles: true, composed: true,
        }));
      }
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Rendering failed');
    }
  }

  /** Called by FilterBarController to re-render with current filter state. */
  _rerender(): void {
    this.filterController.saveFocusState(this.shadow);
    this.render();
  }

  private observeTimelineResize(): void {
    const timelineClip = this.shadow.querySelector('.' + styles.timelineClip) as HTMLElement;
    if (!timelineClip) return;

    this.resizeObserver.disconnect();
    this.resizeObserver.observe(timelineClip);
  }

  private recalculateTimelineTicks(): void {
    const timelineContainer = this.shadow.querySelector('.' + styles.timelineContainer) as HTMLElement;
    const timelineOverlay = this.shadow.querySelector(`.${styles.timelineOverlay} .${styles.timeline}`) as HTMLElement;
    if (!timelineContainer || !timelineOverlay) return;

    const timeRange = this.activeTimeRange;
    const containerWidth = timelineContainer.clientWidth;
    timelineOverlay.innerHTML = Template.getTimelineOverlayTicksMarkup(
      timeRange, containerWidth, this.zoomLevel, this.panOffset
    );
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  /** Event listeners for the ViewModel-based rendering path. */
  private attachViewModelEventListeners(vm: TraceViewModel): void {
    const spanBars = this.shadow.querySelectorAll('.' + styles.spanBar);
    const visibleSpans = vm.visibleSpans;
    const detailPanel = this.shadow.querySelector('.' + styles.detailPanel) as HTMLElement;
    const detailContent = this.shadow.querySelector('.' + styles.detailContent) as HTMLElement;
    const closeBtn = this.shadow.querySelector('.' + styles.detailPanelClose) as HTMLElement;

    spanBars.forEach((bar, index) => {
      bar.addEventListener('click', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const entry = visibleSpans.find(e => e.indexed.spanId === spanId);

        if (entry) {
          detailContent.innerHTML = Template.getViewSpanDetailMarkup(entry);
          detailPanel.classList.add(styles.detailPanelVisible);
          this.selectedSpanIndex = index;
          this.updateSpanSelection();

          this.dispatchEvent(new CustomEvent('span-selected', {
            detail: { span: entry.indexed.span },
            bubbles: true,
            composed: true,
          }));
        }
      });

      bar.addEventListener('mouseenter', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const entry = visibleSpans.find(e => e.indexed.spanId === spanId);

        if (entry) {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          this.showViewSpanTooltip(entry, rect.left, rect.bottom);
        }
      });

      bar.addEventListener('mouseleave', () => {
        this.hideTooltip();
      });
    });

    // Collapse/expand chevrons
    this.shadow.querySelectorAll('[data-collapse-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const spanId = (e.currentTarget as HTMLElement).getAttribute('data-collapse-id');
        if (spanId) {
          vm.toggleCollapse(spanId);
          this._rerender();
        }
      });
    });

    closeBtn?.addEventListener('click', () => {
      detailPanel.classList.remove(styles.detailPanelVisible);
      this.selectedSpanIndex = -1;
      this.updateSpanSelection();
    });
  }

  private attachZoomPanListeners(): void {
    const traceChart = this.shadow.querySelector('.' + styles.traceChart) as HTMLElement;
    const timelineContainer = this.shadow.querySelector('.' + styles.timelineContainer) as HTMLElement;
    if (!traceChart || !timelineContainer) return;

    timelineContainer.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();

      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(1, Math.min(10, this.zoomLevel * delta));

      if (newZoom !== this.zoomLevel) {
        this.zoomLevel = newZoom;
        this.updateZoomPan();
      }
    }, { passive: false });

    timelineContainer.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 0 && !(e.target as HTMLElement).classList.contains(styles.spanBar)) {
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartOffset = this.panOffset;
        timelineContainer.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });

    timelineContainer.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isPanning) {
        const deltaX = e.clientX - this.panStartX;
        this.panOffset = this.panStartOffset + deltaX;
        this.updateZoomPan();
      }
    });

    timelineContainer.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        timelineContainer.style.cursor = 'default';
      }
    });

    timelineContainer.addEventListener('mouseleave', () => {
      if (this.isPanning) {
        this.isPanning = false;
        timelineContainer.style.cursor = 'default';
      }
    });

    timelineContainer.addEventListener('dblclick', () => {
      this.zoomLevel = 1;
      this.panOffset = 0;
      this.updateZoomPan();
    });

    this.addZoomControls();

  }

  private clampPanOffset(): void {
    const timelineContainer = this.shadow.querySelector('.' + styles.timelineContainer) as HTMLElement;
    if (!timelineContainer) return;

    const containerWidth = timelineContainer.clientWidth;
    const scaledWidth = containerWidth * this.zoomLevel;

    if (scaledWidth <= containerWidth) {
      this.panOffset = 0;
      return;
    }

    const maxPan = 0;
    const minPan = -(scaledWidth - containerWidth);
    this.panOffset = Math.max(minPan, Math.min(maxPan, this.panOffset));
  }

  private updateZoomPan(): void {
    const timelineContainer = this.shadow.querySelector('.' + styles.timelineContainer) as HTMLElement;

    this.clampPanOffset();

    if (timelineContainer) {
      timelineContainer.style.transform = `translateX(${this.panOffset}px) scaleX(${this.zoomLevel})`;
      timelineContainer.style.transformOrigin = 'left center';
    }

    // Update timeline overlay ticks (outside scaled container)
    const timelineOverlay = this.shadow.querySelector(`.${styles.timelineOverlay} .${styles.timeline}`) as HTMLElement;
    if (timelineOverlay && timelineContainer) {
      const timeRange = this.activeTimeRange;
      const containerWidth = timelineContainer.clientWidth;
      timelineOverlay.innerHTML = Template.getTimelineOverlayTicksMarkup(
        timeRange, containerWidth, this.zoomLevel, this.panOffset
      );
    }

    const durationLabels = this.shadow.querySelectorAll('.' + styles.spanDuration);
    durationLabels.forEach(label => {
      (label as HTMLElement).style.transform = `scaleX(${1 / this.zoomLevel})`;
      (label as HTMLElement).style.transformOrigin = 'left center';
    });

    const eventMarkers = this.shadow.querySelectorAll('.' + styles.spanEvent);
    eventMarkers.forEach(marker => {
      (marker as HTMLElement).style.transform = `scaleX(${1 / this.zoomLevel})`;
      (marker as HTMLElement).style.transformOrigin = 'left center';
    });

    const zoomDisplay = this.shadow.querySelector('.' + styles.zoomDisplay) as HTMLElement;
    if (zoomDisplay) {
      zoomDisplay.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }
  }

  private addZoomControls(): void {
    const traceViewer = this.shadow.querySelector('.' + styles.traceViewer);
    if (!traceViewer) return;

    const config = this.resolveConfig();
    const controls = document.createElement('div');
    controls.className = styles.zoomControls;
    controls.innerHTML = Template.getZoomControlsMarkup(config);

    traceViewer.appendChild(controls);

    controls.querySelector('.' + styles.zoomIn)?.addEventListener('click', () => {
      this.zoomLevel = Math.min(10, this.zoomLevel * 1.2);
      this.updateZoomPan();
    });

    controls.querySelector('.' + styles.zoomOut)?.addEventListener('click', () => {
      this.zoomLevel = Math.max(1, this.zoomLevel * 0.8);
      this.updateZoomPan();
    });

    controls.querySelector('.' + styles.zoomReset)?.addEventListener('click', () => {
      this.zoomLevel = 1;
      this.panOffset = 0;
      this.updateZoomPan();
    });
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------

  private showViewSpanTooltip(entry: ViewSpan, x: number, y: number): void {
    let tooltip = this.shadow.querySelector('.' + styles.spanTooltip) as HTMLElement;

    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = styles.spanTooltip;
      this.shadow.appendChild(tooltip);
    }

    tooltip.innerHTML = Template.getViewSpanTooltipMarkup(entry);
    tooltip.style.display = 'block';
    tooltip.style.left = `${x + 10}px`;
    tooltip.style.top = `${y + 10}px`;
  }

  private hideTooltip(): void {
    const tooltip = this.shadow.querySelector('.' + styles.spanTooltip) as HTMLElement;
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard Navigation
  // ---------------------------------------------------------------------------

  private keyboardHandler = (e: KeyboardEvent) => {
    const vm = this.activeViewModel;
    if (!vm || vm.visibleSpans.length === 0) return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.selectPreviousSpan();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.selectNextSpan();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.panOffset += 50;
        this.updateZoomPan();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.panOffset -= 50;
        this.updateZoomPan();
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomLevel = Math.min(10, this.zoomLevel * 1.2);
        this.updateZoomPan();
        break;
      case '-':
      case '_':
        e.preventDefault();
        this.zoomLevel = Math.max(1, this.zoomLevel * 0.8);
        this.updateZoomPan();
        break;
      case '0':
      case 'Home':
        e.preventDefault();
        this.zoomLevel = 1;
        this.panOffset = 0;
        this.updateZoomPan();
        break;
      case 'Escape': {
        e.preventDefault();
        const detailPanel = this.shadow.querySelector('.' + styles.detailPanel);
        detailPanel?.classList.remove(styles.detailPanelVisible);
        this.selectedSpanIndex = -1;
        this.updateSpanSelection();
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (this.selectedSpanIndex >= 0) {
          this.openSpanDetails(this.selectedSpanIndex);
        }
        break;
    }
  };

  private setupKeyboardNavigation(): void {
    this.addEventListener('keydown', this.keyboardHandler);
    this.setAttribute('tabindex', '0');
  }

  private removeKeyboardNavigation(): void {
    this.removeEventListener('keydown', this.keyboardHandler);
  }

  private selectNextSpan(): void {
    const vm = this.activeViewModel;
    if (!vm || vm.visibleSpans.length === 0) return;

    this.selectedSpanIndex = Math.min(vm.visibleSpans.length - 1, this.selectedSpanIndex + 1);
    this.updateSpanSelection();
    this.scrollToSelectedSpan();
  }

  private selectPreviousSpan(): void {
    if (this.selectedSpanIndex <= 0) {
      this.selectedSpanIndex = 0;
    } else {
      this.selectedSpanIndex--;
    }
    this.updateSpanSelection();
    this.scrollToSelectedSpan();
  }

  private updateSpanSelection(): void {
    const spanBars = this.shadow.querySelectorAll('.' + styles.spanBar);
    spanBars.forEach((bar, index) => {
      if (index === this.selectedSpanIndex) {
        bar.classList.add(styles.spanBarSelected);
      } else {
        bar.classList.remove(styles.spanBarSelected);
      }
    });
  }

  private scrollToSelectedSpan(): void {
    if (this.selectedSpanIndex < 0) return;

    const config = this.resolveConfig();
    const yPosition = 50 + this.selectedSpanIndex * (config.spanHeight + config.spanPadding);
    const traceChart = this.shadow.querySelector('.' + styles.traceChart) as HTMLElement;

    if (traceChart) {
      const chartRect = traceChart.getBoundingClientRect();
      const targetY = yPosition - chartRect.height / 2;
      traceChart.scrollTop = targetY;
    }
  }

  private openSpanDetails(index: number): void {
    const vm = this.activeViewModel;
    if (!vm) return;
    const entry = vm.visibleSpans[index];
    if (!entry) return;

    const detailPanel = this.shadow.querySelector('.' + styles.detailPanel) as HTMLElement;
    const detailContent = this.shadow.querySelector('.' + styles.detailContent) as HTMLElement;

    if (detailContent) {
      detailContent.innerHTML = Template.getViewSpanDetailMarkup(entry);
    }
    detailPanel?.classList.add(styles.detailPanelVisible);

    this.dispatchEvent(new CustomEvent('span-selected', {
      detail: { span: entry.indexed.span },
      bubbles: true,
      composed: true,
    }));
  }

  // ---------------------------------------------------------------------------
  // Virtual scrolling
  // ---------------------------------------------------------------------------

  private shouldVirtualScroll(vm: TraceViewModel): boolean {
    return vm.visibleSpans.length > TraceVisualizerElement.VIRTUAL_SCROLL_THRESHOLD;
  }

  /**
   * Set up virtual scroll on the traceChart container.
   * Makes traceChart scrollable and renders only the visible window.
   */
  private attachVirtualScroll(vm: TraceViewModel): void {
    const traceChart = this.shadow.querySelector('.' + styles.traceChart) as HTMLElement;
    if (!traceChart) return;

    // Make the chart scrollable
    traceChart.style.overflowY = 'auto';

    // Initial window render
    this.renderVirtualWindow(vm, traceChart);

    // Scroll handler with requestAnimationFrame throttle
    let ticking = false;
    this._vsScrollHandler = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          this.renderVirtualWindow(vm, traceChart);
          ticking = false;
        });
      }
    };
    traceChart.addEventListener('scroll', this._vsScrollHandler, { passive: true });
  }

  private detachVirtualScroll(): void {
    if (!this._vsScrollHandler) return;
    const traceChart = this.shadow.querySelector('.' + styles.traceChart) as HTMLElement;
    if (traceChart) {
      traceChart.removeEventListener('scroll', this._vsScrollHandler);
    }
    this._vsScrollHandler = null;
  }

  /**
   * Compute the visible window and patch DOM if the window has changed.
   */
  private renderVirtualWindow(vm: TraceViewModel, container: HTMLElement): void {
    const config = this.resolveConfig();
    const rowHeight = config.spanHeight + config.spanPadding;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;

    const { startIndex, endIndex, spans } = vm.getWindow(scrollTop, viewportHeight, rowHeight);

    // Skip DOM update if the window hasn't changed
    if (startIndex === this._vsStart && endIndex === this._vsEnd) return;
    mark('virtual-scroll-window', { startIndex, endIndex, rendered: spans.length, total: vm.visibleSpans.length });
    this._vsStart = startIndex;
    this._vsEnd = endIndex;

    const timeRange = vm.timeRange;

    // Patch span bars
    const timelineContainer = this.shadow.querySelector('.' + styles.timelineContainer) as HTMLElement;
    if (timelineContainer) {
      timelineContainer.innerHTML = Template.getWindowedSpansMarkup(spans, startIndex, timeRange, config);
    }

    // Patch span labels
    const labelsContainer = this.shadow.querySelector('.' + styles.spanLabelsContainer) as HTMLElement;
    if (labelsContainer) {
      labelsContainer.innerHTML = Template.getWindowedLabelsMarkup(spans, startIndex, config);
    }

    // Re-attach click handlers on the new span bars
    this.attachWindowedSpanListeners(vm);
  }

  /** Attach click/hover listeners to windowed span bars after DOM patch. */
  private attachWindowedSpanListeners(vm: TraceViewModel): void {
    const spanBars = this.shadow.querySelectorAll('.' + styles.spanBar);
    const detailPanel = this.shadow.querySelector('.' + styles.detailPanel) as HTMLElement;
    const detailContent = this.shadow.querySelector('.' + styles.detailContent) as HTMLElement;
    const tooltip = this.shadow.querySelector('.' + styles.spanTooltip) as HTMLElement;

    spanBars.forEach((bar) => {
      bar.addEventListener('click', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const visibleSpans = vm.visibleSpans;
        const entry = visibleSpans.find(e => e.indexed.spanId === spanId);

        if (entry) {
          if (detailContent) detailContent.innerHTML = Template.getViewSpanDetailMarkup(entry);
          detailPanel?.classList.add(styles.detailPanelVisible);

          // Update selection visual
          this.shadow.querySelectorAll('.' + styles.spanBar).forEach(b =>
            b.classList.remove(styles.spanBarSelected));
          (event.currentTarget as HTMLElement).classList.add(styles.spanBarSelected);

          this.selectedSpanIndex = visibleSpans.indexOf(entry);
          this.dispatchEvent(new CustomEvent('span-selected', {
            detail: { span: entry.indexed.span },
            bubbles: true, composed: true,
          }));
        }
      });

      if (tooltip) {
        bar.addEventListener('mouseenter', (event) => {
          const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
          const entry = vm.visibleSpans.find(e => e.indexed.spanId === spanId);
          if (entry) {
            tooltip.innerHTML = Template.getViewSpanTooltipMarkup(entry);
            tooltip.style.display = 'block';
          }
        });
        bar.addEventListener('mouseleave', () => {
          tooltip.style.display = 'none';
        });
        bar.addEventListener('mousemove', (event: Event) => {
          const me = event as MouseEvent;
          tooltip.style.left = `${me.clientX + 10}px`;
          tooltip.style.top = `${me.clientY + 10}px`;
        });
      }
    });
  }

}

// ---------------------------------------------------------------------------
// FilterBarController
// ---------------------------------------------------------------------------

class FilterBarController {
  private filterConfigs: FilterFieldConfig[] = [];
  private externalValues = new Map<string, Filter>();
  private localValues = new Map<string, Filter>();
  private _activeIndex: SpanIndex | null = null;
  private _activeViewModel: TraceViewModel | null = null;
  private debounceTimers = new Map<string, number>();
  private _fetchCallback: FetchCallback | null = null;
  private _fetchInProgress = false;
  private _focusedField: { field: string; source: string; range?: string; cursorPos?: number } | null = null;
  private _openMultiselectField: string | null = null;
  private _clickOutsideAbort: AbortController | null = null;

  constructor(private host: TraceVisualizerElement) {}

  applyConfigs(configs: FilterFieldConfig[]): void {
    this.filterConfigs = configs;
    this.syncFilterState();
    this.populateAutoOptions();
  }

  get fetchCallback(): FetchCallback | null { return this._fetchCallback; }
  set fetchCallback(cb: FetchCallback | null) { this._fetchCallback = cb; }

  /** The active SpanIndex (from external fetch or component's own index). */
  get activeIndex(): SpanIndex | null { return this._activeIndex; }
  set activeIndex(index: SpanIndex | null) {
    this._activeIndex = index;
    if (index) {
      this._activeViewModel = new TraceViewModel(index);
    } else {
      this._activeViewModel = null;
    }
    this.populateAutoOptions();
  }

  /** The active view model managed by the filter controller. */
  get activeViewModel(): TraceViewModel | null { return this._activeViewModel; }

  /** Apply local filters to a view model via filterSpanIds. */
  applyLocalFiltersToViewModel(vm: TraceViewModel): void {
    const activeLocalFilters = Array.from(this.localValues.values());
    const index = vm.index;
    const ids = measure('filterSpanIds', () => filterSpanIds(index.spans.values(), activeLocalFilters));
    vm.applyFilter(ids);
  }

  /**
   * For dropdown filters with optionsSource='auto', extract unique values from data.
   */
  private populateAutoOptions(): void {
    if (!this._activeIndex) return;
    const spans = this._activeIndex.spans;

    const autoDropdowns = this.filterConfigs.filter(
      f => (f.type === 'dropdown' || f.type === 'multiselect') && f.optionsSource === 'auto'
    );
    for (const filter of autoDropdowns) {
      const uniqueValues = new Set<string>();
      for (const indexed of spans.values()) {
        const value = this.resolveIndexedFieldValue(indexed, filter);
        if (value !== undefined && value !== '') uniqueValues.add(value);
      }
      const sorted = Array.from(uniqueValues).sort((a, b) => a.localeCompare(b));
      filter.options = sorted.map(v => ({ value: v, label: v }));
    }

    this.populateAutoRange();
  }

  private populateAutoRange(): void {
    if (!this._activeIndex) return;
    const autoRangeFilters = this.filterConfigs.filter(
      f => f.type === 'datetime-range' && f.autoRange
    );
    if (autoRangeFilters.length === 0 || this._activeIndex.size === 0) return;

    const spans = this._activeIndex.spans;
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const indexed of spans.values()) {
      if (indexed.startMs < minMs) minMs = indexed.startMs;
      if (indexed.startMs > maxMs) maxMs = indexed.startMs;
    }

    const toLocal = (ms: number): string => {
      const d = new Date(ms);
      const p = (n: number) => n.toString().padStart(2, '0');
      const msStr = d.getMilliseconds().toString().padStart(3, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${msStr}`;
    };

    const from = toLocal(minMs);
    const to = toLocal(maxMs);

    for (const filter of autoRangeFilters) {
      const map = filter.source === 'external' ? this.externalValues : this.localValues;
      const existing = map.get(filter.field);
      if (!existing) continue;
      const v = existing.value as { from?: string; to?: string };
      if (!v.from && !v.to) {
        existing.value = { from, to };
      }
    }
  }

  private resolveIndexedFieldValue(indexed: IndexedSpan, filter: FilterFieldConfig): string | undefined {
    const { span, serviceName } = indexed;
    const field = filter.field;

    switch (field) {
      case 'spanName':
      case 'name':
        return span.name;
      case 'serviceName':
        return serviceName;
      case 'spanKind':
      case 'kind':
        return String(span.kind ?? '');
    }

    if (span.attributes) {
      const attr = span.attributes.find(a => a.key === field);
      if (attr) {
        if (attr.value.stringValue !== undefined) return String(attr.value.stringValue);
        if (attr.value.intValue !== undefined) return String(attr.value.intValue);
        if (attr.value.boolValue !== undefined) return String(attr.value.boolValue);
      }
    }

    if (filter.target === 'log' && span.events) {
      for (const event of span.events) {
        if (event.attributes) {
          const attr = event.attributes.find(a => a.key === field);
          if (attr) {
            if (attr.value.stringValue !== undefined) return String(attr.value.stringValue);
            if (attr.value.intValue !== undefined) return String(attr.value.intValue);
            if (attr.value.boolValue !== undefined) return String(attr.value.boolValue);
          }
        }
      }
    }

    const val = getField(span, field);
    if (val !== undefined) return String(val);

    return undefined;
  }

  hasFilters(): boolean {
    return this.filterConfigs.length > 0;
  }

  hasExternalFilters(): boolean {
    return this.filterConfigs.some(f => f.source === 'external');
  }

  hasRequiredUnfilled(): boolean {
    const externals = Array.from(this.externalValues.values());
    return externals.some(f => f.config.required) && !areRequiredExternalFiltersFilled(externals);
  }

  renderFilterBar(): string {
    const externals = this.filterConfigs.filter(f => f.source === 'external');
    const locals = this.filterConfigs.filter(f => f.source === 'local');
    const autoFetch = this.host.config.autoFetch !== false;
    return Template.getFilterBarMarkup(externals, locals, !autoFetch);
  }

  getFilterEmptyStateMarkup(): string {
    if (this._fetchInProgress) return Template.getFilterEmptyStateMarkup('loading');
    if (this.hasRequiredUnfilled()) return Template.getFilterEmptyStateMarkup('required');

    const vm = this._activeViewModel;
    if (vm && vm.visibleSpans.length === 0 && !vm.isEmpty) {
      return Template.getFilterEmptyStateMarkup('no-match');
    }
    return '';
  }

  attachFilterListeners(shadowRoot: ShadowRoot): void {
    if (this._focusedField) {
      const { field, source, range, cursorPos } = this._focusedField;
      const selector = range
        ? `[data-filter-field="${field}"][data-filter-source="${source}"][data-filter-range="${range}"]`
        : `[data-filter-field="${field}"][data-filter-source="${source}"]`;
      const el = shadowRoot.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
      if (el) {
        el.focus();
        if (cursorPos !== undefined && 'setSelectionRange' in el) {
          (el as HTMLInputElement).setSelectionRange(cursorPos, cursorPos);
        }
      }
      this._focusedField = null;
    }

    shadowRoot.querySelectorAll<HTMLInputElement>('input[data-filter-type="text"]').forEach(input => {
      const { field, source } = this.getFilterDataset(input);
      const debounceMs = parseInt(input.dataset.filterDebounce || '300', 10);
      const stored = this.getStoredValue(field, source);
      if (typeof stored === 'string') input.value = stored;

      input.addEventListener('input', () => {
        this.clearDebounce(field);
        const timerId = window.setTimeout(() => {
          this.handleFilterChange(field, source, input.value);
        }, debounceMs);
        this.debounceTimers.set(field, timerId);
      });
    });

    shadowRoot.querySelectorAll<HTMLSelectElement>('select[data-filter-type="dropdown"]').forEach(select => {
      const { field, source } = this.getFilterDataset(select);
      const stored = this.getStoredValue(field, source);
      if (typeof stored === 'string') select.value = stored;

      select.addEventListener('change', () => {
        this.handleFilterChange(field, source, select.value);
      });
    });

    shadowRoot.querySelectorAll<HTMLInputElement>('input[data-filter-type="checkbox"]').forEach(input => {
      const { field, source } = this.getFilterDataset(input);
      const stored = this.getStoredValue(field, source);
      if (typeof stored === 'boolean') input.checked = stored;

      input.addEventListener('change', () => {
        this.handleFilterChange(field, source, input.checked);
      });
    });

    shadowRoot.querySelectorAll<HTMLInputElement>('input[data-filter-type="datetime-range"]').forEach(input => {
      const { field, source } = this.getFilterDataset(input);
      const range = input.dataset.filterRange as 'from' | 'to';
      const stored = this.getStoredValue(field, source);
      if (typeof stored === 'object' && stored !== null) {
        const dtValue = stored as { from?: string; to?: string };
        input.value = (range === 'from' ? dtValue.from : dtValue.to) || '';
      }

      input.addEventListener('change', () => {
        this.handleDatetimeChange(field, source, range, input.value);
      });
    });

    this._clickOutsideAbort?.abort();
    this._clickOutsideAbort = new AbortController();

    shadowRoot.querySelectorAll<HTMLElement>('[data-filter-type="multiselect"]').forEach(wrapper => {
      const { field, source } = this.getFilterDataset(wrapper);
      const panel = wrapper.querySelector<HTMLElement>(`.${styles.filterMultiselectPanel}`);
      const trigger = wrapper.querySelector<HTMLButtonElement>('button');
      if (!panel || !trigger) return;

      const stored = this.getStoredValue(field, source);
      const selectedValues: string[] = Array.isArray(stored) ? stored : [];
      wrapper.querySelectorAll<HTMLInputElement>('input[data-filter-option]').forEach(cb => {
        cb.checked = selectedValues.includes(cb.value);
      });
      trigger.textContent = selectedValues.length === 0 ? 'All' : `${selectedValues.length} selected`;

      if (this._openMultiselectField === field) {
        panel.classList.add(styles.filterMultiselectPanelOpen);
        trigger.classList.add(styles.filterMultiselectTriggerActive);
        trigger.setAttribute('aria-expanded', 'true');
      }

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.classList.contains(styles.filterMultiselectPanelOpen);
        shadowRoot.querySelectorAll<HTMLElement>(`.${styles.filterMultiselectPanel}`).forEach(p => p.classList.remove(styles.filterMultiselectPanelOpen));
        shadowRoot.querySelectorAll<HTMLButtonElement>(`.${styles.filterMultiselectTrigger}`).forEach(b => {
          b.classList.remove(styles.filterMultiselectTriggerActive);
          b.setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          panel.classList.add(styles.filterMultiselectPanelOpen);
          trigger.classList.add(styles.filterMultiselectTriggerActive);
          trigger.setAttribute('aria-expanded', 'true');
        }
      });

      wrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          panel.classList.remove(styles.filterMultiselectPanelOpen);
          trigger.classList.remove(styles.filterMultiselectTriggerActive);
          trigger.setAttribute('aria-expanded', 'false');
          trigger.focus();
        }
      });

      wrapper.querySelectorAll<HTMLInputElement>('input[data-filter-option]').forEach(cb => {
        cb.addEventListener('change', () => {
          const checked = Array.from(
            wrapper.querySelectorAll<HTMLInputElement>('input[data-filter-option]:checked')
          ).map(el => el.value);
          trigger.textContent = checked.length === 0 ? 'All' : `${checked.length} selected`;
          this.handleFilterChange(field, source, checked);
        });
      });
    });

    shadowRoot.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (!target.closest('[data-filter-type="multiselect"]')) {
        shadowRoot.querySelectorAll<HTMLElement>(`.${styles.filterMultiselectPanel}`).forEach(p => p.classList.remove(styles.filterMultiselectPanelOpen));
        shadowRoot.querySelectorAll<HTMLButtonElement>(`.${styles.filterMultiselectTrigger}`).forEach(b => {
          b.classList.remove(styles.filterMultiselectTriggerActive);
          b.setAttribute('aria-expanded', 'false');
        });
      }
    }, { capture: true, signal: this._clickOutsideAbort.signal });

    shadowRoot.querySelector<HTMLButtonElement>('[data-filter-action="search"]')
      ?.addEventListener('click', () => this.triggerExternalFetch());

    shadowRoot.querySelector<HTMLButtonElement>('[data-filter-action="clear-local"]')
      ?.addEventListener('click', () => this.clearLocalFilters());
  }

  saveFocusState(shadowRoot: ShadowRoot): void {
    const active = shadowRoot.activeElement as HTMLElement | null;
    if (!active || !active.dataset?.filterField) {
      this._focusedField = null;
    } else {
      this._focusedField = {
        field: active.dataset.filterField,
        source: active.dataset.filterSource || '',
        range: active.dataset.filterRange,
        cursorPos: 'selectionStart' in active ? (active as HTMLInputElement).selectionStart ?? undefined : undefined,
      };
    }

    const openPanel = shadowRoot.querySelector<HTMLElement>(`.${styles.filterMultiselectPanelOpen}`);
    if (openPanel) {
      const wrapper = openPanel.closest<HTMLElement>('[data-filter-type="multiselect"]');
      this._openMultiselectField = wrapper?.dataset.filterField ?? null;
    } else {
      this._openMultiselectField = null;
    }
  }

  destroy(): void {
    for (const timerId of this.debounceTimers.values()) clearTimeout(timerId);
    this.debounceTimers.clear();
    this._clickOutsideAbort?.abort();
  }

  private syncFilterState(): void {
    const newExternal = new Map<string, Filter>();
    const newLocal = new Map<string, Filter>();

    for (const config of this.filterConfigs) {
      const defaultVal: FilterValue = config.type === 'checkbox' ? false
        : config.type === 'datetime-range' ? { from: '', to: '' }
        : config.type === 'multiselect' ? []
        : '';
      if (config.source === 'external') {
        newExternal.set(config.field, { config, value: this.externalValues.get(config.field)?.value ?? defaultVal });
      } else {
        newLocal.set(config.field, { config, value: this.localValues.get(config.field)?.value ?? defaultVal });
      }
    }
    this.externalValues = newExternal;
    this.localValues = newLocal;
  }

  private handleFilterChange(field: string, source: FilterSource, value: FilterValue): void {
    if (source === 'external') {
      const filter = this.externalValues.get(field);
      if (filter) { filter.value = value; this.externalValues.set(field, filter); }
    } else {
      const filter = this.localValues.get(field);
      if (filter) { filter.value = value; this.localValues.set(field, filter); }
    }

    const allFilters: Record<string, FilterValue> = {};
    for (const [k, v] of this.externalValues) allFilters[k] = v.value;
    for (const [k, v] of this.localValues) allFilters[k] = v.value;

    this.host.dispatchEvent(new CustomEvent('filter-changed', {
      detail: { field, source, value, allFilters },
      bubbles: true, composed: true,
    }));

    if (source === 'external') {
      if (this.host.config.autoFetch !== false) this.triggerExternalFetch();
    } else {
      this.host._rerender();
    }
  }

  private handleDatetimeChange(field: string, source: FilterSource, range: 'from' | 'to', value: string): void {
    const map = source === 'external' ? this.externalValues : this.localValues;
    const filter = map.get(field);
    if (!filter) return;

    let current = filter.value;
    if (typeof current !== 'object' || current === null) current = { from: '', to: '' };
    const dtValue = current as { from?: string; to?: string };
    if (range === 'from') dtValue.from = value; else dtValue.to = value;
    this.handleFilterChange(field, source, dtValue);
  }

  private clearLocalFilters(): void {
    for (const [, filter] of this.localValues) {
      filter.value = filter.config.type === 'checkbox' ? false
        : filter.config.type === 'datetime-range' ? { from: '', to: '' }
        : filter.config.type === 'multiselect' ? []
        : '';
    }
    this.host._rerender();
  }

  async triggerExternalFetch(): Promise<void> {
    const externals = Array.from(this.externalValues.values());

    if (!areRequiredExternalFiltersFilled(externals)) {
      this._activeIndex = null;
      this._activeViewModel = null;
      this.host._rerender();
      return;
    }

    const params = buildQueryParams(externals);
    const url = this.host.config.dataUrl;

    this._fetchInProgress = true;
    this.host._rerender();

    try {
      let data: TraceData | LogEntry[];
      if (this._fetchCallback) {
        data = await this._fetchCallback(url, params);
      } else if (url) {
        const urlParams = new URLSearchParams();
        for (const [key, val] of Object.entries(params)) {
          if (Array.isArray(val)) {
            for (const v of val) urlParams.append(key, v);
          } else {
            urlParams.set(key, val);
          }
        }
        const queryString = urlParams.toString();
        const fetchUrl = queryString ? `${url}?${queryString}` : url;
        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`Failed to load: ${response.statusText}`);
        data = await response.json() as TraceData | LogEntry[];
      } else {
        return;
      }

      const config = this.host.config;
      if (this.isTransformReady(config)) {
        const traceData = measure('transformLogs', () => transformLogs(data as LogEntry[], config as TransformConfig));
        this._activeIndex = buildSpanIndex(traceData);
      } else {
        this._activeIndex = buildSpanIndex(data as TraceData);
      }
      this._activeViewModel = new TraceViewModel(this._activeIndex);
    } catch {
      this._activeIndex = null;
      this._activeViewModel = null;
    } finally {
      this._fetchInProgress = false;
      this.host._rerender();
    }
  }

  private isTransformReady(config: TraceVisualizerConfig): boolean {
    return !!(config.traceIdField && config.spanNameField && config.serviceNameField && config.timestampField);
  }

  private getFilterDataset(el: HTMLElement): { field: string; source: FilterSource } {
    const field = el.dataset.filterField;
    const source = el.dataset.filterSource;
    if (!field || !source) {
      throw new Error('Filter element missing data-filter-field or data-filter-source');
    }
    return { field, source: source as FilterSource };
  }

  private getStoredValue(field: string, source: FilterSource): FilterValue | undefined {
    return (source === 'external' ? this.externalValues : this.localValues).get(field)?.value;
  }

  private clearDebounce(field: string): void {
    const existing = this.debounceTimers.get(field);
    if (existing !== undefined) { clearTimeout(existing); this.debounceTimers.delete(field); }
  }
}

// ---------------------------------------------------------------------------
// <trace-filter> — configuration carrier, no Shadow DOM, no rendering
// ---------------------------------------------------------------------------

class TraceFilterElement extends HTMLElement {
  private _host: TraceVisualizerElement | null = null;

  static get observedAttributes() {
    return [
      'field', 'label', 'type', 'source', 'target', 'required',
      'options', 'options-source', 'placeholder', 'debounce', 'width',
    ];
  }

  private _notify(): void { this._host?._rerender(); }

  connectedCallback(): void {
    const el = this.closest('trace-visualizer');
    this._host = el instanceof TraceVisualizerElement ? el : null;
    if (!this._host && el) {
      customElements.whenDefined('trace-visualizer').then(() => {
        this._host = this.closest<TraceVisualizerElement>('trace-visualizer');
        this._notify();
      });
      return;
    }
    this._notify();
  }
  disconnectedCallback(): void { this._notify(); this._host = null; }
  attributeChangedCallback(): void { this._notify(); }
}

// ---------------------------------------------------------------------------
// <span-kind-rule> — configuration carrier for span kind rules
// ---------------------------------------------------------------------------

class SpanKindRuleElement extends HTMLElement {
  private _host: TraceVisualizerElement | null = null;

  static get observedAttributes() {
    return ['kind', 'match-field', 'match-value', 'match'];
  }

  private _notify(): void { this._host?._rerender(); }

  connectedCallback(): void {
    const el = this.closest('trace-visualizer');
    this._host = el instanceof TraceVisualizerElement ? el : null;
    if (!this._host && el) {
      customElements.whenDefined('trace-visualizer').then(() => {
        this._host = this.closest<TraceVisualizerElement>('trace-visualizer');
        this._notify();
      });
      return;
    }
    this._notify();
  }
  disconnectedCallback(): void { this._notify(); this._host = null; }
  attributeChangedCallback(): void { this._notify(); }
}

// ---------------------------------------------------------------------------
// Register custom elements
// ---------------------------------------------------------------------------

if (!customElements.get('trace-visualizer')) {
  customElements.define('trace-visualizer', TraceVisualizerElement);
}
if (!customElements.get('trace-filter')) {
  customElements.define('trace-filter', TraceFilterElement);
}
if (!customElements.get('span-kind-rule')) {
  customElements.define('span-kind-rule', SpanKindRuleElement);
}
