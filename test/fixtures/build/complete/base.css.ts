import { globalStyle, keyframes, style } from '@vanilla-extract/css';

const fade = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const root = style({ padding: 8, animationName: fade });
export const title = style({ fontWeight: 600 });
globalStyle(`${root} > p`, { margin: 0 });
