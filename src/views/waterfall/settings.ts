/**
 * The waterfall's own settings
 *
 * What the waterfall reads from the element's options (checking its `<trace-view type="waterfall">`
 * child first, then the host attributes and config): the row metrics and the wheel behaviour.
 * Kept apart from the view so that it loads in Node and is tested there; the element and
 * every other view know none of these names.
 */

import { flagOption, numberOption, type ViewOptions } from '../../kit/view-options.ts';

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
}

/** Read the settings of the waterfall from the options of the element. */
export function readWaterfallSettings(options: ViewOptions): WaterfallSettings {
  return {
    spanHeight: numberOption(options, 'spanHeight', 'span-height'),
    spanPadding: numberOption(options, 'spanPadding', 'span-padding'),
    gutterWidth: numberOption(options, 'gutterWidth', 'gutter-width'),
    wheelZoom: flagOption(options, 'wheel-zoom'),
  };
}
