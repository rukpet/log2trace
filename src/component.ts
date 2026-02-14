import { TraceData, Span, SpanKind } from './types/opentelemetry/trace.js';
import { TraceTree } from './types/trace-tree.js';
import { VisualizationConfig } from './types/visualization-config.js';
import { TraceParser } from './parser.js';
const { nanoToMilli } = TraceTree;
import css from './styles.css';

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(css);

/**
 * Custom Web Component for trace visualization
 * Usage: <trace-visualizer></trace-visualizer>
 */
export class TraceVisualizerElement extends HTMLElement {
  private _traceData: TraceData | null = null;
  private _overrides: Partial<VisualizationConfig> = {};
  private shadow: ShadowRoot;
  private zoomLevel: number = 1;
  private panOffset: number = 0;
  private isPanning: boolean = false;
  private panStartX: number = 0;
  private panStartOffset: number = 0;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];
  }

  static get observedAttributes() {
    return ['data-url', 'width', 'height', 'show-events', 'show-attributes'];
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
    this._traceData = data;
    this.render();
  }

  get traceData(): TraceData | null {
    return this._traceData;
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
    const showAttributes = this.getAttribute('show-attributes');

    this._overrides = {
      ...this._overrides,
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
      showEvents: showEvents !== 'false',
      showAttributes: showAttributes !== 'false',
    };
  }

  private resolveConfig(): VisualizationConfig {
    return new VisualizationConfig(this._overrides);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    if (!this._traceData) {
      this.renderEmpty();
      return;
    }

    try {
      const tree = TraceParser.parse(this._traceData);
      this.shadow.innerHTML = this.renderTrace(tree);
      this.attachEventListeners(tree);
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
      <div class="trace-viewer" style="width: ${config.width}px; background: ${config.backgroundColor};">
        <div class="trace-header">
          <h3>Trace: ${traceId}</h3>
          <div class="trace-stats">
            <span>Total Spans: ${flatSpans.length}</span>
            <span>Duration: ${this.formatDuration(timeRange.max - timeRange.min)}</span>
          </div>
        </div>
        <div class="trace-chart" style="position: relative; height: ${totalHeight}px; overflow: hidden;">
          <div class="span-labels-container" style="position: absolute; left: 20px; width: 230px; top: 0; bottom: 0; pointer-events: none; z-index: 10;">
            ${this.renderSpanLabels(tree, flatSpans, config)}
          </div>
          <div class="timeline-container" style="position: absolute; left: 250px; right: 20px; top: 0; bottom: 0;">
            ${this.renderTimeline(timeRange)}
            ${this.renderSpans(flatSpans, timeRange, config)}
          </div>
        </div>
      </div>
    `;
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
        <div class="span-label-fixed" style="position: absolute; top: ${yPosition}px; left: ${indent}px; width: ${230 - indent}px; height: ${config.spanHeight}px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: auto; font-size: 12px; line-height: 1.2; padding: 2px 5px; color: #333;" title="${span.name}">
          <span class="status-icon" style="display: inline-block; width: 12px; font-size: 10px;">${statusIcon}</span>
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
      <div class="timeline" style="position: absolute; top: 0; left: 0; right: 0; height: 40px; border-bottom: 2px solid #ddd;">
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
      <div class="span-row" style="position: absolute; top: ${yPosition}px; left: 0; right: 0; height: ${config.spanHeight}px;">
        <div class="span-bar"
             style="position: absolute; left: ${startPercent}%; width: ${Math.max(widthPercent, 0.5)}%; height: 100%; background: ${color}; border-radius: 3px; cursor: pointer;"
             data-span-id="${span.spanId}"
             title="${span.name}\nDuration: ${this.formatDuration(spanDuration)}\nKind: ${kindLabel}">
          <div class="span-duration" style="position: absolute; left: 100%; margin-left: 5px; white-space: nowrap; font-size: 11px; color: #666;">
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
             style="position: absolute; left: ${eventOffset}%; top: 0; bottom: 0; width: 2px; background: rgba(255, 255, 255, 0.8);"
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

    spanBars.forEach(bar => {
      bar.addEventListener('click', (event) => {
        const spanId = (event.currentTarget as HTMLElement).getAttribute('data-span-id');
        const entry = flatSpans.find(e => e.span.spanId === spanId);

        if (entry) {
          this.dispatchEvent(new CustomEvent('span-selected', {
            detail: { span: entry.span },
            bubbles: true,
            composed: true
          }));
        }
      });
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

    const controls = document.createElement('div');
    controls.className = 'zoom-controls';
    controls.innerHTML = `
      <button class="zoom-btn zoom-in" title="Zoom In">+</button>
      <span class="zoom-display">100%</span>
      <button class="zoom-btn zoom-out" title="Zoom Out">&minus;</button>
      <button class="zoom-btn zoom-reset" title="Reset (or double-click)">Reset</button>
    `;

    traceViewer.insertBefore(controls, traceViewer.firstChild);

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
