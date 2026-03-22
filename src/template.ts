/**
 * Data flow step 4: Template
 *
 * Pure static methods that return HTML strings for every visual element
 * (spans, timeline ticks, tooltips, detail panel, zoom controls, etc.).
 * No DOM manipulation — the Component sets innerHTML from these strings.
 * All CSS class names come from styles.css.ts (never raw strings).
 */

import { Span, SpanKind, Event } from './opentelemetry/trace.ts';
import { AnyValue, KeyValue } from './opentelemetry/common.ts';
import { nanoToMilli } from './time.ts';
import { TraceTree } from './trace-tree.ts';
import type { DisplayConfig } from './config.ts';
import * as styles from './styles.css.ts';

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

  static escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  static extractAnyValue(value: AnyValue): string {
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.intValue !== undefined) return String(value.intValue);
    if (value.doubleValue !== undefined) return String(value.doubleValue);
    if (value.boolValue !== undefined) return String(value.boolValue);
    if (value.bytesValue !== undefined) return value.bytesValue;
    if (value.arrayValue) return JSON.stringify(value.arrayValue.values.map(v => Template.extractAnyValue(v)));
    if (value.kvlistValue) return JSON.stringify(Object.fromEntries(value.kvlistValue.values.map(kv => [kv.key, Template.extractAnyValue(kv.value)])));
    return '';
  }

  static formatAbsoluteTime(nanoStr: string): string {
    const ms = nanoToMilli(nanoStr);
    const d = new Date(ms);
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  static getAttrTableMarkup(attrs: KeyValue[]): string {
    if (!attrs || attrs.length === 0) return '<em style="color:#999;font-size:12px">No attributes</em>';
    const rows = attrs.map(kv => {
      const val = Template.escapeHtml(Template.extractAnyValue(kv.value));
      return `<tr><td title="${Template.escapeHtml(kv.key)}">${Template.escapeHtml(kv.key)}</td><td>${val}</td></tr>`;
    }).join('');
    return `<table class="${styles.detailAttrTable}">${rows}</table>`;
  }

  static getSpanDetailMarkup(span: Span, serviceName: string): string {
    const esc = Template.escapeHtml;
    const startMs = nanoToMilli(span.startTimeUnixNano);
    const endMs = nanoToMilli(span.endTimeUnixNano);
    const duration = endMs - startMs;
    const kindLabel = SpanKind[span.kind] || 'Unknown';
    const statusLabel = span.status?.code === 1 ? 'OK' : span.status?.code === 2 ? 'Error' : 'Unset';
    type StatusVariant = keyof typeof styles.detailStatusVariants;
    const statusVariant: StatusVariant = span.status?.code === 2 ? 'error' : span.status?.code === 1 ? 'ok' : 'unset';

    // Extract log count from attributes if present
    const logCountAttr = span.attributes?.find(a => a.key === 'log2trace.log_count');
    const logCount = logCountAttr ? Template.extractAnyValue(logCountAttr.value) : null;

    // Filter out internal attributes for display
    const displayAttrs = (span.attributes || []).filter(a => !a.key.startsWith('log2trace.'));

    // Overview section
    const overview = `
      <div class="${styles.detailSection}">
        <div class="${styles.detailSpanName}">${esc(span.name)}</div>
        <details open>
        <summary class="${styles.detailSectionHeader}">Overview</summary>
        <div class="${styles.detailSectionBody}">
          <div class="${styles.detailOverviewGrid}">
            <span class="${styles.detailLabel}">Service</span>
            <span class="${styles.detailValue}">${esc(serviceName)}</span>
            <span class="${styles.detailLabel}">Status</span>
            <span class="${styles.detailValue}">
              <span class="${styles.detailStatusBadge} ${styles.detailStatusVariants[statusVariant]}">${statusLabel}</span>
              ${span.status?.message ? ` <span style="color:#666;font-size:12px">${esc(span.status.message)}</span>` : ''}
            </span>
            <span class="${styles.detailLabel}">Kind</span>
            <span class="${styles.detailValue}">${kindLabel}</span>
            <span class="${styles.detailLabel}">Duration</span>
            <span class="${styles.detailValue}">${Template.formatDuration(duration)}</span>
            <span class="${styles.detailLabel}">Start</span>
            <span class="${styles.detailValueMono}">${Template.formatAbsoluteTime(span.startTimeUnixNano)}</span>
            <span class="${styles.detailLabel}">End</span>
            <span class="${styles.detailValueMono}">${Template.formatAbsoluteTime(span.endTimeUnixNano)}</span>
            ${logCount ? `
              <span class="${styles.detailLabel}">Log Count</span>
              <span class="${styles.detailValue}">${esc(logCount)}</span>
            ` : ''}
            <span class="${styles.detailLabel}">Trace ID</span>
            <span class="${styles.detailValueMono}">${esc(span.traceId)}</span>
            <span class="${styles.detailLabel}">Span ID</span>
            <span class="${styles.detailValueMono}">${esc(span.spanId)}</span>
            ${span.parentSpanId ? `
              <span class="${styles.detailLabel}">Parent ID</span>
              <span class="${styles.detailValueMono}">${esc(span.parentSpanId)}</span>
            ` : ''}
          </div>
        </div>
        </details>
      </div>
    `;

    // Attributes section (hidden when empty)
    const attributes = displayAttrs.length > 0 ? `
      <div class="${styles.detailSection}">
        <details open>
        <summary class="${styles.detailSectionHeader}">
          Attributes
          <span class="${styles.detailBadge}">${displayAttrs.length}</span>
        </summary>
        <div class="${styles.detailSectionBody}">
          ${Template.getAttrTableMarkup(displayAttrs)}
        </div>
        </details>
      </div>
    ` : '';

    // Events section
    const events = span.events && span.events.length > 0 ? `
      <div class="${styles.detailSection}">
        <details open>
        <summary class="${styles.detailSectionHeader}">
          Events
          <span class="${styles.detailBadge}">${span.events.length}</span>
        </summary>
        <div class="${styles.detailSectionBody}">
          ${span.events.map((event: Event) => {
            const eventMs = nanoToMilli(event.timeUnixNano);
            const relativeMs = eventMs - startMs;
            return `
              <details class="${styles.detailEventCard}" open>
                <summary class="${styles.detailEventHeader}">
                  <span class="${styles.detailEventName}" title="${esc(event.name)}">${esc(event.name)}</span>
                  <span class="${styles.detailEventTimestamp}">+${Template.formatDuration(relativeMs)}</span>
                </summary>
                <div class="${styles.detailEventBody}">
                  ${Template.getAttrTableMarkup(event.attributes)}
                </div>
              </details>
            `;
          }).join('')}
        </div>
        </details>
      </div>
    ` : '';

    return overview + attributes + events;
  }

  static calculateTickCount(containerWidth?: number): number {
    const width = containerWidth || 600;
    const minTickSpacing = 120;
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
        <div class="${styles.spanEvent}"
             style="left:${eventOffset}%"
             title="${event.name}\nTime: ${Template.formatDuration(eventMs - startMs)}">
        </div>
      `;
    }).join('');
  }

  static getLegendMarkup(config: DisplayConfig): string {
    const items = Object.entries(config.colorScheme)
      .filter(([kindValue]) => Number(kindValue) !== SpanKind.Unspecified)
      .map(([kindValue, color]) => {
        const label = SpanKind[Number(kindValue)] || 'Unknown';
        return `
          <div class="${styles.legendItem}">
            <div class="${styles.legendColor}" style="background: ${color};"></div>
            <span>${label}</span>
          </div>
        `;
      })
      .join('');

    return `<div class="${styles.legend}">${items}</div>`;
  }

  static getTimelineTicksMarkup(timeRange: { min: number; max: number }, ticks: number): string {
    const duration = timeRange.max - timeRange.min;
    const tickElements: string[] = [];

    for (let i = 0; i <= ticks; i++) {
      const position = (i / ticks) * 100;
      const relativeTime = (duration * i / ticks);

      tickElements.push(`
        <div class="${styles.timelineTick}" style="left: ${position}%;">
          <div class="${styles.timelineLabel}">${Template.formatDuration(relativeTime)}</div>
        </div>
      `);
    }

    return tickElements.join('');
  }

  static getTimelineOverlayTicksMarkup(
    timeRange: { min: number; max: number },
    containerWidth: number,
    zoomLevel: number,
    panOffset: number
  ): string {
    const duration = timeRange.max - timeRange.min;
    const scaledWidth = containerWidth * zoomLevel;
    const ticks = Template.calculateTickCount(scaledWidth);
    const tickElements: string[] = [];

    for (let i = 0; i <= ticks; i++) {
      const fraction = i / ticks;
      const pixelX = fraction * scaledWidth + panOffset;

      if (pixelX < -80 || pixelX > containerWidth + 10) continue;

      const relativeTime = duration * fraction;
      tickElements.push(`
        <div class="${styles.timelineTick}" style="left: ${pixelX}px;">
          <div class="${styles.timelineLabel}">${Template.formatDuration(relativeTime)}</div>
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
      <div class="${styles.timeline}">
        ${Template.getTimelineTicksMarkup(timeRange, Template.calculateTickCount())}
      </div>
    `;
  }

  static getSpanMarkup(
    span: Span,
    index: number,
    timeRange: { min: number; max: number },
    config: DisplayConfig
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
      <div class="${styles.spanRow}" style="top:${yPosition}px;height:${config.spanHeight}px">
        <div class="${styles.spanBar}"
             style="left:${startPercent}%;width:${Math.max(widthPercent, 0.5)}%;background:${color}"
             data-span-id="${span.spanId}"
             title="${span.name}\nDuration: ${Template.formatDuration(spanDuration)}\nKind: ${kindLabel}">
          <div class="${styles.spanDuration}">
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
    config: DisplayConfig
  ): string {
    return flatSpans.map(({ span }, index) =>
      Template.getSpanMarkup(span, index, timeRange, config)
    ).join('');
  }

  static getSpanLabelsMarkup(
    tree: TraceTree,
    flatSpans: Array<{ span: Span; level: number }>,
    config: DisplayConfig
  ): string {
    return flatSpans.map(({ span, level }, index) => {
      const yPosition = 50 + index * (config.spanHeight + config.spanPadding);
      const indent = level * 20;
      const statusIcon = Template.getStatusIcon(span.status?.code ?? 0);
      const serviceName = tree.serviceNameOf.get(span.spanId) || 'unknown-service';

      return `
        <div class="${styles.spanLabelFixed}" style="top:${yPosition}px;left:${indent}px;width:${230 - indent}px;height:${config.spanHeight}px" title="${span.name}">
          <span class="${styles.statusIcon}">${statusIcon}</span>
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

  static getTraceMarkup(tree: TraceTree, config: DisplayConfig): string {
    const flatSpans = tree.flatten();
    const timeRange = tree.getTimeRange();
    const chartHeight = flatSpans.length * (config.spanHeight + config.spanPadding);
    const totalHeight = Math.max(chartHeight + 100, config.height);
    const traceId = tree.roots[0]?.traceId || 'N/A';

    return `
      <div class="${styles.traceViewer}" style="background: ${config.backgroundColor};">
        <div class="${styles.traceHeader}">
          <h3>Trace: ${traceId}</h3>
          <div class="${styles.traceStats}">
            <span>Total Spans: ${flatSpans.length}</span>
            <span>Duration: ${Template.formatDuration(timeRange.max - timeRange.min)}</span>
          </div>
        </div>
        <div class="${styles.traceBody}" style="height: ${totalHeight}px;">
          <div class="${styles.traceChart}">
            <div class="${styles.spanLabelsContainer}">
              ${Template.getSpanLabelsMarkup(tree, flatSpans, config)}
            </div>
            <div class="${styles.timelineOverlay}">
              <div class="${styles.timeline}">
                ${Template.getTimelineTicksMarkup(timeRange, Template.calculateTickCount())}
              </div>
            </div>
            <div class="${styles.timelineClip}">
              <div class="${styles.timelineContainer}">
                ${Template.getSpansMarkup(flatSpans, timeRange, config)}
              </div>
            </div>
          </div>
          <div class="${styles.detailPanel}" style="width: ${config.detailPanelWidth};">
            <div class="${styles.detailPanelHeader}">
              <h3>Span Details</h3>
              <button class="${styles.detailPanelClose}" title="Close">&times;</button>
            </div>
            <div class="${styles.detailContent}"></div>
          </div>
        </div>
      </div>
    `;
  }

  static getLoadingMarkup(): string {
    return `
      <div class="${styles.traceViewer}">
        <div class="${styles.message} ${styles.messageLoading}">
          <div class="${styles.spinner}"></div>
          Loading trace data...
        </div>
      </div>
    `;
  }

  static getEmptyMarkup(): string {
    return `
      <div class="${styles.traceViewer}">
        <div class="${styles.message} ${styles.messageEmpty}">
          No trace data loaded. Set the <code>data-url</code> attribute or use <code>.traceData</code> property.
        </div>
      </div>
    `;
  }

  static getZoomControlsMarkup(config: DisplayConfig): string {
    return `
      ${config.showLegend ? Template.getLegendMarkup(config) : ''}
      <button class="${styles.zoomBtn} ${styles.zoomIn}" title="Zoom In">+</button>
      <span class="${styles.zoomDisplay}">100%</span>
      <button class="${styles.zoomBtn} ${styles.zoomOut}" title="Zoom Out">&minus;</button>
      <button class="${styles.zoomBtn} ${styles.zoomReset}" title="Reset (or double-click)">Reset</button>
    `;
  }

  static getErrorMarkup(message: string): string {
    return `
      <div class="${styles.traceViewer}">
        <div class="${styles.message} ${styles.messageError}">
          <strong>Error:</strong> ${message}
        </div>
      </div>
    `;
  }

  static getTooltipMarkup(
    span: Span,
    serviceName: string
  ): string {
    const duration = nanoToMilli(span.endTimeUnixNano) - nanoToMilli(span.startTimeUnixNano);
    const kindLabel = SpanKind[span.kind] || 'Unknown';
    const statusLabel = span.status?.code === 1 ? 'OK' : span.status?.code === 2 ? 'Error' : 'Unset';
    type TooltipStatusVariant = keyof typeof styles.tooltipStatusVariants;
    const statusVariant: TooltipStatusVariant = span.status?.code === 2 ? 'error' : span.status?.code === 1 ? 'ok' : 'unset';

    return `
      <div class="${styles.tooltipHeader}">
        <strong>${serviceName}</strong>
        <span class="${styles.tooltipStatus} ${styles.tooltipStatusVariants[statusVariant]}">${statusLabel}</span>
      </div>
      <div class="${styles.tooltipOperation}">${span.name}</div>
      <div class="${styles.tooltipInfo}">
        <div class="${styles.tooltipRow}">
          <span class="${styles.tooltipLabel}">Duration:</span>
          <span class="${styles.tooltipValue}">${Template.formatDuration(duration)}</span>
        </div>
        <div class="${styles.tooltipRow}">
          <span class="${styles.tooltipLabel}">Kind:</span>
          <span class="${styles.tooltipValue}">${kindLabel}</span>
        </div>
        <div class="${styles.tooltipRow}">
          <span class="${styles.tooltipLabel}">Span ID:</span>
          <span class="${styles.tooltipValue}">${span.spanId.substring(0, 16)}...</span>
        </div>
        ${span.status?.message ? `
          <div class="${styles.tooltipRow}">
            <span class="${styles.tooltipLabel}">Message:</span>
            <span class="${styles.tooltipValue}">${span.status.message}</span>
          </div>
        ` : ''}
        ${span.events && span.events.length > 0 ? `
          <div class="${styles.tooltipRow}">
            <span class="${styles.tooltipLabel}">Events:</span>
            <span class="${styles.tooltipValue}">${span.events.length}</span>
          </div>
        ` : ''}
      </div>
      <div class="${styles.tooltipHint}">Click for full details</div>
    `;
  }
}
