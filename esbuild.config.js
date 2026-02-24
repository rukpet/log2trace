import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { transform } from 'lightningcss';

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

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  metafile: true,
  format: 'esm',
  outfile: 'dist/index.js',
  plugins: [cssMinifyPlugin],
}).then(result => {
  console.log('✓ Build complete');
  if (result.metafile) {
    const outputs = Object.entries(result.metafile.outputs);
    outputs.forEach(([file, info]) => {
      const sizeKB = (info.bytes / 1024).toFixed(1);
      console.log(`  ${file.padEnd(30)} ${sizeKB}kb`);
    });
  }
}).catch(() => process.exit(1));
