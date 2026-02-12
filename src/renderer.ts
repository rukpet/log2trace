import { ProcessedSpan, VisualizationConfig } from './types/internal.js';
import { SpanKind } from './types/opentelemetry/trace.js';
import { TraceParser } from './parser.js';

/**
 * Renders trace visualization as HTML/SVG
 */
export class TraceRenderer {
  private config: Required<VisualizationConfig>;
  private flatSpans: ProcessedSpan[];
  private timeRange: { min: number; max: number };

  constructor(
    private spans: ProcessedSpan[],
    config: VisualizationConfig = {}
  ) {
    this.config = {
      width: config.width || 1200,
      height: config.height || 600,
      backgroundColor: config.backgroundColor || '#ffffff',
      spanHeight: config.spanHeight || 30,
      spanPadding: config.spanPadding || 5,
      showEvents: config.showEvents !== false,
      showAttributes: config.showAttributes !== false,
      colorScheme: config.colorScheme || this.getDefaultColorScheme()
    };

    this.flatSpans = TraceParser.flattenSpans(spans);
    this.timeRange = TraceParser.getTimeRange(spans);
  }

  /**
   * Get default color scheme for different span kinds
   */
  private getDefaultColorScheme(): Record<string, string> {
    return {
      [SpanKind.Internal]: '#4A90E2',
      [SpanKind.Server]: '#7ED321',
      [SpanKind.Client]: '#F5A623',
      [SpanKind.Producer]: '#BD10E0',
      [SpanKind.Consumer]: '#50E3C2',
      [SpanKind.Unspecified]: '#9013FE'
    };
  }

