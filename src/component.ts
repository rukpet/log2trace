import { TraceData } from './types/opentelemetry/trace.js';
import { TraceTree, VisualizationConfig } from './types/internal.js';
import { TraceParser } from './parser.js';
import { TraceRenderer } from './renderer.js';

/**
 * Custom Web Component for trace visualization
 * Usage: <trace-visualizer></trace-visualizer>
 */
export class TraceVisualizerElement extends HTMLElement {
  private _traceData: TraceData | null = null;
  private _config: VisualizationConfig = {};
  private shadow: ShadowRoot;
  private zoomLevel: number = 1;
  private panOffset: number = 0;
  private isPanning: boolean = false;
  private panStartX: number = 0;
  private panStartOffset: number = 0;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
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
  set config(config: VisualizationConfig) {
    this._config = { ...this._config, ...config };
    this.render();
  }

  get config(): VisualizationConfig {
    return this._config;
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

  /**
   * Update config from HTML attributes
   */
  private updateConfigFromAttributes(): void {
    const width = this.getAttribute('width');
    const height = this.getAttribute('height');
    const showEvents = this.getAttribute('show-events');
    const showAttributes = this.getAttribute('show-attributes');

    this._config = {
      ...this._config,
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
      showEvents: showEvents !== 'false',
      showAttributes: showAttributes !== 'false'
    };
  }

  /**
   * Render the visualization
   */
  private render(): void {
    if (!this._traceData) {
      this.renderEmpty();
      return;
    }

    try {
      const tree = TraceParser.parse(this._traceData);
      const renderer = new TraceRenderer(tree, this._config);

      this.shadow.innerHTML = `
        ${TraceRenderer.getStyles()}
        ${this.getZoomPanStyles()}
        ${renderer.render()}
      `;

      this.attachEventListeners(tree);
      this.attachZoomPanListeners();
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : 'Rendering failed');
    }
  }

  /**
   * Render loading state
   */
  private renderLoading(): void {
    this.shadow.innerHTML = `
      ${this.getBaseStyles()}
      <div class="trace-viewer">
        <div class="message loading">
          <div class="spinner"></div>
          Loading trace data...
        </div>
      </div>
    `;
  }

  /**
   * Render empty state
   */
  private renderEmpty(): void {
    this.shadow.innerHTML = `
      ${this.getBaseStyles()}
      <div class="trace-viewer">
        <div class="message empty">
          No trace data loaded. Set the <code>data-url</code> attribute or use <code>.traceData</code> property.
        </div>
      </div>
    `;
  }

  /**
   * Render error state
   */
  private renderError(message: string): void {
    this.shadow.innerHTML = `
      ${this.getBaseStyles()}
      <div class="trace-viewer">
        <div class="message error">
          <strong>Error:</strong> ${message}
        </div>
      </div>
    `;
  }

  /**
   * Get base styles for message states
   */
  private getBaseStyles(): string {
    return `
      <style>
        :host {
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .trace-viewer {
          padding: 20px;
        }
        .message {
          padding: 40px;
          text-align: center;
          border-radius: 8px;
          background: #f5f5f5;
        }
        .message.loading {
          color: #666;
        }
        .message.empty {
          color: #999;
        }
        .message.error {
          background: #ffebee;
          color: #c62828;
        }
        .spinner {
          display: inline-block;
          width: 20px;
          height: 20px;
          border: 3px solid #f3f3f3;
          border-top: 3px solid #3498db;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-bottom: 10px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        code {
          background: rgba(0,0,0,0.1);
          padding: 2px 6px;
          border-radius: 3px;
          font-family: 'Courier New', monospace;
        }
      </style>
    `;
  }

  /**
   * Attach event listeners for interactivity
   */
  private attachEventListeners(tree: TraceTree): void {
    const spanBars = this.shadow.querySelectorAll('.span-bar');
    const flatSpans = TraceParser.flattenSpans(tree);

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

  /**
   * Attach zoom and pan event listeners
   */
  private attachZoomPanListeners(): void {
    const traceChart = this.shadow.querySelector('.trace-chart') as HTMLElement;
    if (!traceChart) return;

    // Mouse wheel for zoom
    traceChart.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();

      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.5, Math.min(10, this.zoomLevel * delta));

      if (newZoom !== this.zoomLevel) {
        this.zoomLevel = newZoom;
        this.updateZoomPan();
      }
    }, { passive: false });

    // Mouse drag for pan
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

    // Double click to reset
    traceChart.addEventListener('dblclick', () => {
      this.zoomLevel = 1;
      this.panOffset = 0;
      this.updateZoomPan();
    });

    // Add reset button
    this.addZoomControls();
  }

  /**
   * Update zoom and pan transformation
   */
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

  /**
   * Add zoom control UI
   */
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

  /**
   * Get zoom and pan styles
   */
  private getZoomPanStyles(): string {
    return `
      <style>
        .trace-chart {
          cursor: default;
          user-select: none;
          overflow: hidden;
        }

        .timeline-container {
          will-change: transform;
        }

        .span-duration,
        .timeline-label {
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          text-rendering: optimizeLegibility;
        }

        .zoom-controls {
          position: sticky;
          top: 0;
          z-index: 100;
          display: flex;
          gap: 10px;
          align-items: center;
          padding: 10px;
          background: rgba(255, 255, 255, 0.95);
          border-bottom: 1px solid #ddd;
          backdrop-filter: blur(5px);
        }

        .zoom-btn {
          padding: 6px 12px;
          border: 1px solid #ddd;
          background: white;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: bold;
          transition: all 0.2s;
        }

        .zoom-btn:hover {
          background: #f5f5f5;
          border-color: #999;
        }

        .zoom-btn:active {
          transform: scale(0.95);
        }

        .zoom-display {
          font-size: 14px;
          font-weight: 500;
          color: #666;
          min-width: 50px;
          text-align: center;
        }
      </style>
    `;
  }

  /**
   * Export visualization as HTML string
   */
  exportAsHTML(): string {
    if (!this._traceData) {
      throw new Error('No trace data available to export');
    }

    const tree = TraceParser.parse(this._traceData);
    const renderer = new TraceRenderer(tree, this._config);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trace Visualization</title>
</head>
<body style="margin: 0; padding: 0; background: #f5f5f5;">
  ${TraceRenderer.getStyles()}
  ${renderer.render()}
</body>
</html>`;
  }
}

// Register the custom element
if (!customElements.get('trace-visualizer')) {
  customElements.define('trace-visualizer', TraceVisualizerElement);
}
