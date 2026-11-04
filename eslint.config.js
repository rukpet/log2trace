import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

// Markup and styles are never built from strings: DOM nodes use textContent / setAttribute,
// and every class and token comes from a typed vanilla-extract export (`*.css.ts`), so a typo
// fails the build instead of silently producing unstyled output.
const bannedMarkupApis = [
  { property: 'innerHTML', message: 'Build DOM nodes with textContent / setAttribute instead of HTML strings.' },
  { property: 'outerHTML', message: 'Build DOM nodes with textContent / setAttribute instead of HTML strings.' },
  { property: 'insertAdjacentHTML', message: 'Build DOM nodes with textContent / setAttribute instead of HTML strings.' },
  { property: 'cssText', message: 'Style through vanilla-extract classes or element.style.<prop>.' },
];
const bannedStyleAttribute = {
  selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value='style']",
  message: 'Do not set the style attribute from a string; use a vanilla-extract class or element.style.<prop>.',
};

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off',
      'no-restricted-properties': ['error', ...bannedMarkupApis],
      'no-restricted-syntax': ['error', bannedStyleAttribute],
    },
  },
  {
    // The headless core sits below everything else: it must not import the layers above it
    // (kit, views, shell, element, or the legacy element). test/layers.test.ts checks every import.
    files: ['src/core.ts', 'src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '**/kit/**', '**/views/**', '**/shell/**', '**/element/**',
            '**/component.ts', '**/template.ts', '**/trace-view-model.ts', '**/styles.css.ts', '**/log2trace.ts',
          ],
          message: 'The headless core must not import from the layers above it.',
        }],
      }],
    },
  },
  {
    // The kit sits on the core and under views, shell and the element: it must not import the layers
    // above it. Its own files (kit/geometry included) may import each other; test/layers.test.ts
    // checks every import against the exact rules.
    files: ['src/kit/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '**/views/**', '**/shell/**', '**/element/**',
            '**/component.ts', '**/template.ts', '**/trace-view-model.ts', '**/styles.css.ts', '**/log2trace.ts',
          ],
          message: 'The kit must not import from the layers above it.',
        }],
      }],
    },
  },
  {
    // Legacy string renderer, deleted at the v2 cutover: report instead of failing.
    files: ['src/component.ts', 'src/template.ts'],
    rules: {
      'no-restricted-properties': ['warn', ...bannedMarkupApis],
      'no-restricted-syntax': ['warn', bannedStyleAttribute],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'demo/**'],
  },
];
