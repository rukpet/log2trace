import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { transform } from 'lightningcss';
import ts from 'typescript';
import { minify as minifyHtml } from 'html-minifier-terser';

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

const cssMinifyPlugin = {
  name: 'css-minify',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = readFileSync(args.path, 'utf8');
      const { code } = transform({
        filename: args.path,
        code: Buffer.from(css),
        minify: true,
      });
      return {
        contents: code.toString(),
        loader: 'text',
      };
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
    htmlMinifyPlugin,
    cssMinifyPlugin,
    ...(isWatchMode ? [watchPlugin] : []),
  ],
};

const devOptions = {
  ...sharedOptions,
  minify: false,
  outfile: 'dist/index.js',
  loader: { '.css': 'text' },
  plugins: [
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
