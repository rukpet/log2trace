import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import ts from 'typescript';
import { minify as minifyHtml } from 'html-minifier-terser';
import { makeVanillaExtractPlugins } from './build/vanilla-extract.js';

const isWatchMode = process.argv.includes('--watch');

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

            // Create unique, lowercase placeholders to avoid collision with user content
            // Use timestamp + random for uniqueness
            const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            const placeholders = exprs.map((_, i) => `___ph_${uniqueId}_${i}___`); // lowercase from start

            // Replace ${...} with unique placeholders, minify, then restore
            let combined = node.head.text;
            spans.forEach((s, i) => {
              combined += placeholders[i];
              combined += s.literal.text;
            });

            const minified = await minifyHtml(combined, {
              collapseWhitespace: true,
              removeComments: true,
              removeAttributeQuotes: false,
            });

            // Restore expressions by replacing each placeholder
            let newTemplate = '`' + minified;
            placeholders.forEach((ph, i) => {
              newTemplate = newTemplate.replace(ph, '${' + exprs[i] + '}');
            });
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
        console.error(`✗ ${build.initialOptions.outfile} failed with errors`);
      } else {
        logBuildResults([result]);
      }
    });
  },
};

// Every bundle that carries the element's styles builds them from this manifest.
const styleOptions = { manifest: 'src/styles.ts' };

const sharedOptions = {
  bundle: true,
  sourcemap: true,
  metafile: true,
  format: 'esm',
};

const watching = isWatchMode ? [watchPlugin] : [];

// Two bundles, each in a dev and a minified flavour: the element (`log2trace`, registers
// <trace-visualizer> and brings its styles) and the headless core (`core`, no DOM and no styles,
// so it gets no vanilla-extract plugins and loads in Node).
const buildOptions = [
  {
    ...sharedOptions,
    entryPoints: ['src/log2trace.ts'],
    minify: true,
    outfile: 'dist/log2trace.min.js',
    plugins: [...makeVanillaExtractPlugins(styleOptions), htmlMinifyPlugin, ...watching],
  },
  {
    ...sharedOptions,
    entryPoints: ['src/log2trace.ts'],
    minify: false,
    outfile: 'dist/log2trace.js',
    plugins: [...makeVanillaExtractPlugins(styleOptions), ...watching],
  },
  {
    ...sharedOptions,
    entryPoints: ['src/core.ts'],
    platform: 'neutral',
    minify: true,
    outfile: 'dist/core.min.js',
    plugins: [...watching],
  },
  {
    ...sharedOptions,
    entryPoints: ['src/core.ts'],
    platform: 'neutral',
    minify: false,
    outfile: 'dist/core.js',
    plugins: [...watching],
  },
];

function logBuildResults(results) {
  console.log('✓ Build complete');
  for (const result of results) {
    if (!result.metafile) continue;
    Object.entries(result.metafile.outputs)
      .filter(([file]) => !file.endsWith('.css') && !file.endsWith('.css.map'))
      .forEach(([file, info]) => {
        const sizeKB = (info.bytes / 1024).toFixed(1);
        console.log(`  ${file.padEnd(30)} ${sizeKB}kb`);
      });
  }
}

const contexts = await Promise.all(buildOptions.map(options => esbuild.context(options)));
const disposeAll = () => Promise.all(contexts.map(context => context.dispose()));

if (isWatchMode) {
  console.log('👀 Watching for changes...');

  await Promise.all(contexts.map(context => context.watch()));

  const shutdown = async () => {
    console.log('\n✓ Stopping watch mode...');
    await disposeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  try {
    const results = await Promise.all(contexts.map(context => context.rebuild()));
    logBuildResults(results);
    await disposeAll();
  } catch (error) {
    console.error('✗ Build failed:', error.message);
    await disposeAll();
    process.exit(1);
  }
}
