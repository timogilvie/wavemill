// HOK-2806: measurement-only eslint config for the S1 static-features
// collector. Nothing in this repo runs `eslint` as a gate today; this exists
// so the collector can auto-detect the config and populate `lint_errors`
// per the frozen Arbiter S1 contract. Pre-existing error counts are data,
// not a cleanup mandate.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'worktrees/**',
      '.wavemill/**',
      'docs/**',
      'fixtures/**',
      '**/fixtures/**',
      '**/test-fixtures/**',
      '**/*.fixtures.json',
      'coverage/**',
      'dist/**',
      'build/**',
      '**/.static-collect-worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
      },
    },
  },
];
