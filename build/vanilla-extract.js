import * as esbuild from 'esbuild';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { transform } from 'lightningcss';
import { vanillaExtractPlugin } from '@vanilla-extract/esbuild-plugin';

/**
 * vanilla-extract for Shadow DOM: the build side of `virtual:component-css`.
 *
 * Problem: vanilla-extract normally emits CSS as a companion .css file. For Shadow DOM the
 * element needs the CSS as a plain string for adoptedStyleSheets, and the JS still needs the
 * class names that every `*.css.ts` file exports.
 *
 * Solution, two plugins for the esbuild options of an element bundle:
 *  1. vePlugin compiles each `*.css.ts` file the bundle imports into its class-name exports.
 *     Its CSS is thrown away (`processCss` returns ''), so no companion file is emitted.
 *  2. cssTextPlugin serves the virtual module `virtual:component-css`. It runs a nested esbuild
 *     build of the style manifest (`src/styles.ts`), which imports every `*.css.ts` file, and
 *     exports all the CSS that build produced as one string.
 *
 * The manifest, not the imports of the bundle, decides which CSS ships. So the nested build
 * must name classes exactly as the outer one does: it gets the outer build's `minify` and
 * `identifiers` (vanilla-extract picks short or debug names from `minify`) and `absWorkingDir`
 * (the path of a file relative to it goes into the hash of its class names). A `*.css.ts` file
 * below the manifest's directory that the manifest does not reach fails the build instead of
 * silently losing its CSS. No state outlives a build, so concurrent bundles and watch-mode
 * rebuilds never see each other's CSS.
 *
 * Chunk order: vanilla-extract hands `processCss` one chunk per stylesheet, in whatever order
 * their compilation happens to finish and without the file's name. Each chunk is replaced by a
 * marker rule in the nested build, esbuild bundles the markers in import order, and the chunks
 * are put back in the order their markers come out: the CSS follows the manifest's imports.
 */

/** @typedef {'short' | 'debug'} IdentifierOption */

/**
 * @typedef {object} StyleOptions
 * @property {string} manifest Module that imports every `*.css.ts` file, in the order their CSS
 *   should appear. A relative path is resolved against `absWorkingDir` of the build (default:
 *   the cwd). Every `*.css.ts` file below the manifest's directory must be reachable from it.
 * @property {IdentifierOption} [identifiers] Class name style: `short` in a minified build and
 *   `debug` otherwise, unless set here (vanilla-extract's `identOption`).
 */

const CSS_MODULE = 'virtual:component-css';
const CSS_NAMESPACE = 've-css-text';

/** The files vanilla-extract compiles: `.css.ts`, `.css.js` and the like. */
const STYLE_FILE = /\.css\.(?:js|cjs|mjs|jsx|ts|tsx)$/;

/**
 * Stands in for chunk `index` in the nested build. Selector and value are both unique, so
 * that not even a minifier can merge two markers.
 *
 * @param {number} index
 */
const chunkMarker = (index) => `.l2t-css-chunk-${index}{--l2t-css-chunk:${index}}`;

/**
 * Creates the plugin pair described above.
 *
 * @param {StyleOptions} options
 * @returns {esbuild.Plugin[]}
 */
