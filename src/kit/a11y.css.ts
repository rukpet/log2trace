/**
 * Kit: accessibility helpers
 *
 * Styles for what is present to assistive technology and invisible to everyone else.
 */

import { style } from '@vanilla-extract/css';

/** Present to assistive technology and invisible to everyone else. */
export const visuallyHidden = style({
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
});
