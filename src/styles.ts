/**
 * Style manifest: the list of every stylesheet module (`*.css.ts`) that makes up the element's CSS.
 *
 * Nothing imports this file. The build (`build/vanilla-extract.js`) bundles it to produce the
 * `virtual:component-css` module that the elements adopt as their stylesheet, so a `*.css.ts` file
 * missing from this list ships no CSS even when code uses its class names. The build fails when a
 * `*.css.ts` file under `src/` is not imported here.
 *
 * To add a stylesheet: create the `*.css.ts` file and import it below. The CSS comes out in the
 * order of the imports and a later rule wins a tie in the cascade, so list a file after the ones
 * whose rules it overrides.
 */

import './kit/theme/tokens.css.ts';
import './kit/theme/probe.css.ts';
import './views/waterfall/paint/dom.css.ts';
import './shell/shell.css.ts';
import './shell/filter-bar.css.ts';
import './kit/a11y.css.ts';
import './views/waterfall/view.css.ts';
import './views/flame/view.css.ts';
import './views/service/view.css.ts';
import './views/sequence/paint/dom.css.ts';
import './views/sequence/view.css.ts';
import './element/element.css.ts';