export function makeVanillaExtractPlugins({ manifest, identifiers }) {
  // Plugin 1 — vanilla-extract compiler. esbuild sees empty CSS and emits nothing but an
  // empty companion file, which cssTextPlugin deletes below.
  const vePlugin = vanillaExtractPlugin({ identifiers, processCss: async () => '' });

  // Plugin 2 — virtual module that exposes the CSS of the manifest as a text string.
  // Import it as: import componentCss from 'virtual:component-css'
  /** @type {esbuild.Plugin} */
  const cssTextPlugin = {
    name: 've-css-as-text',
    setup(build) {
      build.onResolve({ filter: /^virtual:component-css$/ }, () => ({
        path: CSS_MODULE,
        namespace: CSS_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: CSS_NAMESPACE }, async () => {
        const { css, ...result } = await loadStyles({
          manifest,
          identifiers,
          minify: build.initialOptions.minify,
          absWorkingDir: build.initialOptions.absWorkingDir,
        });
        if (css === undefined) return result;
        let contents = css;
        if (build.initialOptions.minify) {
          const { code } = transform({ filename: CSS_MODULE, code: Buffer.from(contents), minify: true });
          contents = new TextDecoder().decode(code);
        }
        // Use a JS template literal so actual newlines are preserved in the
        // dev bundle (loader:'text' would JSON-escape them into \n sequences).
        const escaped = contents.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        return { ...result, contents: `export default \`${escaped}\`;`, loader: 'js' };
      });
      // Delete the empty .css and .css.map sidecars that esbuild emits when
      // vanilla-extract's CSS namespace is processed (CSS is already inlined
      // in the JS bundle via adoptedStyleSheets — no separate file needed).
      build.onEnd(() => {
        const outfile = build.initialOptions.outfile;
        if (!outfile) return;
        const cssSidecar = outfile.replace(/\.js$/, '.css');
        for (const f of [cssSidecar, `${cssSidecar}.map`]) {
          rmSync(f, { force: true });
        }
      });
    },
  };

  return [vePlugin, cssTextPlugin];
}

/**
 * Bundles the manifest and collects the CSS of the stylesheets it imports. `css` is undefined
 * when that failed, and `errors` says why. The files to watch are reported either way, so that
 * a watch-mode build reruns when one of them changes, including the edit that fixes a failure.
 *
 * @param {StyleOptions & { minify: boolean | undefined, absWorkingDir: string | undefined }} options
 * @returns {Promise<{ css?: string } & Required<Pick<esbuild.OnLoadResult, 'errors' | 'warnings' | 'watchFiles' | 'watchDirs'>>>}
 */
async function loadStyles({ manifest, identifiers, minify, absWorkingDir }) {
  const root = absWorkingDir ?? process.cwd();
  const manifestPath = resolve(root, manifest);
  const shown = (/** @type {string} */ file) => relative(root, file);
  const { styleFiles, directories } = scan(dirname(manifestPath));
  const watchFiles = [manifestPath, ...styleFiles];
  const watchDirs = directories;

  /** @type {string[]} */
  const chunks = [];
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [manifestPath],
      bundle: true,
      write: false,
      outdir: 'out',
      metafile: true,
      logLevel: 'silent',
      absWorkingDir,
      minify,
      plugins: [
        vanillaExtractPlugin({
          identifiers,
          processCss: async (css) => chunkMarker(chunks.push(css) - 1),
        }),
      ],
    });
  } catch (error) {
    if (!isBuildFailure(error)) throw error;
    return { errors: error.errors, warnings: error.warnings, watchFiles, watchDirs };
  }
  const { warnings } = result;

  const reached = new Set(Object.keys(result.metafile.inputs).map((input) => resolve(root, input)));
  const unlisted = styleFiles.filter((file) => !reached.has(file));
  if (unlisted.length > 0) {
    const errors = unlisted.map((file) => ({
      text: `${shown(file)} is not imported by ${shown(manifestPath)}, so its CSS would be missing from the element`,
      notes: [{ text: 'Import it there, in the position its CSS should take.' }],
    }));
    return { errors, warnings, watchFiles, watchDirs };
  }

  const cssFile = result.outputFiles.find((file) => file.path.endsWith('.css'));
  const order = Array.from(cssFile?.text.matchAll(/--l2t-css-chunk:\s*(\d+)/g) ?? [], (match) => Number(match[1]));
  if (order.length !== chunks.length || new Set(order).size !== chunks.length) {
    const errors = [{ text: `${chunks.length} CSS chunks were compiled for ${shown(manifestPath)}, but ${order.length} came out of the bundle` }];
    return { errors, warnings, watchFiles, watchDirs };
  }

  return {
    css: order.map((index) => chunks[index]).join('\n'),
    errors: [],
    warnings,
    watchFiles: [...new Set([...watchFiles, ...Array.from(reached).filter(existsSync)])],
    watchDirs,
  };
}

/**
 * The style modules below a directory, and every directory there (so that adding a style
 * module reruns a watch-mode build).
 *
 * @param {string} directory
 */
function scan(directory) {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => ({ path: resolve(entry.parentPath, entry.name), isDirectory: entry.isDirectory() }))
    .filter(({ path }) => !relative(directory, path).split(sep).includes('node_modules'));
  return {
    styleFiles: entries.filter(({ path, isDirectory }) => !isDirectory && STYLE_FILE.test(path)).map(({ path }) => path),
    directories: [directory, ...entries.filter(({ isDirectory }) => isDirectory).map(({ path }) => path)],
  };
}

/**
 * @param {unknown} error
 * @returns {error is esbuild.BuildFailure}
 */
function isBuildFailure(error) {
  return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
}
