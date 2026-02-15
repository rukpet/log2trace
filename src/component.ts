import { TraceData } from './opentelemetry/trace.js';
import { TraceTree } from './trace-tree.js';
import { Template } from './template.js';
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
    return ['data-url', 'width', 'height', 'show-legend', 'full-width', 'detail-panel-width'];
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
      this.shadow.innerHTML = Template.getLoadingMarkup();
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load: ${response.statusText}`);
      }
      const data = await response.json();
      this.traceData = data;
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  private updateConfigFromAttributes(): void {
    const width = this.getAttribute('width');
    const height = this.getAttribute('height');
    const showLegend = this.getAttribute('show-legend');
    const fullWidth = this.getAttribute('full-width');
    const detailPanelWidth = this.getAttribute('detail-panel-width');

    this._overrides = {
      ...this._overrides,
      width: width ? parseInt(width, 10) : undefined,
      height: height ? parseInt(height, 10) : undefined,
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
      this.shadow.innerHTML = Template.getEmptyMarkup();
      return;
    }

    try {
      this.shadow.innerHTML = Template.getTraceMarkup(this._tree, config);
      this.attachEventListeners(this._tree);
      this.attachZoomPanListeners();
      this.recalculateTimelineTicks();
    } catch (error) {
      this.shadow.innerHTML = Template.getErrorMarkup(error instanceof Error ? error.message : 'Rendering failed');
    }
  }

  private recalculateTimelineTicks(): void {
    const timelineContainer = this.shadow.querySelector('.timeline-container') as HTMLElement;
    const timelineEl = this.shadow.querySelector('.timeline') as HTMLElement;
    if (!timelineContainer || !timelineEl) return;

    const timeRange = this._tree.getTimeRange();
    const ticks = Template.calculateTickCount(timelineContainer.clientWidth);
    timelineEl.innerHTML = Template.getTimelineTicksMarkup(timeRange, ticks);
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
    const timelineContainer = this.shadow.querySelector('.timeline-container') as HTMLElement;
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
      if (e.button === 0 && !(e.target as HTMLElement).classList.contains('span-bar')) {
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
    const timelineContainer = this.shadow.querySelector('.timeline-container') as HTMLElement;
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
    const timelineContainer = this.shadow.querySelector('.timeline-container') as HTMLElement;

    this.clampPanOffset();

    if (timelineContainer) {
      timelineContainer.style.transform = `translateX(${this.panOffset}px) scaleX(${this.zoomLevel})`;
      timelineContainer.style.transformOrigin = 'left center';
    }

    // Update timeline ticks count based on zoom level and available width
    const timelineEl = this.shadow.querySelector('.timeline') as HTMLElement;
    if (timelineEl && timelineContainer) {
      const timeRange = this._tree.getTimeRange();
      const visibleWidth = timelineContainer.clientWidth * this.zoomLevel;
      const ticks = Template.calculateTickCount(visibleWidth);
      timelineEl.innerHTML = Template.getTimelineTicksMarkup(timeRange, ticks);
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
    controls.innerHTML = Template.getZoomControlsMarkup(config);

    traceViewer.appendChild(controls);

    controls.querySelector('.zoom-in')?.addEventListener('click', () => {
      this.zoomLevel = Math.min(10, this.zoomLevel * 1.2);
      this.updateZoomPan();
    });

    controls.querySelector('.zoom-out')?.addEventListener('click', () => {
      this.zoomLevel = Math.max(1, this.zoomLevel * 0.8);
      this.updateZoomPan();
    });

    controls.querySelector('.zoom-reset')?.addEventListener('click', () => {
      this.zoomLevel = 1;
      this.panOffset = 0;
      this.updateZoomPan();
    });
  }

}

// Register the custom element
if (!customElements.get('trace-visualizer')) {
  customElements.define('trace-visualizer', TraceVisualizerElement);
}
