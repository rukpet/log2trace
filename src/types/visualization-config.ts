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
  readonly showAttributes: boolean;
  readonly colorScheme: Record<string, string>;

  constructor(overrides: Partial<VisualizationConfig> = {}) {
    this.width = overrides.width || 1200;
    this.height = overrides.height || 600;
    this.backgroundColor = overrides.backgroundColor || '#ffffff';
    this.spanHeight = overrides.spanHeight || 30;
    this.spanPadding = overrides.spanPadding || 5;
    this.showEvents = overrides.showEvents !== false;
    this.showAttributes = overrides.showAttributes !== false;
    this.colorScheme = overrides.colorScheme || DEFAULT_COLOR_SCHEME;
  }
}
