/** @file ESLint policy for authored JavaScript/TypeScript: correctness, React hooks, and required source documentation. */

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsdoc from 'eslint-plugin-jsdoc';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**',
    '**/.expo/**', '**/.gradle/**', 'mobile/android/**', 'mobile/ios/**',
    'playwright-report/**', 'test-results/**', '.codex-screenshots/**',
    'packages/api-client/src/generated/**',
  ]),
  {
    files: ['**/*.{js,cjs,mjs,ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { jsdoc },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'jsdoc/require-file-overview': 'error',
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        enableFixer: false,
        require: {
          FunctionDeclaration: true,
          FunctionExpression: true,
          ArrowFunctionExpression: true,
          MethodDefinition: true,
        },
        contexts: [
          'TSDeclareFunction',
          'TSMethodSignature',
        ],
      }],
    },
  },
  {
    files: ['e2e/**/*.ts'],
    // Playwright requires a destructured fixture argument even when only testInfo is used.
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  {
    files: ['scripts/calibration-lab-screenshots.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.eslintRecommended],
    languageOptions: { parser: tseslint.parser },
    // TypeScript checks unused declarations and names, including JSX references.
    rules: { 'no-unused-vars': 'off' },
  },
  {
    files: ['mobile/**/*.{js,ts,tsx}', 'e2e/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, __DEV__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['mobile/**/*.test.{ts,tsx}', 'mobile/test/**/*.js'],
    languageOptions: { globals: globals.jest },
  },
  {
    files: ['mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]);
