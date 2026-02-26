import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { transform } from 'lightningcss';
import ts from 'typescript';
import { minify as minifyHtml } from 'html-minifier-terser';
import { vanillaExtractPlugin } from '@vanilla-extract/esbuild-plugin';

const isWatchMode = process.argv.includes('--watch');


/**
 * Creates the two-plugin set needed to use vanilla-extract with Shadow DOM.
 *
 * Problem: vanilla-extract normally emits CSS via `loader: 'css'`, producing a
 * companion .css file. For Shadow DOM we need the CSS as a plain string for
 * adoptedStyleSheets — not as a separate file.
 *
 * Solution:
 *  1. vePlugin — runs vanilla-extract compilation. processCss captures the CSS
 *     text, resolves cssReady, then returns '' to suppress the companion .css
 *     file (esbuild sees empty CSS → nothing emitted).
 *  2. cssTextPlugin — virtual module `virtual:component-css` that awaits
 *     cssReady and returns the captured CSS as a text string.
 *
 * Timing: while cssTextPlugin.onLoad awaits cssReady, the Node.js event loop
 * is free to process other esbuild messages, including the vanillaCssNamespace
 * onLoad that calls processCss and resolves cssReady.
 *
 * @param {boolean} shouldMinify - whether to minify CSS via lightningcss
 */
function makeVanillaExtractPlugins(shouldMinify = false) {
  let capturedCss = '';
  let cssResolve = /** @type {(() => void) | null} */ (null);
  let cssReady = new Promise(resolve => { cssResolve = resolve; });

  // Plugin 1 — vanilla-extract compiler with CSS capture.
  const vePlugin = vanillaExtractPlugin({
    processCss: async (css) => {
      if (shouldMinify) {
        const { code } = transform({ code: Buffer.from(css), minify: true });
        capturedCss += code.toString();
      } else {
        capturedCss += css;
      }
      cssResolve?.();
      // Return empty string so esbuild receives empty CSS and emits nothing,
      // suppressing the companion .css sidecar file.
      return '';
    },
  });

  // Plugin 2 — virtual module that exposes the captured CSS as a text string.
  // Import it as: import componentCss from 'virtual:component-css'
  const cssTextPlugin = {
    name: 've-css-as-text',
    setup(build) {
      build.onStart(() => {
        capturedCss = '';
        cssReady = new Promise(resolve => { cssResolve = resolve; });
      });
      build.onResolve({ filter: /^virtual:component-css$/ }, () => ({
        path: 'virtual:component-css',
        namespace: 've-css-text',
      }));
      build.onLoad({ filter: /.*/, namespace: 've-css-text' }, async () => {
        // Wait until processCss has been called (styles.css.ts fully compiled).
        // The Node.js event loop remains free while awaiting, so esbuild can
        // concurrently process styles.css.ts and its virtual CSS dependency.
        await cssReady;
        return {
          contents: capturedCss,
          loader: 'text',
        };
      });
    },
  };

  return [vePlugin, cssTextPlugin];
}

