/**
 * Data flow steps 1 & 5: Component
 *
 * Registers <trace-visualizer> custom element. Owns the Shadow DOM,
 * event handling (click, hover, keyboard), zoom/pan, and the detail panel.
 * Accepts data via HTML attributes, .traceData setter, or .logData setter.
 * CSS is injected via adoptedStyleSheets from the virtual:component-css module.
 */

import { TraceData } from './opentelemetry/trace.ts';
import { TraceTree, type FlatSpan } from './trace-tree.ts';
import { Template } from './template.ts';
import { transformLogs, getField } from './transform.ts';
import {
  type TraceVisualizerConfig, type TransformConfig, type DisplayConfig,
  type FilterFieldConfig, type FilterFieldType, type FilterSource, type FilterTarget,
  type FilterValue, type Filter, type FetchCallback, type OptionsSource,
  type SpanKindRule, type LogEntry,
  resolveDisplayDefaults, normalizeOptions,
} from './config.ts';
import { filterSpans, areRequiredExternalFiltersFilled, buildQueryParams } from './filter.ts';
import componentCss from 'virtual:component-css';
import * as styles from './styles.css.ts';

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(componentCss);

/**
 * Custom Web Component for trace visualization
 * Usage: <trace-visualizer></trace-visualizer>
 */
