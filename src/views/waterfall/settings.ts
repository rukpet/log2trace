/**
 * The waterfall's own settings
 *
 * What the waterfall reads from the element's options: the row metrics, the wheel behaviour and the
 * backend. Kept apart from the view so that it loads in Node and is tested there; the element and
 * every other view know none of these names.
 */

import { choiceOption, flagOption, numberOption, type RendererKind, type ViewOptions } from '../../kit/view-options.ts';

/** The backends of the waterfall, the default first. */
export const WATERFALL_RENDERERS: readonly RendererKind[] = ['dom', 'canvas'];

/** The options of the waterfall; a missing one means the default. */
export interface WaterfallSettings {
  /** Height of a row's bar, px (`span-height`). */
  readonly spanHeight?: number;
  /** Space between rows, px (`span-padding`). */
  readonly spanPadding?: number;
  /** Width of the label column, px (`gutter-width`). */
  readonly gutterWidth?: number;
  /** Let the plain wheel zoom instead of scrolling (`wheel-zoom` attribute). */
  readonly wheelZoom: boolean;
  /** The backend asked for (`renderer` attribute), or `undefined` for the default. */
  readonly renderer?: RendererKind;
}

/** Read the settings of the waterfall from the options of the element. */
export function readWaterfallSettings(options: ViewOptions): WaterfallSettings {
  return {
    spanHeight: numberOption(options, 'spanHeight'),
    spanPadding: numberOption(options, 'spanPadding'),
    gutterWidth: numberOption(options, 'gutterWidth'),
    wheelZoom: flagOption(options, 'wheel-zoom'),
    renderer: choiceOption(options, 'renderer', WATERFALL_RENDERERS),
  };
}