const htmlMinifyPlugin = {
  name: 'html-minify',
  setup(build) {
    build.onLoad({ filter: /template\.ts$/ }, async (args) => {
      let source = readFileSync(args.path, 'utf8');

      // Two passes: nested (inner) templates first, then outer templates.
      // Pass 1 minifies inner templates (e.g. inside ternary expressions).
      // Pass 2 re-parses the updated source so outer templates incorporate
      // already-minified inner text when their expressions are extracted.
      for (const processNested of [true, false]) {
        const sf = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true);
        const candidates = [];

        const collect = (node) => {
          const isTemplate =
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateExpression(node);

          if (isTemplate) {
            const staticParts = ts.isTemplateExpression(node)
              ? [node.head.text, ...node.templateSpans.map(s => s.literal.text)]
              : [node.text];
            const containsHtml = staticParts.some(p => /<[a-zA-Z/]/.test(p));

            if (containsHtml) {
              let ancestor = node.parent;
              let isNested = false;
              while (ancestor) {
                if (ts.isTemplateSpan(ancestor)) { isNested = true; break; }
                ancestor = ancestor.parent;
              }
              if (isNested === processNested) candidates.push(node);
            }
          }
          ts.forEachChild(node, collect);
        };
        collect(sf);

        // Build minified replacement for each candidate
        const replacements = []; // [start, end, newText]

        for (const node of candidates) {
          if (ts.isNoSubstitutionTemplateLiteral(node)) {
            const minified = await minifyHtml(node.text, {
              collapseWhitespace: true,
              removeComments: true,
            });
            replacements.push([node.getStart(sf), node.end, '`' + minified + '`']);
          } else {
            const spans = node.templateSpans;
            const exprs = spans.map(s =>
              source.slice(s.expression.getStart(sf), s.expression.end)
            );

            // Replace ${...} with stable placeholders, minify, then restore
            let combined = node.head.text;
            spans.forEach((s, i) => {
              combined += `__HTMLEXPR_${i}__`;
              combined += s.literal.text;
            });

            const minified = await minifyHtml(combined, {
              collapseWhitespace: true,
              removeComments: true,
              removeAttributeQuotes: false,
            });

            // split() with capture group → [head, '0', mid0, '1', mid1, ..., tail]
            const parts = minified.split(/__HTMLEXPR_(\d+)__/);

            let newTemplate = '`' + parts[0];
            for (let i = 0; i < spans.length; i++) {
              newTemplate += '${' + exprs[i] + '}' + parts[i * 2 + 2];
            }
            newTemplate += '`';

            replacements.push([node.getStart(sf), node.end, newTemplate]);
          }
        }

        // Apply end-to-start so earlier positions stay valid
        replacements.sort((a, b) => b[0] - a[0]);
        for (const [start, end, text] of replacements) {
          source = source.slice(0, start) + text + source.slice(end);
        }
      }

      return { contents: source, loader: 'ts' };
    });
  },
};

const watchPlugin = {
  name: 'watch-plugin',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) {
        console.error('✗ Build failed with errors');
      } else {
        logBuildResult(result);
      }
    });
  },
};

const sharedOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  sourcemap: true,
  metafile: true,
  format: 'esm',
};

const minifiedOptions = {
  ...sharedOptions,
  minify: true,
  outfile: 'dist/index.min.js',
  plugins: [
    ...makeVanillaExtractPlugins(true),
    htmlMinifyPlugin,
    ...(isWatchMode ? [watchPlugin] : []),
  ],
};

const devOptions = {
  ...sharedOptions,
  minify: false,
  outfile: 'dist/index.js',
  plugins: [
    ...makeVanillaExtractPlugins(false),
    ...(isWatchMode ? [watchPlugin] : []),
  ],
};

function logBuildResult(result) {
  console.log('✓ Build complete');
  if (result.metafile) {
    const outputs = Object.entries(result.metafile.outputs);
    outputs.forEach(([file, info]) => {
      const sizeKB = (info.bytes / 1024).toFixed(1);
      console.log(`  ${file.padEnd(30)} ${sizeKB}kb`);
    });
  }
}

const [minCtx, devCtx] = await Promise.all([
  esbuild.context(minifiedOptions),
  esbuild.context(devOptions),
]);

if (isWatchMode) {
  console.log('👀 Watching for changes...');

  await Promise.all([minCtx.watch(), devCtx.watch()]);

  const shutdown = async () => {
    console.log('\n✓ Stopping watch mode...');
    await Promise.all([minCtx.dispose(), devCtx.dispose()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  try {
    const [minResult, devResult] = await Promise.all([
      minCtx.rebuild(),
      devCtx.rebuild(),
    ]);
    logBuildResult(minResult);
    logBuildResult(devResult);
    await Promise.all([minCtx.dispose(), devCtx.dispose()]);
  } catch (error) {
    console.error('✗ Build failed:', error.message);
    await Promise.all([minCtx.dispose(), devCtx.dispose()]);
    process.exit(1);
  }
}
