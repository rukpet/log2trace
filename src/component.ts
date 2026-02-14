import { TraceData, Span, SpanKind } from './opentelemetry/trace.js';
import { nanoToMilli } from './time.js';
import { TraceTree } from './trace-tree.js';
import { VisualizationConfig } from './visualization-config.js';
import css from './styles.css';

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(css);

/**
 * Custom Web Component for trace visualization
 * Usage: <trace-visualizer></trace-visualizer>
 */
export class TraceVisualizerElement extends HTMLElement {
  private _tree = new TraceTree([], new Map(), new Map());
  private _overrides: Partial<VisualizationConfig> = {};
  private shadow: ShadowRoot;
  private zoomLevel: number = 1; //  TODO: limit zooming because right now you can zomm too far
  private panOffset: number = 0;
  private isPanning: boolean = false; // TODO: limit panning because right now you can pan infinitely
  private panStartX: number = 0;
  private panStartOffset: number = 0;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];
  }

  static get observedAttributes() {
    return ['data-url', 'width', 'height', 'show-events', 'show-legend', 'full-width', 'detail-panel-width'];
  }

  connectedCallback() {
    this.render();

    // Load data from URL if specified
    const dataUrl = this.getAttribute('data-url');
    if (dataUrl) {
      this.loadTraceData(dataUrl);
    }
  }

  attributeChangedCallback(_name: string, oldValue: string, newValue: string) {
    if (oldValue !== newValue) {
      this.updateConfigFromAttributes();
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
   * Set visualization configuration
   */
  set config(config: Partial<VisualizationConfig>) {
    this._overrides = { ...this._overrides, ...config };
    this.render();
  }

  get config(): VisualizationConfig {
    return new VisualizationConfig(this._overrides);
  }

  /**
   * Load trace data from URL
   */
  async loadTraceData(url: string): Promise<void> {
    try {
      this.renderLoading();
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load: ${response.statusText}`);
      }
      const data = await response.json();
      this.traceData = data;
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  private updateConfigFromAttributes(): void {
    const width = this.getAttribute('width');
    const height = this.getAttribute('height');
    const showEvents = this.getAttribute('show-events');
    const showLegend = this.getAttribute('show-legend');
    const fullWidth = this.getAttribute('full-width');
    const detailPanelWidth = this.getAttribute('detail-panel-width');

    this._overrides = {
      ...this._overrides,
      width: width ? parseInt(width, 10) : undefined,
      height: height ? parseInt(height, 10) : undefined,
      showEvents: showEvents !== 'false',
      showLegend: showLegend !== null && showLegend !== 'false',
      fullWidth: fullWidth !== null && fullWidth !== 'false',
      detailPanelWidth: detailPanelWidth || undefined,
    };
  }

  private resolveConfig(): VisualizationConfig {
    return new VisualizationConfig(this._overrides);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    const config = this.resolveConfig();
    this.classList.toggle('full-width', config.fullWidth);

    if (this._tree.roots.length === 0) {
      this.renderEmpty();
      return;
    }

    try {
      this.shadow.innerHTML = this.renderTrace(this._tree);
      this.attachEventListeners(this._tree);
      this.attachZoomPanListeners();
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : 'Rendering failed');
    }
  }

  private renderTrace(tree: TraceTree): string {
    const config = this.resolveConfig();
    const flatSpans = tree.flatten();
    const timeRange = tree.getTimeRange();
    const chartHeight = flatSpans.length * (config.spanHeight + config.spanPadding);
    const totalHeight = Math.max(chartHeight + 100, config.height);
    const traceId = tree.roots[0]?.traceId || 'N/A';

    return `
      <div class="trace-viewer" style="background: ${config.backgroundColor};">
        <div class="trace-header">
          <h3>Trace: ${traceId}</h3>
          <div class="trace-stats">
            <span>Total Spans: ${flatSpans.length}</span>
            <span>Duration: ${this.formatDuration(timeRange.max - timeRange.min)}</span>
          </div>
        </div>
        <div class="trace-body" style="height: ${totalHeight}px;">
          <div class="trace-chart">
            <div class="span-labels-container">
              ${this.renderSpanLabels(tree, flatSpans, config)}
            </div>
            <div class="timeline-container">
              ${this.renderTimeline(timeRange)}
              ${this.renderSpans(flatSpans, timeRange, config)}
            </div>
          </div>
          <div class="detail-panel" style="width: ${config.detailPanelWidth};">
            <div class="detail-panel-header">
              <h3>Span Details</h3>
              <button class="detail-panel-close" title="Close">&times;</button>
            </div>
            <div class="detail-content"></div>
          </div>
        </div>
      </div>
    `;
  }

  private renderLegend(config: VisualizationConfig): string {
    const items = Object.entries(config.colorScheme)
      .filter(([kindValue]) => Number(kindValue) !== SpanKind.Unspecified)
      .map(([kindValue, color]) => {
        const label = SpanKind[Number(kindValue)] || 'Unknown';
        return `
          <div class="legend-item">
            <div class="legend-color" style="background: ${color};"></div>
            <span>${label}</span>
          </div>
        `;
      })
      .join('');

    return `<div class="legend">${items}</div>`;
  }

  private renderSpanLabels(
    tree: TraceTree,
    flatSpans: Array<{ span: Span; level: number }>,
    config: VisualizationConfig
  ): string {
    return flatSpans.map(({ span, level }, index) => {
      const yPosition = 50 + index * (config.spanHeight + config.spanPadding);
      const indent = level * 20;
      const statusIcon = this.getStatusIcon(span.status?.code ?? 0);
      const serviceName = tree.serviceNameOf.get(span.spanId) || 'unknown-service';

      return `
        <div class="span-label-fixed" style="top:${yPosition}px;left:${indent}px;width:${230 - indent}px;height:${config.spanHeight}px" title="${span.name}">
          <span class="status-icon">${statusIcon}</span>
          <strong>${serviceName}</strong>
          <br/>
          <small>${span.name}</small>
        </div>
      `;
    }).join('');
  }

  private renderTimeline(timeRange: { min: number; max: number }): string {
    const duration = timeRange.max - timeRange.min;
    const ticks = 10;
    const tickElements: string[] = [];

    for (let i = 0; i <= ticks; i++) {
      const position = (i / ticks) * 100;
      const relativeTime = (duration * i / ticks);

      tickElements.push(`
        <div class="timeline-tick" style="left: ${position}%;">
          <div class="timeline-label">${this.formatDuration(relativeTime)}</div>
        </div>
      `);
    }

    return `
      <div class="timeline">
        ${tickElements.join('')}
      </div>
    `;
  }

  private renderSpans(
    flatSpans: Array<{ span: Span; level: number }>,
    timeRange: { min: number; max: number },
    config: VisualizationConfig
  ): string {
    return flatSpans.map(({ span }, index) =>
      this.renderSpan(span, index, timeRange, config)
    ).join('');
  }

  private renderSpan(
    span: Span,
    index: number,
    timeRange: { min: number; max: number },
    config: VisualizationConfig
  ): string {
    const yPosition = 50 + index * (config.spanHeight + config.spanPadding);
    const color = config.colorScheme[span.kind] || '#999';

    const totalDuration = timeRange.max - timeRange.min;
    const startMs = nanoToMilli(span.startTimeUnixNano);
    const endMs = nanoToMilli(span.endTimeUnixNano);
    const spanDuration = endMs - startMs;
    const startPercent = ((startMs - timeRange.min) / totalDuration) * 100;
    const widthPercent = (spanDuration / totalDuration) * 100;

    const kindLabel = SpanKind[span.kind];

    return `
      <div class="span-row" style="top:${yPosition}px;height:${config.spanHeight}px">
        <div class="span-bar"
             style="left:${startPercent}%;width:${Math.max(widthPercent, 0.5)}%;background:${color}"
             data-span-id="${span.spanId}"
             title="${span.name}\nDuration: ${this.formatDuration(spanDuration)}\nKind: ${kindLabel}">
          <div class="span-duration">
            ${this.formatDuration(spanDuration)}
          </div>
          ${config.showEvents ? this.renderEvents(span) : ''}
        </div>
      </div>
    `;
  }

  private renderEvents(span: Span): string {
    if (!span.events || span.events.length === 0) return '';

    const startMs = nanoToMilli(span.startTimeUnixNano);
    const spanDuration = nanoToMilli(span.endTimeUnixNano) - startMs;

    return span.events.map(event => {
      const eventMs = nanoToMilli(event.timeUnixNano);
      const eventOffset = ((eventMs - startMs) / spanDuration) * 100;
      return `
        <div class="span-event"
             style="left:${eventOffset}%"
             title="${event.name}\nTime: ${this.formatDuration(eventMs - startMs)}">
        </div>
      `;
    }).join('');
  }

  private renderLoading(): void {
    this.shadow.innerHTML = `
      <div class="trace-viewer">
        <div class="message loading">
          <div class="spinner"></div>
          Loading trace data...
        </div>
      </div>
    `;
  }

  private renderEmpty(): void {
    this.shadow.innerHTML = `
      <div class="trace-viewer">
        <div class="message empty">
          No trace data loaded. Set the <code>data-url</code> attribute or use <code>.traceData</code> property.
        </div>
      </div>
    `;
  }

  private renderError(message: string): void {
    this.shadow.innerHTML = `
      <div class="trace-viewer">
        <div class="message error">
          <strong>Error:</strong> ${message}
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  private attachEventListeners(tree: TraceTree): void {
    const spanBars = this.shadow.querySelectorAll('.span-bar');
    const flatSpans = tree.flatten();
    const detailPanel = this.shadow.querySelector('.detail-panel') as HTMLElement;
    const detailContent = this.shadow.querySelector('.detail-content') as HTMLElement;
    const closeBtn = this.shadow.querySelector('.detail-panel-close') as HTMLElement;

    spanBars.forEach(bar => {
      bar.addEventListener('click', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const entry = flatSpans.find(e => e.span.spanId === spanId);

        if (entry) {
          detailContent.textContent = JSON.stringify(entry.span, null, 2);
          detailPanel.classList.add('visible');

          this.dispatchEvent(new CustomEvent('span-selected', {
            detail: { span: entry.span },
            bubbles: true,
            composed: true
          }));
        }
      });
    });

    closeBtn?.addEventListener('click', () => {
      detailPanel.classList.remove('visible');
    });
  }

  private attachZoomPanListeners(): void {
    const traceChart = this.shadow.querySelector('.trace-chart') as HTMLElement;
    if (!traceChart) return;

    traceChart.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();

      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.5, Math.min(10, this.zoomLevel * delta));

      if (newZoom !== this.zoomLevel) {
        this.zoomLevel = newZoom;
        this.updateZoomPan();
      }
    }, { passive: false });

    traceChart.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 0 && !(e.target as HTMLElement).classList.contains('span-bar')) {
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartOffset = this.panOffset;
        traceChart.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });

    traceChart.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isPanning) {
        const deltaX = e.clientX - this.panStartX;
        this.panOffset = this.panStartOffset + deltaX;
        this.updateZoomPan();
      }
    });

    traceChart.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        traceChart.style.cursor = 'default';
      }
    });

    traceChart.addEventListener('mouseleave', () => {
      if (this.isPanning) {
        this.isPanning = false;
        traceChart.style.cursor = 'default';
      }
    });

    traceChart.addEventListener('dblclick', () => {
      this.zoomLevel = 1;
      this.panOffset = 0;
      this.updateZoomPan();
    });

    this.addZoomControls();
  }

  private updateZoomPan(): void {
    const timelineContainer = this.shadow.querySelector('.timeline-container') as HTMLElement;

    if (timelineContainer) {
      timelineContainer.style.transform = `translateX(${this.panOffset}px) scaleX(${this.zoomLevel})`;
      timelineContainer.style.transformOrigin = 'left center';
    }

    const durationLabels = this.shadow.querySelectorAll('.span-duration');
    const timelineLabels = this.shadow.querySelectorAll('.timeline-label');

    durationLabels.forEach(label => {
      (label as HTMLElement).style.transform = `scaleX(${1 / this.zoomLevel})`;
      (label as HTMLElement).style.transformOrigin = 'left center';
    });

    timelineLabels.forEach(label => {
      (label as HTMLElement).style.transform = `scaleX(${1 / this.zoomLevel})`;
      (label as HTMLElement).style.transformOrigin = 'left center';
    });

    const zoomDisplay = this.shadow.querySelector('.zoom-display') as HTMLElement;
    if (zoomDisplay) {
      zoomDisplay.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }
  }

  private addZoomControls(): void {
    const traceViewer = this.shadow.querySelector('.trace-viewer');
    if (!traceViewer) return;

    const config = this.resolveConfig();
    const controls = document.createElement('div');
    controls.className = 'zoom-controls';
    controls.innerHTML = `
      <button class="zoom-btn zoom-in" title="Zoom In">+</button>
      <span class="zoom-display">100%</span>
      <button class="zoom-btn zoom-out" title="Zoom Out">&minus;</button>
      <button class="zoom-btn zoom-reset" title="Reset (or double-click)">Reset</button>
      ${config.showLegend ? this.renderLegend(config) : ''}
    `;

    traceViewer.appendChild(controls);

    controls.querySelector('.zoom-in')?.addEventListener('click', () => {
      this.zoomLevel = Math.min(10, this.zoomLevel * 1.2);
      this.updateZoomPan();
    });

    controls.querySelector('.zoom-out')?.addEventListener('click', () => {
      this.zoomLevel = Math.max(0.5, this.zoomLevel * 0.8);
      this.updateZoomPan();
    });

    controls.querySelector('.zoom-reset')?.addEventListener('click', () => {
      this.zoomLevel = 1;
      this.panOffset = 0;
      this.updateZoomPan();
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getStatusIcon(statusCode: number): string {
    switch (statusCode) {
      case 1: return '&#10003;'; // OK
      case 2: return '&#10007;'; // Error
      default: return '&#8226;'; // Unset
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}&micro;s`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  }
}

// Register the custom element
if (!customElements.get('trace-visualizer')) {
  customElements.define('trace-visualizer', TraceVisualizerElement);
}
