/**
 * Layering: `core ← kit ← views, shell ← element`, imports only point down.
 *
 * Reads the import specifiers of every source file, resolves them and checks
 * the target is in the same layer or one below. ESLint reports the common
 * mistakes in the editor; this test is the complete check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** A layer: where its files are, and the layers it may import from (besides itself). */
interface Layer {
  readonly name: string;
  /** Files and directories, relative to `src/`. */
  readonly paths: readonly string[];
  readonly mayImport: readonly string[];
}

const LAYERS: readonly Layer[] = [
  { name: 'core', paths: ['core.ts', 'core'], mayImport: [] },
  // Pure math with no DOM (tsconfig.headless.json type-checks it without the DOM lib as well).
  // It must come before `kit`, whose directory contains it: a file belongs to the first layer that matches.
  { name: 'kit/geometry', paths: ['kit/geometry'], mayImport: ['core'] },
  // Everything that touches the DOM but knows nothing about a particular view.
  { name: 'kit', paths: ['kit'], mayImport: ['core', 'kit/geometry'] },
];

/** Lists the `.ts` files under a path relative to `src/` (the path itself when it is a file). */
function filesUnder(path: string): string[] {
  const absolute = join(SRC, path);
  if (path.endsWith('.ts')) return [absolute];
  return readdirSync(absolute, { recursive: true })
    .map((entry) => join(absolute, String(entry)))
    .filter((file) => file.endsWith('.ts'));
}

/** Relative import specifiers of a source file, including `export … from` and dynamic `import()`. */
function relativeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    found.push(match[1]);
  }
  return found;
}

function layerOf(file: string): Layer | undefined {
  const rel = relative(SRC, file).split(sep).join('/');
  return LAYERS.find((layer) => layer.paths.some((path) => rel === path || rel.startsWith(path + '/')));
}

for (const layer of LAYERS) {
  test(`${layer.name} imports only from ${layer.mayImport.length === 0 ? 'itself' : `itself and ${layer.mayImport.join(', ')}`}`, () => {
    const allowed = new Set([layer.name, ...layer.mayImport]);
    const files = layer.paths.flatMap(filesUnder);
    assert.ok(files.length > 0, 'the layer has files');

    for (const file of files) {
      for (const specifier of relativeImports(file)) {
        const target = resolve(dirname(file), specifier);
        assert.ok(existsSync(target), `${relative(SRC, file)} imports ${specifier}, which does not exist`);
        const targetLayer = layerOf(target);
        assert.ok(
          targetLayer !== undefined && allowed.has(targetLayer.name),
          `${relative(SRC, file)} imports ${specifier} (${targetLayer?.name ?? 'outside every layer'}), but ${layer.name} may import only ${[...allowed].join(', ')}`,
        );
      }
    }
  });
}
