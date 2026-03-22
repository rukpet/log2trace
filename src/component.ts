/**
 * Data flow step 4: Component
 *
 * Registers <trace-visualizer> custom element. Owns the Shadow DOM,
 * event handling (click, hover, keyboard), zoom/pan, and the detail panel.
 * Accepts data via HTML attributes, .traceData setter, or .logData setter.
 * CSS is injected via adoptedStyleSheets from the virtual:component-css module.
 */

import { TraceData, Span } from './opentelemetry/trace.ts';
import { TraceTree } from './trace-tree.ts';
import { Template } from './template.ts';
import { transformLogs } from './transform.ts';
import { type TraceVisualizerConfig, type TransformConfig, type DisplayConfig, resolveDisplayDefaults } from './config.ts';
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

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];
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
      'span-id-field', 'status-code-field',
      // Display
      'width', 'height', 'background-color', 'span-height', 'span-padding',
      'show-legend', 'full-width', 'detail-panel-width', 'color-scheme',
    ];
  }

  connectedCallback() {
    this.render();
    this.setupKeyboardNavigation();

    const dataUrl = this.getAttribute('data-url');
    if (dataUrl) {
      const merged = this.config;
      if (this.isTransformReady(merged)) {
        this.loadAndTransform(dataUrl, merged);
      } else {
        this.loadTraceData(dataUrl);
      }
    }
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
    this.removeKeyboardNavigation();
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
    this.render();
  }

  get traceData(): TraceTree {
    return this._tree;
  }

  /**
   * Set raw log data with transform configuration.
   * Convenience wrapper: transforms logs internally and renders the result.
   */
  set logData(input: { logs: unknown[]; config: TransformConfig }) {
    this.traceData = transformLogs(input.logs, input.config);
  }

  /**
   * Set configuration programmatically (flat: transform + display fields)
   */
  set config(config: TraceVisualizerConfig) {
    this._programmatic = { ...this._programmatic, ...config };
    this.render();
  }

  get config(): TraceVisualizerConfig {
    return { ...this._attrConfig(), ...this._programmatic };
  }

  /** Load pre-formatted OTel TraceData from URL. */
  async loadTraceData(url: string): Promise<void> {
    try {
      this.shadow.innerHTML = Template.getLoadingMarkup();
      this.traceData = await this.fetchJson(url);
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  /** Load raw logs from URL and transform them into TraceData. */
  async loadAndTransform(url: string, config: TransformConfig): Promise<void> {
    try {
      this.shadow.innerHTML = Template.getLoadingMarkup();
      const logs = await this.fetchJson(url);
      this.traceData = transformLogs(logs, config);
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  private async fetchJson(url: string): Promise<any> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load: ${response.statusText}`);
    }
    return response.json();
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

    const config: TraceVisualizerConfig = {};

    // Data
    const dataUrl = str('data-url');
    if (dataUrl !== undefined) config.dataUrl = dataUrl;

    // Transform fields
    const traceIdField = str('trace-id-field');
    if (traceIdField !== undefined) config.traceIdField = traceIdField;
    const spanGroupFields = csv('span-group-fields');
    if (spanGroupFields !== undefined) config.spanGroupFields = spanGroupFields;
    const spanNameField = str('span-name-field');
    if (spanNameField !== undefined) config.spanNameField = spanNameField;
    const serviceNameField = str('service-name-field');
    if (serviceNameField !== undefined) config.serviceNameField = serviceNameField;
    const timestampField = str('timestamp-field');
    if (timestampField !== undefined) config.timestampField = timestampField;
    const endTimeField = str('end-time-field');
    if (endTimeField !== undefined) config.endTimeField = endTimeField;
    const parentSpanIdField = str('parent-span-id-field');
    if (parentSpanIdField !== undefined) config.parentSpanIdField = parentSpanIdField;
    const parentSpanLookupFields = csv('parent-span-lookup-fields');
    if (parentSpanLookupFields !== undefined) config.parentSpanLookupFields = parentSpanLookupFields;
    const spanIdField = str('span-id-field');
    if (spanIdField !== undefined) config.spanIdField = spanIdField;
    const statusCodeField = str('status-code-field');
    if (statusCodeField !== undefined) config.statusCodeField = statusCodeField;

    // Display fields
    const width = num('width');
    if (width !== undefined) config.width = width;
    const height = num('height');
    if (height !== undefined) config.height = height;
    const backgroundColor = str('background-color');
    if (backgroundColor !== undefined) config.backgroundColor = backgroundColor;
    const spanHeight = num('span-height');
    if (spanHeight !== undefined) config.spanHeight = spanHeight;
    const spanPadding = num('span-padding');
    if (spanPadding !== undefined) config.spanPadding = spanPadding;
    const showLegend = bool('show-legend');
    if (showLegend !== undefined) config.showLegend = showLegend;
    const fullWidth = bool('full-width');
    if (fullWidth !== undefined) config.fullWidth = fullWidth;
    const detailPanelWidth = str('detail-panel-width');
    if (detailPanelWidth !== undefined) config.detailPanelWidth = detailPanelWidth;

    const colorSchemeAttr = this.getAttribute('color-scheme');
    if (colorSchemeAttr) {
      try { config.colorScheme = JSON.parse(colorSchemeAttr); } catch { /* ignore */ }
    }

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

  private resolveConfig(): DisplayConfig {
    const merged = { ...this._attrConfig(), ...this._programmatic };
    return resolveDisplayDefaults(merged);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    const config = this.resolveConfig();
    // 'full-width' is a public API class applied to the host element from outside
    this.classList.toggle('full-width', config.fullWidth);

    if (this._tree.roots.length === 0) {
      this.shadow.innerHTML = Template.getEmptyMarkup();
      return;
    }

    try {
      this.shadow.innerHTML = Template.getTraceMarkup(this._tree, config);

      // Create persistent tooltip element
      const tooltip = document.createElement('div');
      tooltip.className = styles.spanTooltip;
      tooltip.style.display = 'none';
      this.shadow.appendChild(tooltip);

      this.attachEventListeners(this._tree);
      this.attachZoomPanListeners();
      this.observeTimelineResize();
      this.recalculateTimelineTicks();
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Rendering failed');
    }
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

    const timeRange = this._tree.getTimeRange();
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
          detailContent.textContent = this.getSpanDetailContent(entry.span);
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
          const serviceName = tree.serviceNameOf.get(entry.span.spanId) || 'unknown-service';
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          this.showTooltip(entry.span, serviceName, rect.left, rect.bottom);
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
      const timeRange = this._tree.getTimeRange();
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

  private showTooltip(span: Span, serviceName: string, x: number, y: number): void {
    let tooltip = this.shadow.querySelector('.' + styles.spanTooltip) as HTMLElement;

    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = styles.spanTooltip;
      this.shadow.appendChild(tooltip);
    }

    tooltip.innerHTML = Template.getTooltipMarkup(span, serviceName);
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

  private getSpanDetailContent(span: Span): string {
    return JSON.stringify(span, null, 2);
  }

  private openSpanDetails(index: number): void {
    const flatSpans = this._tree.flatten();
    const entry = flatSpans[index];
    if (!entry) return;

    const detailPanel = this.shadow.querySelector('.' + styles.detailPanel) as HTMLElement;
    const detailContent = this.shadow.querySelector('.' + styles.detailContent) as HTMLElement;

    if (detailContent) {
      detailContent.textContent = this.getSpanDetailContent(entry.span);
    }
    detailPanel?.classList.add(styles.detailPanelVisible);

    this.dispatchEvent(new CustomEvent('span-selected', {
      detail: { span: entry.span },
      bubbles: true,
      composed: true
    }));
  }

}

// Register the custom element
if (!customElements.get('trace-visualizer')) {
  customElements.define('trace-visualizer', TraceVisualizerElement);
}
