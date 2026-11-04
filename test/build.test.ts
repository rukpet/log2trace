/**
 * The element's CSS build: `virtual:component-css` must carry the CSS of every `*.css.ts` file the
 * style manifest lists, under the class names the JS bundle exports.
 *
 * These tests run the real plugin pair (`build/vanilla-extract.js`, the one `esbuild.config.js`
 * uses) over the fixtures in `test/fixtures/build/`, in the dev and the minified flavour: dev
 * names classes `file_export__hash`, minified `_hash`, and the CSS text and the JS must agree on
 * either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { makeVanillaExtractPlugins } from '../build/vanilla-extract.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = join(ROOT, 'test', 'fixtures', 'build');

const completeManifest = join(FIXTURES, 'complete', 'styles.ts');
const reversedManifest = join(FIXTURES, 'complete', 'styles-reversed.ts');
const incompleteManifest = join(FIXTURES, 'incomplete', 'styles.ts');

/** The classes the `complete` fixture exports; `tone` comes from `styleVariants`. */
interface CompleteExports {
  readonly base: { readonly root: string; readonly title: string };
  readonly panel: { readonly panel: string; readonly tone: { readonly info: string; readonly danger: string } };
  readonly badge: { readonly badge: string };
}
const COMPLETE_STYLESHEETS = ['base', 'panel', 'badge'];

interface Bundle {
  /** The default export of `virtual:component-css`. */
  readonly css: string;
  /** What each requested stylesheet module exports in the JS bundle, by module name. */
  readonly modules: Record<string, unknown>;
  /** The text of the JS bundle. */
  readonly js: string;
  /** The text of every CSS file the build emitted next to it. */
  readonly emittedCss: readonly string[];
}

interface BundleOptions {
  /** The `absWorkingDir` of the build. */
  readonly workingDirectory?: string;
  /** The `identifiers` option of the plugins, instead of the one `minify` implies. */
  readonly identifiers?: 'short' | 'debug';
}

/**
 * Builds what a bundle of the element contains for `manifest`: the CSS text, and the class names
 * of each of `stylesheets` (names of `*.css.ts` files next to the manifest), then loads the result.
 * A stylesheet only the manifest imports is compiled once, one the bundle imports too twice.
 */
async function bundle(
  manifest: string,
  minify: boolean,
  stylesheets: readonly string[] = [],
  { workingDirectory = ROOT, identifiers }: BundleOptions = {},
): Promise<Bundle> {
  const entry = [
    "import css from 'virtual:component-css';",
    'export { css };',
    ...stylesheets.map((name) => `export * as ${name} from './${name}.css.ts';`),
  ].join('\n');
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: dirname(manifest), loader: 'ts' },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'esm',
    minify,
    logLevel: 'silent',
    absWorkingDir: workingDirectory,
    plugins: makeVanillaExtractPlugins({ manifest, identifiers }),
  });
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
  assert.ok(js !== undefined, 'the build emits a JS bundle');
  const { css, ...modules }: Record<string, unknown> = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  assert.equal(typeof css, 'string', 'virtual:component-css exports its CSS as a string');
  const emittedCss = result.outputFiles.filter((file) => file.path.endsWith('.css')).map((file) => file.text);
  return { css: String(css), modules, js, emittedCss };
}

const bundles = new Map<string, Promise<Bundle>>();

/** `bundle`, remembered: the builds are what takes the time and several tests read the same one. */
function built(manifest: string, minify: boolean, stylesheets: readonly string[] = []): Promise<Bundle> {
  const key = JSON.stringify([manifest, minify, stylesheets]);
  const known = bundles.get(key);
  if (known !== undefined) return known;
  const fresh = bundle(manifest, minify, stylesheets);
  bundles.set(key, fresh);
  return fresh;
}

/** Class names of an export, whether it is a string or an object of them (`styleVariants`). */
function classNames(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(classNames);
  return [];
}

/** Every class a selector of the CSS mentions. */
function classSelectors(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/\.([A-Za-z_][\w-]*)/g), (match) => match[1]));
}

/** Where the rules of each class start in the CSS, in the order of the arguments. */
function positions(css: string, ...classes: readonly string[]): number[] {
  return classes.map((name) => {
    const at = css.indexOf(`.${name}`);
    assert.notEqual(at, -1, `the CSS has no rule for .${name}`);
    return at;
  });
}