export class TraceVisualizerElement extends HTMLElement {
  private _tree = new TraceTree([], new Map(), new Map());
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
      'span-id-field', 'status-code-field', 'span-kind-rules', 'default-span-kind',
      // Display
      'width', 'height', 'background-color', 'span-height', 'span-padding',
      'show-legend', 'full-width', 'detail-panel-width', 'color-scheme',
      // Filter
      'auto-fetch',
    ];
  }

  connectedCallback() {
    // Re-parse filter children (may not be available in constructor)
    this.filterController.parseFilterChildren();

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
  }

  attributeChangedCallback(_name: string, oldValue: string, newValue: string) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  /**
   * Set trace data programmatically
   */
  set traceData(data: TraceData) {
    this._tree = TraceTree.build(data);
    this.filterController.cachedTree = this._tree;
    this.render();
  }

  get traceData(): TraceTree {
    return this._tree;
  }

  /**
   * Set raw log data with transform configuration.
   * Convenience wrapper: transforms logs internally and renders the result.
   */
  set logData(input: { logs: LogEntry[]; config: TransformConfig }) {
    this.traceData = transformLogs(input.logs, input.config);
  }

  /** Custom fetch callback for external filter queries. */
  set fetchCallback(cb: FetchCallback | null) {
    this.filterController.fetchCallback = cb;
  }

  get fetchCallback(): FetchCallback | null {
    return this.filterController.fetchCallback;
  }

  /**
   * Set configuration programmatically (flat: transform + display fields).
   *
   * **Behavior:** Shallow-merges into programmatic config. Repeated calls accumulate:
   * ```js
   * el.config = { width: 500 };
   * el.config = { height: 300 };
   * // Both width and height are now set programmatically
   * ```
   *
   * **To unset a field** and fall back to its HTML attribute value, pass `undefined`:
   * ```js
   * el.config = { width: undefined };  // Remove override, use width attribute
   * ```
   *
   * **Priority:** Programmatic config takes precedence over HTML attributes.
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
   * Get the current merged configuration (HTML attributes + programmatic overrides).
   * Programmatic values take precedence over HTML attributes.
   */
  get config(): TraceVisualizerConfig {
    return this._mergedConfig();
  }

  /** Load pre-formatted OTel TraceData from URL. */
  async loadTraceData(url: string): Promise<void> {
    try {
      this.shadow.innerHTML = Template.getLoadingMarkup();
      this.traceData = await this.fetchJson<TraceData>(url);
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  /** Load raw logs from URL and transform them into TraceData. */
  async loadAndTransform(url: string, config: TransformConfig): Promise<void> {
    try {
      this.shadow.innerHTML = Template.getLoadingMarkup();
      const logs = await this.fetchJson<LogEntry[]>(url);
      this.traceData = transformLogs(logs, config);
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
    // Merge span-kind-rules from attribute and parsed child elements
    const attrRules = json('span-kind-rules') as SpanKindRule[] | undefined;
    const parsedRules = this.parseSpanKindRuleChildren();
    const mergedRules = [...(attrRules || []), ...parsedRules];
    if (mergedRules.length > 0) {
      set('spanKindRules', mergedRules);
    }
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

  /**
   * Parse <span-kind-rule> child elements into SpanKindRule objects.
   * Supports two syntaxes:
   * 1. Simple: <span-kind-rule match-field="text.ClassName" match-value="API" kind="Server"></span-kind-rule>
   * 2. Complex: <span-kind-rule match='{"text.ClassName":"API","text.MethodName":"GetUser"}' kind="Server"></span-kind-rule>
   */
  private parseSpanKindRuleChildren(): SpanKindRule[] {
    const rules: SpanKindRule[] = [];
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      if (child.tagName.toLowerCase() !== 'span-kind-rule') continue;

      const kind = child.getAttribute('kind');
      if (!kind) continue;

      // Try simple syntax first (match-field + match-value)
      const matchField = child.getAttribute('match-field');
      const matchValue = child.getAttribute('match-value');
      if (matchField && matchValue) {
        rules.push({ match: { [matchField]: matchValue }, kind });
        continue;
      }

      // Fall back to complex syntax (match JSON)
      const matchAttr = child.getAttribute('match');
      if (matchAttr) {
        try {
          const match = JSON.parse(matchAttr);
          if (typeof match === 'object' && match !== null) {
            rules.push({ match, kind });
          }
        } catch {
          console.warn('Invalid JSON in span-kind-rule match attribute:', matchAttr);
        }
      }
    }
    return rules;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    const config = this.resolveConfig();
    // 'full-width' is a public API class applied to the host element from outside
    this.classList.toggle('full-width', config.fullWidth);

    const fc = this.filterController;
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

    const filteredSpans = hasFilters ? fc.getFilteredSpans() : null;
    const tree = fc.cachedTree ?? this._tree;

    if (tree.roots.length === 0) {
      if (hasFilters) {
        this.shadow.innerHTML = Template.getFilteredEmptyMarkup(filterBarHtml, '', config);
        fc.attachFilterListeners(this.shadow);
      } else {
        this.shadow.innerHTML = Template.getEmptyMarkup();
      }
      return;
    }

    try {
      this.shadow.innerHTML = Template.getTraceMarkup(tree, config, filterBarHtml, filteredSpans);

      const tooltip = document.createElement('div');
      tooltip.className = styles.spanTooltip;
      tooltip.style.display = 'none';
      this.shadow.appendChild(tooltip);

      if (hasFilters) fc.attachFilterListeners(this.shadow);

      this.attachEventListeners(tree);
      this.attachZoomPanListeners();
      this.observeTimelineResize();
      this.recalculateTimelineTicks();
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

    const timeRange = (this.filterController.cachedTree ?? this._tree).getTimeRange();
    const containerWidth = timelineContainer.clientWidth;
    timelineOverlay.innerHTML = Template.getTimelineOverlayTicksMarkup(
      timeRange, containerWidth, this.zoomLevel, this.panOffset
    );
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  private attachEventListeners(tree: TraceTree): void {
    const spanBars = this.shadow.querySelectorAll('.' + styles.spanBar);
    const flatSpans = tree.flatten();
    const detailPanel = this.shadow.querySelector('.' + styles.detailPanel) as HTMLElement;
    const detailContent = this.shadow.querySelector('.' + styles.detailContent) as HTMLElement;
    const closeBtn = this.shadow.querySelector('.' + styles.detailPanelClose) as HTMLElement;

    spanBars.forEach((bar, index) => {
      // Click handler
      bar.addEventListener('click', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const entry = flatSpans.find(e => e.span.spanId === spanId);

        if (entry) {
          detailContent.innerHTML = Template.getSpanDetailMarkup(entry);

          detailPanel.classList.add(styles.detailPanelVisible);
          this.selectedSpanIndex = index;
          this.updateSpanSelection();

          this.dispatchEvent(new CustomEvent('span-selected', {
            detail: { span: entry.span },
            bubbles: true,
            composed: true
          }));
        }
      });

      // Hover tooltip handler
      bar.addEventListener('mouseenter', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const entry = flatSpans.find(e => e.span.spanId === spanId);

        if (entry) {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          this.showTooltip(entry, rect.left, rect.bottom);
        }
      });

      bar.addEventListener('mouseleave', () => {
        this.hideTooltip();
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
      const timeRange = (this.filterController.cachedTree ?? this._tree).getTimeRange();
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

  private showTooltip(entry: FlatSpan, x: number, y: number): void {
    let tooltip = this.shadow.querySelector('.' + styles.spanTooltip) as HTMLElement;

    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = styles.spanTooltip;
      this.shadow.appendChild(tooltip);
    }

    tooltip.innerHTML = Template.getTooltipMarkup(entry);
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
    const flatSpans = this._tree.flatten();
    if (flatSpans.length === 0) return;

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
    const flatSpans = this._tree.flatten();
    if (flatSpans.length === 0) return;

    this.selectedSpanIndex = Math.min(flatSpans.length - 1, this.selectedSpanIndex + 1);
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
    const flatSpans = this._tree.flatten();
    const entry = flatSpans[index];
    if (!entry) return;

    const detailPanel = this.shadow.querySelector('.' + styles.detailPanel) as HTMLElement;
    const detailContent = this.shadow.querySelector('.' + styles.detailContent) as HTMLElement;

    if (detailContent) {
      detailContent.innerHTML = Template.getSpanDetailMarkup(entry);
    }
    detailPanel?.classList.add(styles.detailPanelVisible);

    this.dispatchEvent(new CustomEvent('span-selected', {
      detail: { span: entry.span },
      bubbles: true,
      composed: true
    }));
  }


}

// ---------------------------------------------------------------------------
// FilterBarController
// ---------------------------------------------------------------------------

class FilterBarController {
  private filterConfigs: FilterFieldConfig[] = [];
  private externalValues = new Map<string, Filter>();
  private localValues = new Map<string, Filter>();
  private _cachedTree: TraceTree | null = null;
  private _filteredSpans: FlatSpan[] | null = null;
  private debounceTimers = new Map<string, number>();
  private mutationObserver: MutationObserver | null = null;
  private _fetchCallback: FetchCallback | null = null;
  private _fetchInProgress = false;
  private _focusedField: { field: string; source: string; range?: string; cursorPos?: number } | null = null;

  constructor(private host: TraceVisualizerElement) {
    this.parseFilterChildren();
    this.setupMutationObserver();
  }

  get fetchCallback(): FetchCallback | null { return this._fetchCallback; }
  set fetchCallback(cb: FetchCallback | null) { this._fetchCallback = cb; }

  get cachedTree(): TraceTree | null { return this._cachedTree; }
  set cachedTree(tree: TraceTree | null) {
    this._cachedTree = tree;
    this._filteredSpans = null;
    this.populateAutoOptions();
  }

  /**
   * For dropdown filters with optionsSource='auto', extract unique values from data.
   */
  private populateAutoOptions(): void {
    const autoFilters = this.filterConfigs.filter(
      f => f.type === 'dropdown' && f.optionsSource === 'auto'
    );
    if (autoFilters.length === 0 || !this._cachedTree) return;

    const flatSpans = this._cachedTree.flatten();
    for (const filter of autoFilters) {
      const uniqueValues = new Set<string>();

      for (const flatSpan of flatSpans) {
        const value = this.resolveFieldValue(flatSpan, filter);
        if (value !== undefined && value !== '') {
          uniqueValues.add(value);
        }
      }

      // Sort alphabetically and convert to FilterOption[]
      const sorted = Array.from(uniqueValues).sort((a, b) => a.localeCompare(b));
      filter.options = sorted.map(v => ({ value: v, label: v }));
    }
  }

  private resolveFieldValue(flatSpan: FlatSpan, filter: FilterFieldConfig): string | undefined {
    const { span, serviceName } = flatSpan;
    const field = filter.field;

    // Handle special built-in fields
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

    // Try span attributes
    if (span.attributes) {
      const attr = span.attributes.find(a => a.key === field);
      if (attr) {
        if (attr.value.stringValue !== undefined) return String(attr.value.stringValue);
        if (attr.value.intValue !== undefined) return String(attr.value.intValue);
        if (attr.value.boolValue !== undefined) return String(attr.value.boolValue);
      }
    }

    // Try log/event attributes if target is 'log'
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

    // Fallback: try getField for nested paths
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

  getFilteredSpans(): FlatSpan[] | null {
    if (!this._cachedTree) return null;
    if (this._filteredSpans) return this._filteredSpans;

    const flatSpans = this._cachedTree.flatten();
    const activeLocalFilters = Array.from(this.localValues.values());
    this._filteredSpans = filterSpans(flatSpans, activeLocalFilters);
    return this._filteredSpans;
  }

  getFilterEmptyStateMarkup(): string {
    if (this._fetchInProgress) return Template.getFilterEmptyStateMarkup('loading');
    if (this.hasRequiredUnfilled()) return Template.getFilterEmptyStateMarkup('required');

    const filtered = this.getFilteredSpans();
    if (filtered && filtered.length === 0 && this._cachedTree && this._cachedTree.roots.length > 0) {
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

    shadowRoot.querySelectorAll<HTMLInputElement>('input[data-filter-type="datetime"]').forEach(input => {
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

    shadowRoot.querySelector<HTMLButtonElement>('[data-filter-action="search"]')
      ?.addEventListener('click', () => this.triggerExternalFetch());

    shadowRoot.querySelector<HTMLButtonElement>('[data-filter-action="clear-local"]')
      ?.addEventListener('click', () => this.clearLocalFilters());
  }

  saveFocusState(shadowRoot: ShadowRoot): void {
    const active = shadowRoot.activeElement as HTMLElement | null;
    if (!active || !active.dataset?.filterField) {
      this._focusedField = null;
      return;
    }
    this._focusedField = {
      field: active.dataset.filterField,
      source: active.dataset.filterSource || '',
      range: active.dataset.filterRange,
      cursorPos: 'selectionStart' in active ? (active as HTMLInputElement).selectionStart ?? undefined : undefined,
    };
  }

  destroy(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    for (const timerId of this.debounceTimers.values()) clearTimeout(timerId);
    this.debounceTimers.clear();
  }

  parseFilterChildren(): void {
    const configs: FilterFieldConfig[] = [];
    for (let i = 0; i < this.host.children.length; i++) {
      const child = this.host.children[i];
      if (child.tagName.toLowerCase() !== 'trace-filter') continue;

      const field = child.getAttribute('field');
      const label = child.getAttribute('label');
      const type = child.getAttribute('type') as FilterFieldType | null;
      const source = child.getAttribute('source') as FilterSource | null;
      if (!field || !label || !type || !source) continue;

      let options = [];
      const optionsAttr = child.getAttribute('options');
      if (optionsAttr) {
        try { options = JSON.parse(optionsAttr); } catch { /* ignore */ }
      }

      const optionsSource = (child.getAttribute('options-source') as OptionsSource) || 'static';

      const config: FilterFieldConfig = {
        field, label, type, source,
        target: (child.getAttribute('target') as FilterTarget) || 'span',
        required: child.hasAttribute('required'),
        options: normalizeOptions(options),
        optionsSource,
        placeholder: child.getAttribute('placeholder') || '',
        debounce: parseInt(child.getAttribute('debounce') || '400', 10),
        width: parseInt(child.getAttribute('width') || '300', 10)
      };

      configs.push(config);
    }
    this.filterConfigs = configs;
    this.syncFilterState();
  }

  private syncFilterState(): void {
    const newExternal = new Map<string, Filter>();
    const newLocal = new Map<string, Filter>();

    for (const config of this.filterConfigs) {
      const defaultVal = config.type === 'checkbox' ? false : config.type === 'datetime' ? { from: '', to: '' } : '';
      if (config.source === 'external') {
        newExternal.set(config.field, { config, value: this.externalValues.get(config.field)?.value ?? defaultVal });
      } else {
        newLocal.set(config.field, { config, value: this.localValues.get(config.field)?.value ?? defaultVal });
      }
    }
    this.externalValues = newExternal;
    this.localValues = newLocal;
  }

  private setupMutationObserver(): void {
    this.mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' ||
            (m.type === 'attributes' && m.target instanceof HTMLElement &&
             m.target.tagName.toLowerCase() === 'trace-filter')) {
          this.parseFilterChildren();
          this.host._rerender();
          return;
        }
      }
    });

    this.mutationObserver.observe(this.host, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['field', 'label', 'type', 'source', 'target', 'required', 'options', 'options-source', 'placeholder', 'debounce'],
    });
  }

  private handleFilterChange(field: string, source: FilterSource, value: FilterValue): void {
    if (source === 'external') {
      const filter = this.externalValues.get(field);
      if (filter) { filter.value = value; this.externalValues.set(field, filter); }
    } else {
      const filter = this.localValues.get(field);
      if (filter) { filter.value = value; this.localValues.set(field, filter); this._filteredSpans = null; }
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
        : filter.config.type === 'datetime' ? { from: '', to: '' } : '';
    }
    this._filteredSpans = null;
    this.host._rerender();
  }

  async triggerExternalFetch(): Promise<void> {
    const externals = Array.from(this.externalValues.values());

    if (!areRequiredExternalFiltersFilled(externals)) {
      this._cachedTree = null;
      this._filteredSpans = null;
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
        const queryString = new URLSearchParams(params).toString();
        const fetchUrl = queryString ? `${url}?${queryString}` : url;
        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`Failed to load: ${response.statusText}`);
        data = await response.json() as TraceData | LogEntry[];
      } else {
        return;
      }

      const config = this.host.config;
      if (this.isTransformReady(config)) {
        const traceData = transformLogs(data as LogEntry[], config as TransformConfig);
        this._cachedTree = TraceTree.build(traceData);
      } else {
        this._cachedTree = TraceTree.build(data as TraceData);
      }
      this._filteredSpans = null;
    } catch {
      this._cachedTree = null;
      this._filteredSpans = null;
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

class TraceFilterElement extends HTMLElement {}

// ---------------------------------------------------------------------------
// <span-kind-rule> — configuration carrier for span kind rules
// ---------------------------------------------------------------------------

class SpanKindRuleElement extends HTMLElement {}

// ---------------------------------------------------------------------------
// Register custom elements
// ---------------------------------------------------------------------------

if (!customElements.get('trace-filter')) {
  customElements.define('trace-filter', TraceFilterElement);
}
if (!customElements.get('span-kind-rule')) {
  customElements.define('span-kind-rule', SpanKindRuleElement);
}
if (!customElements.get('trace-visualizer')) {
  customElements.define('trace-visualizer', TraceVisualizerElement);
}
