/**
 * The sequence diagram's own settings.
 *
 * Headless: no DOM, no browser globals.
 */

import { choiceOption, numberOption, type ViewOptions } from '../../kit/view-options.ts';

export type InternalSpanMode = 'auto' | 'hide' | 'show';
export type ReturnArrowMode = 'all' | 'errors' | 'none';

export const INTERNAL_SPAN_MODES: readonly InternalSpanMode[] = ['auto', 'hide', 'show'];
export const RETURN_ARROW_MODES: readonly ReturnArrowMode[] = ['all', 'errors', 'none'];

export interface SequenceSettings {
  /** How internal spans within the same service are shown (`internal` on `<trace-view type="sequence">`, or `sequence-internal` / `sequenceInternal`). Default `'auto'`. */
  readonly internal: InternalSpanMode;
  /** Which synchronous return arrows are drawn (`returns` on `<trace-view type="sequence">`, or `sequence-returns` / `sequenceReturns`). Default `'all'`. */
  readonly returns: ReturnArrowMode;
  /** Minimum consecutive identical sibling calls to fold into a `loop ×N` row (`fold` on `<trace-view type="sequence">`, or `sequence-fold` / `sequenceFold`). `0` disables folding. Default `3`. */
  readonly foldMin: number;
  /** Row height in CSS pixels (`row-height` on `<trace-view type="sequence">`, or `row-height` / `rowHeight`). Default `28`, clamped to `[18, 48]`. */
  readonly rowHeight: number;
  /** Whether plain wheel zooms density (`wheel-zoom` on `<trace-view type="sequence">`, or `wheel-zoom` / `wheelZoom`). Default `false`. */
  readonly wheelZoom: boolean;
}

export const DEFAULT_SEQUENCE_SETTINGS: SequenceSettings = Object.freeze({
  internal: 'auto',
  returns: 'all',
  foldMin: 3,
  rowHeight: 28,
  wheelZoom: false,
});

function readChoice<T extends string>(
  options: ViewOptions,
  attribute: string,
  configKey: string,
  choices: readonly T[],
  fallback: T,
  viewName: string,
): T {
  const fromAttr = choiceOption(options, attribute, choices, viewName);
  if (fromAttr !== undefined) return fromAttr;
  const fromConfig = options.config[configKey];
  if (typeof fromConfig === 'string') {
    const match = choices.find((choice) => choice === fromConfig);
    if (match !== undefined) return match;
  }
  return fallback;
}

function readNumber(options: ViewOptions, configKey: string, attribute: string, viewName: string): number | undefined {
  const fromOption = numberOption(options, configKey, viewName);
  if (fromOption !== undefined) return fromOption;
  const rawConfig = options.config[configKey];
  if (typeof rawConfig === 'string' && rawConfig.trim() !== '') {
    const parsed = Number(rawConfig);
    if (Number.isFinite(parsed)) return parsed;
  }
  const attr = options.attribute(attribute);
  if (attr !== null && attr.trim() !== '') {
    const parsed = Number(attr);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Read the settings of the sequence diagram from the options of the element. */
export function readSequenceSettings(options: ViewOptions): SequenceSettings {
  const internal = readChoice(
    options,
    'sequence-internal',
    'sequenceInternal',
    INTERNAL_SPAN_MODES,
    DEFAULT_SEQUENCE_SETTINGS.internal,
    'internal',
  );

  const returns = readChoice(
    options,
    'sequence-returns',
    'sequenceReturns',
    RETURN_ARROW_MODES,
    DEFAULT_SEQUENCE_SETTINGS.returns,
    'returns',
  );

  const rawFold = readNumber(options, 'sequenceFold', 'sequence-fold', 'fold');
  let foldMin = DEFAULT_SEQUENCE_SETTINGS.foldMin;
  if (rawFold !== undefined) {
    const clamped = Math.max(0, Math.floor(rawFold));
    foldMin = clamped === 0 ? 0 : Math.max(2, clamped);
  }

  const rawRowHeight = readNumber(options, 'rowHeight', 'row-height', 'row-height');
  const rowHeight = rawRowHeight !== undefined
    ? Math.min(48, Math.max(18, rawRowHeight))
    : DEFAULT_SEQUENCE_SETTINGS.rowHeight;

  const ownWheelZoom = options.viewAttribute?.('wheel-zoom');
  const wheelZoom = ownWheelZoom != null
    ? ownWheelZoom !== 'false'
    : (options.attribute('wheel-zoom') !== null || options.config.wheelZoom === true);

  return {
    internal,
    returns,
    foldMin,
    rowHeight,
    wheelZoom,
  };
}
