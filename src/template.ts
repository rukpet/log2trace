import { Span, SpanKind } from './opentelemetry/trace.js';
import { nanoToMilli } from './time.js';
import { TraceTree } from './trace-tree.js';
import { VisualizationConfig } from './visualization-config.js';

export class Template {

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  static getStatusIcon(statusCode: number): string {
    switch (statusCode) {
      case 1: return '&#10003;'; // OK
      case 2: return '&#10007;'; // Error
      default: return '&#8226;'; // Unset
    }
  }

  static formatDuration(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}&micro;s`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  }

  static calculateTickCount(containerWidth?: number): number {
    const width = containerWidth || 600;
    const minTickSpacing = 90;
    return Math.max(2, Math.floor(width / minTickSpacing));
  }

  // ---------------------------------------------------------------------------
  // Leaf markup
  // ---------------------------------------------------------------------------

  static getEventsMarkup(span: Span): string {
    if (!span.events || span.events.length === 0) return '';

    const startMs = nanoToMilli(span.startTimeUnixNano);
    const spanDuration = nanoToMilli(span.endTimeUnixNano) - startMs;

    return span.events.map(event => {
      const eventMs = nanoToMilli(event.timeUnixNano);
      const eventOffset = ((eventMs - startMs) / spanDuration) * 100;
      return `
        <div class="span-event"
             style="left:${eventOffset}%"
             title="${event.name}\nTime: ${Template.formatDuration(eventMs - startMs)}">
        </div>
      `;
    }).join('');
  }

  static getLegendMarkup(config: VisualizationConfig): string {
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

  static getTimelineTicksMarkup(timeRange: { min: number; max: number }, ticks: number): string {
    const duration = timeRange.max - timeRange.min;
    const tickElements: string[] = [];

    for (let i = 0; i <= ticks; i++) {
      const position = (i / ticks) * 100;
      const relativeTime = (duration * i / ticks);

      tickElements.push(`
        <div class="timeline-tick" style="left: ${position}%;">
          <div class="timeline-label">${Template.formatDuration(relativeTime)}</div>
        </div>
      `);
    }

    return tickElements.join('');
  }

  // ---------------------------------------------------------------------------
  // Composite markup
  // ---------------------------------------------------------------------------

  static getTimelineMarkup(timeRange: { min: number; max: number }): string {
    return `
      <div class="timeline">
        ${Template.getTimelineTicksMarkup(timeRange, Template.calculateTickCount())}
      </div>
    `;
  }

  static getSpanMarkup(
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
             title="${span.name}\nDuration: ${Template.formatDuration(spanDuration)}\nKind: ${kindLabel}">
          <div class="span-duration">
            ${Template.formatDuration(spanDuration)}
          </div>
          ${Template.getEventsMarkup(span)}
        </div>
      </div>
    `;
  }

  static getSpansMarkup(
    flatSpans: Array<{ span: Span; level: number }>,
    timeRange: { min: number; max: number },
    config: VisualizationConfig
  ): string {
    return flatSpans.map(({ span }, index) =>
      Template.getSpanMarkup(span, index, timeRange, config)
    ).join('');
  }

  static getSpanLabelsMarkup(
    tree: TraceTree,
    flatSpans: Array<{ span: Span; level: number }>,
    config: VisualizationConfig
  ): string {
    return flatSpans.map(({ span, level }, index) => {
      const yPosition = 50 + index * (config.spanHeight + config.spanPadding);
      const indent = level * 20;
      const statusIcon = Template.getStatusIcon(span.status?.code ?? 0);
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

  // ---------------------------------------------------------------------------
  // Top-level markup
  // ---------------------------------------------------------------------------

  static getTraceMarkup(tree: TraceTree, config: VisualizationConfig): string {
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
            <span>Duration: ${Template.formatDuration(timeRange.max - timeRange.min)}</span>
          </div>
        </div>
        <div class="trace-body" style="height: ${totalHeight}px;">
          <div class="trace-chart">
            <div class="span-labels-container">
              ${Template.getSpanLabelsMarkup(tree, flatSpans, config)}
            </div>
            <div class="timeline-container">
              ${Template.getTimelineMarkup(timeRange)}
              ${Template.getSpansMarkup(flatSpans, timeRange, config)}
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

  static getLoadingMarkup(): string {
    return `
      <div class="trace-viewer">
        <div class="message loading">
          <div class="spinner"></div>
          Loading trace data...
        </div>
      </div>
    `;
  }

  static getEmptyMarkup(): string {
    return `
      <div class="trace-viewer">
        <div class="message empty">
          No trace data loaded. Set the <code>data-url</code> attribute or use <code>.traceData</code> property.
        </div>
      </div>
    `;
  }

  static getZoomControlsMarkup(config: VisualizationConfig): string {
    return `
      ${config.showLegend ? Template.getLegendMarkup(config) : ''}
      <button class="zoom-btn zoom-in" title="Zoom In">+</button>
      <span class="zoom-display">100%</span>
      <button class="zoom-btn zoom-out" title="Zoom Out">&minus;</button>
      <button class="zoom-btn zoom-reset" title="Reset (or double-click)">Reset</button>
    `;
  }

  static getErrorMarkup(message: string): string {
    return `
      <div class="trace-viewer">
        <div class="message error">
          <strong>Error:</strong> ${message}
        </div>
      </div>
    `;
  }
}
