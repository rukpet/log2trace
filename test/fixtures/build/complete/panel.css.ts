import { style, styleVariants } from '@vanilla-extract/css';
import { root } from './base.css.ts';

// Names a class of another stylesheet inside a selector: the selector only matches the element
// if both files were compiled to the same class names as the JS exports carry.
export const panel = style({ selectors: { [`${root} &`]: { margin: 4 } } });
export const tone = styleVariants({
  info: { color: 'rgb(0, 0, 200)' },
  danger: { color: 'rgb(200, 0, 0)' },
});
