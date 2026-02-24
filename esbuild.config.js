import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { transform } from 'lightningcss';

const isWatchMode = process.argv.includes('--watch');

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

const buildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  metafile: true,
  format: 'esm',
  outfile: 'dist/index.js',
  plugins: [
    cssMinifyPlugin,
    ...(isWatchMode ? [{
      name: 'watch-plugin',
      setup(build) {
        build.onEnd(result => {
          if (result.errors.length > 0) {
            console.error('✗ Build failed with errors');
          } else {
            logBuildResult(result);
          }
        });
      }
    }] : [])
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

const context = await esbuild.context(buildOptions);

if (isWatchMode) {
  console.log('👀 Watching for changes...');
  
  await context.watch();
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n✓ Stopping watch mode...');
    await context.dispose();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await context.dispose();
    process.exit(0);
  });
} else {
  // One-shot build mode
  try {
    const result = await context.rebuild();
    logBuildResult(result);
    await context.dispose();
  } catch (error) {
    console.error('✗ Build failed:', error.message);
    await context.dispose();
    process.exit(1);
  }
}