  /**
   * Render the trace visualization as an HTML string
   */
  render(): string {
    const chartHeight = this.flatSpans.length * (this.config.spanHeight + this.config.spanPadding);
    const totalHeight = Math.max(chartHeight + 100, this.config.height);

    return `
      <div class="trace-viewer" style="width: ${this.config.width}px; background: ${this.config.backgroundColor};">
        <div class="trace-header">
          <h3>Trace: ${this.spans[0]?.traceId || 'N/A'}</h3>
          <div class="trace-stats">
            <span>Total Spans: ${this.flatSpans.length}</span>
            <span>Duration: ${this.formatDuration(this.timeRange.max - this.timeRange.min)}</span>
          </div>
        </div>
        <div class="trace-chart" style="position: relative; height: ${totalHeight}px; overflow: hidden;">
          <div class="span-labels-container" style="position: absolute; left: 20px; width: 230px; top: 0; bottom: 0; pointer-events: none; z-index: 10;">
            ${this.renderSpanLabels()}
          </div>
          <div class="timeline-container" style="position: absolute; left: 250px; right: 20px; top: 0; bottom: 0;">
            ${this.renderTimeline()}
            ${this.renderSpans()}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render span labels (fixed, not zoomed)
   */
  private renderSpanLabels(): string {
    return this.flatSpans.map((span, index) => {
      const yPosition = 50 + index * (this.config.spanHeight + this.config.spanPadding);
      const indent = span.level * 20;
      const statusIcon = this.getStatusIcon(span.status.code);

      return `
        <div class="span-label-fixed" style="position: absolute; top: ${yPosition}px; left: ${indent}px; width: ${230 - indent}px; height: ${this.config.spanHeight}px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: auto; font-size: 12px; line-height: 1.2; padding: 2px 5px; color: #333;" title="${span.name}">
          <span class="status-icon" style="display: inline-block; width: 12px; font-size: 10px;">${statusIcon}</span>
          <strong>${span.serviceName}</strong>
          <br/>
          <small>${span.name}</small>
        </div>
      `;
    }).join('');
  }

  /**
   * Render the timeline axis
   */
  private renderTimeline(): string {
    const duration = this.timeRange.max - this.timeRange.min;
    const ticks = 10;
    const tickElements: string[] = [];

    for (let i = 0; i <= ticks; i++) {
      const position = (i / ticks) * 100;
      const time = this.timeRange.min + (duration * i / ticks);
      const relativeTime = time - this.timeRange.min;

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

  /**
   * Render all spans
   */
  private renderSpans(): string {
    return this.flatSpans.map((span, index) => this.renderSpan(span, index)).join('');
  }

  /**
   * Render a single span
   */
  private renderSpan(span: ProcessedSpan, index: number): string {
    const yPosition = 50 + index * (this.config.spanHeight + this.config.spanPadding);
    const color = this.config.colorScheme[span.kind] || '#999';

    const duration = this.timeRange.max - this.timeRange.min;
    const startPercent = ((span.startTime - this.timeRange.min) / duration) * 100;
    const widthPercent = (span.duration / duration) * 100;

    const kindLabel = SpanKind[span.kind];

    return `
      <div class="span-row" style="position: absolute; top: ${yPosition}px; left: 0; right: 0; height: ${this.config.spanHeight}px;">
        <div class="span-bar" 
             style="position: absolute; left: ${startPercent}%; width: ${Math.max(widthPercent, 0.5)}%; height: 100%; background: ${color}; border-radius: 3px; cursor: pointer;"
             data-span-id="${span.spanId}"
             title="${span.name}\nDuration: ${this.formatDuration(span.duration)}\nKind: ${kindLabel}">
          <div class="span-duration" style="position: absolute; left: 100%; margin-left: 5px; white-space: nowrap; font-size: 11px; color: #666;">
            ${this.formatDuration(span.duration)}
          </div>
          ${this.config.showEvents ? this.renderEvents(span, widthPercent) : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render events within a span
   */
  private renderEvents(span: ProcessedSpan, spanWidthPercent: number): string {
    if (!span.events || span.events.length === 0) return '';

    return span.events.map(event => {
      const eventOffset = ((event.time - span.startTime) / span.duration) * 100;
      return `
        <div class="span-event" 
             style="position: absolute; left: ${eventOffset}%; top: 0; bottom: 0; width: 2px; background: rgba(255, 255, 255, 0.8);"
             title="${event.name}\nTime: ${this.formatDuration(event.time - span.startTime)}">
        </div>
      `;
    }).join('');
  }

  /**
   * Get status icon
   */
  private getStatusIcon(statusCode: number): string {
    switch (statusCode) {
      case 1: return '✓'; // OK
      case 2: return '✗'; // Error
      default: return '•'; // Unset
    }
  }

  /**
   * Format duration in milliseconds
   */
  private formatDuration(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  }

  /**
   * Get CSS styles for the visualization
   */
  static getStyles(): string {
    return `
      <style>
        .trace-viewer {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 20px;
          box-sizing: border-box;
        }

        .trace-header {
          margin-bottom: 20px;
          padding-bottom: 10px;
          border-bottom: 2px solid #ddd;
        }

        .trace-header h3 {
          margin: 0 0 10px 0;
          font-size: 18px;
          color: #333;
        }

        .trace-stats {
          display: flex;
          gap: 20px;
          font-size: 14px;
          color: #666;
        }

        .trace-chart {
          position: relative;
          overflow-x: auto;
          overflow-y: auto;
        }

        .timeline {
          position: relative;
        }

        .timeline-tick {
          position: absolute;
          top: 0;
          height: 100%;
          border-left: 1px solid #ddd;
        }

        .timeline-label {
          position: absolute;
          top: 5px;
          left: 5px;
          font-size: 11px;
          color: #666;
          white-space: nowrap;
        }

        .span-row {
          transition: background 0.2s;
        }

        .span-row:hover {
          background: #f5f5f5;
        }

        .span-label {
          font-size: 12px;
          line-height: 1.2;
          padding: 2px 5px;
          color: #333;
        }

        .status-icon {
          display: inline-block;
          width: 12px;
          font-size: 10px;
        }

        .span-bar {
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          transition: transform 0.2s, box-shadow 0.2s;
        }

        .span-bar:hover {
          transform: scaleY(1.2);
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          z-index: 10;
        }

        .span-duration {
          color: #666;
        }

        .span-event {
          cursor: help;
        }

        .span-event:hover {
          width: 4px !important;
          margin-left: -1px;
        }
      </style>
    `;
  }
}
