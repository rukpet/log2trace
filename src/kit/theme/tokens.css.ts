/**
 * Kit theme: the design tokens
 *
 * Every colour and font the element draws with is a CSS custom property `--l2t-<name>`,
 * declared on `:host`. The host page restyles the element by setting any of them on the
 * element (`trace-visualizer-next { --l2t-color-accent: hotpink }`); nothing inside the
 * shadow tree needs to change. The names come from the typed contract below, so a typo in
 * a `*.css.ts` file fails the build.
 *
 * Light is the default. `theme="dark"` selects the dark values, `theme="light"` the light
 * ones, and without the attribute (or with `theme="auto"`) the page's
 * `prefers-color-scheme` decides.
 */

import { assignVars, createGlobalTheme, createGlobalThemeContract, globalStyle } from '@vanilla-extract/css';
import { COLOR_TOKENS, FONT_TOKENS, tokenRecord, type ColorToken, type FontToken } from './theme.ts';

/** The contract: `vars.color.text` is `var(--l2t-color-text)`. */
export const vars = createGlobalThemeContract(
  {
    color: tokenRecord<ColorToken, string>(COLOR_TOKENS, (token) => token),
    font: tokenRecord<FontToken, string>(FONT_TOKENS, (token) => token),
  },
  (_value, path) => `l2t-${path.join('-')}`,
);

const fonts: Record<FontToken, string> = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace",
};

const light: Record<ColorToken, string> = {
  background: '#ffffff',
  surface: '#f6f7f9',
  border: '#dddddd',
  grid: '#ececec',
  text: '#333333',
  textMuted: '#666666',
  accent: '#007bff',
  hover: 'rgba(0, 0, 0, 0.05)',
  selection: 'rgba(0, 123, 255, 0.14)',
  error: '#c62828',
  kindUnspecified: '#95a5a6',
  kindInternal: '#4a90e2',
  kindServer: '#2ecc71',
  kindClient: '#f39c12',
  kindProducer: '#9b59b6',
  kindConsumer: '#e74c3c',
};

const dark: Record<ColorToken, string> = {
  background: '#1b1d23',
  surface: '#23262e',
  border: '#3a3e49',
  grid: '#2c3039',
  text: '#e4e6eb',
  textMuted: '#9aa0ac',
  accent: '#4da3ff',
  hover: 'rgba(255, 255, 255, 0.07)',
  selection: 'rgba(77, 163, 255, 0.24)',
  error: '#ff6b6b',
  kindUnspecified: '#7f8c8d',
  kindInternal: '#5aa0ee',
  kindServer: '#3ddc84',
  kindClient: '#f5a623',
  kindProducer: '#b574d4',
  kindConsumer: '#f0655a',
};

createGlobalTheme(':host', vars, { color: light, font: fonts });

// Dark by the page's preference, unless the element is pinned to light.
globalStyle(':host(:not([theme="light"]))', {
  '@media': {
    '(prefers-color-scheme: dark)': { vars: assignVars(vars.color, dark) },
  },
});
globalStyle(':host([theme="dark"])', { vars: assignVars(vars.color, dark) });
globalStyle(':host([theme="light"])', { vars: assignVars(vars.color, light) });
