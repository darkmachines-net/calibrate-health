import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
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