for (const minify of [false, true]) {
  const flavour = minify ? 'minified' : 'dev';

  test(`${flavour}: virtual:component-css carries the classes of every listed stylesheet`, async () => {
    const { css, modules } = await built(completeManifest, minify, COMPLETE_STYLESHEETS);
    const exported = new Set(classNames(modules));
    assert.equal(exported.size, 6, 'the JS bundle exports the classes of all three files');
    assert.deepEqual(classSelectors(css), exported, 'the CSS styles exactly the classes the JS bundle exports');
    // The selector names a class of one file in the rule of another: it only matches when both
    // files got the same names in the CSS as in the JS.
    const { base, panel } = modules as unknown as CompleteExports;
    assert.ok(css.includes(`.${base.root} .${panel.panel}`), 'a selector across two files uses the exported names');
  });

  test(`${flavour}: the CSS of a stylesheet that others build on is emitted once`, async () => {
    const { css } = await built(completeManifest, minify, COMPLETE_STYLESHEETS);
    assert.equal(css.match(/@keyframes/g)?.length, 1, 'base.css.ts is compiled again for panel.css.ts, its CSS must not repeat');
  });

  test(`${flavour}: the bundle emits no CSS of its own`, async () => {
    const { emittedCss } = await built(completeManifest, minify, COMPLETE_STYLESHEETS);
    // A dev build still prints a comment per stylesheet module into the companion file.
    const rules = emittedCss.map((text) => text.replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter((text) => text !== '');
    assert.deepEqual(rules, []);
  });
}

// The order of the CSS does not depend on how classes are named, and the dev flavour is slower
// (it adds debug names to every file), so it is not repeated for the next two.

test("the CSS follows the order of the manifest's imports", async () => {
  const forward = await built(completeManifest, true, COMPLETE_STYLESHEETS);
  const { base, panel, badge } = forward.modules as unknown as CompleteExports;
  const [root, panelAt, badgeAt] = positions(forward.css, base.root, panel.panel, badge.badge);
  assert.ok(root < panelAt && panelAt < badgeAt, 'base, panel, badge');

  // Class names depend on the file, not on the manifest. panel builds on base, so base stays
  // before it wherever the manifest lists it.
  const reversed = await built(reversedManifest, true);
  const [badgeFirst, rootThen, panelLast] = positions(reversed.css, badge.badge, base.root, panel.panel);
  assert.ok(badgeFirst < rootThen && rootThen < panelLast, 'badge, base, panel');
});

test('builds running at the same time give the same output', async () => {
  const [first, ...others] = await Promise.all([
    built(reversedManifest, true),
    bundle(reversedManifest, true),
    bundle(reversedManifest, true),
  ]);
  for (const other of others) {
    assert.equal(other.css, first.css, 'the CSS text');
    assert.equal(other.js, first.js, 'the JS bundle');
  }
});

test('the CSS and the JS agree on class names whatever the working directory is', async () => {
  // The path of a file relative to the working directory goes into the hash of its class names,
  // so the manifest build has to take the working directory of the bundle, not of the process.
  const [standard, elsewhere] = await Promise.all([
    built(completeManifest, true, COMPLETE_STYLESHEETS),
    bundle(completeManifest, true, COMPLETE_STYLESHEETS, { workingDirectory: join(ROOT, 'test') }),
  ]);
  assert.notDeepEqual(classNames(elsewhere.modules), classNames(standard.modules), 'the working directory changes the names');
  assert.deepEqual(classSelectors(elsewhere.css), new Set(classNames(elsewhere.modules)));
});

test('the CSS and the JS agree on class names whatever the identifiers option is', async () => {
  // Debug names in a minified build, where short names are the default.
  const { css, modules } = await bundle(completeManifest, true, COMPLETE_STYLESHEETS, { identifiers: 'debug' });
  const exported = classNames(modules);
  assert.ok(exported.every((name) => name.includes('__')), 'the option took effect: debug names carry the name of the export');
  assert.deepEqual(classSelectors(css), new Set(exported));
});

test('a stylesheet the manifest does not import fails the build instead of losing its CSS', async () => {
  await assert.rejects(built(incompleteManifest, true), (error: Error) => {
    assert.match(error.message, /incomplete[\\/]forgotten\.css\.ts is not imported by .*incomplete[\\/]styles\.ts/);
    assert.doesNotMatch(error.message, /listed\.css\.ts/);
    return true;
  });
});

test('src/styles.ts imports every stylesheet under src/', async () => {
  // The build fails when a *.css.ts file below the manifest's directory is missing from it.
  const { css } = await built(join(ROOT, 'src', 'styles.ts'), true);
  assert.ok(css.length > 0);
});
