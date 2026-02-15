import { SpanKind } from './opentelemetry/trace.js';

const DEFAULT_COLOR_SCHEME: Record<string, string> = {
  [SpanKind.Internal]: '#4A90E2',
  [SpanKind.Server]: '#7ED321',
  [SpanKind.Client]: '#F5A623',
  [SpanKind.Producer]: '#BD10E0',
  [SpanKind.Consumer]: '#50E3C2',
  [SpanKind.Unspecified]: '#9013FE',
};

export class VisualizationConfig {
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: string;
  readonly spanHeight: number;
  readonly spanPadding: number;
  readonly showEvents: boolean;
  readonly showLegend: boolean;
  readonly fullWidth: boolean;
  readonly detailPanelWidth: string;
  readonly colorScheme: Record<string, string>;

  constructor(overrides: Partial<VisualizationConfig> = {}) {
    this.width = overrides.width || 0;
    this.height = overrides.height || 0;
    this.backgroundColor = overrides.backgroundColor || '#ffffff';
    this.spanHeight = overrides.spanHeight || 30;
    this.spanPadding = overrides.spanPadding || 5;
    this.showEvents = overrides.showEvents !== false;
    this.showLegend = overrides.showLegend === true;
    this.fullWidth = overrides.fullWidth === true;
    this.detailPanelWidth = overrides.detailPanelWidth || '40%';
    this.colorScheme = overrides.colorScheme || DEFAULT_COLOR_SCHEME;
  }
}
