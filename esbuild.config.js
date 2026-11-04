import * as esbuild from 'esbuild';
import { makeVanillaExtractPlugins } from './build/vanilla-extract.js';

const isWatchMode = process.argv.includes('--watch');

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
    plugins: [...makeVanillaExtractPlugins(styleOptions), ...watching],
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
