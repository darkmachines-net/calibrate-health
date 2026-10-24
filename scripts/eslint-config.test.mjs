/** @file Regression coverage for eslint config: authored JavaScript and TypeScript surfaces receive correctness checks. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('authored JavaScript and TypeScript surfaces receive correctness checks', async () => {
  for (const filePath of [
    '.codex/lint-probe.mjs', 'scripts/lint-probe.mjs', 'deploy/scripts/lint-probe.mjs',
    'backend/test/lint-probe.js', 'backend/src/lint-probe.ts', 'shared/lint-probe.ts',
    'packages/api-client/src/lint-probe.ts', 'mobile/app/lint-probe.tsx',
    'mobile/modules/wear-pairing/lint-probe.ts', 'e2e/lint-probe.ts',
  ]) {
    const [result] = await eslint.lintText('if (false) { console.log("unreachable"); }', { filePath });
    assert.ok(result.messages.some(message => message.ruleId === 'no-constant-condition'), filePath);
  }
});

test('React hook dependency warnings and conditional hook errors are checked', async () => {
  const [warning] = await eslint.lintText(`
    /** @file React hook dependency fixture. */
    import { useEffect } from 'react';
    /** Renders a fixture whose effect intentionally omits a dependency. */
    export function Example({ value }: { value: string }) {
      useEffect(() => { console.log(value); }, []);
      return null;
    }
  `, { filePath: 'mobile/src/lint-probe.tsx' });
  assert.equal(warning.errorCount, 0);
  assert.ok(warning.messages.some(message => message.ruleId === 'react-hooks/exhaustive-deps' && message.severity === 1));

  const [error] = await eslint.lintText(`
    /** @file Conditional hook fixture. */
    import { useEffect } from 'react';
    /** Exercises an invalid conditional hook call. */
    export function Example({ ready }: { ready: boolean }) {
      if (ready) useEffect(() => {}, []);
      return null;
    }
  `, { filePath: 'mobile/src/lint-probe.tsx' });
  assert.ok(error.messages.some(message => message.ruleId === 'react-hooks/rules-of-hooks' && message.severity === 2));
});

test('generated output is excluded and obsolete suppressions fail', async () => {
  for (const filePath of [
    'mobile/android/generated.js', 'mobile/ios/generated.js', 'mobile/dist/bundle.js',
    'backend/dist/index.js', 'shared/dist/cjs/index.js', 'packages/api-client/src/generated/v1.ts',
    'coverage/report.js', 'node_modules/example/index.js',
  ]) assert.equal(await eslint.isPathIgnored(filePath), true, filePath);

  const [result] = await eslint.lintText('/** @file Obsolete suppression fixture. */\n/* eslint-disable no-debugger */\nconsole.log("clean");', {
    filePath: 'scripts/lint-probe.mjs',
  });
  assert.equal(result.errorCount, 1);
  assert.match(result.messages[0].message, /Unused eslint-disable/);
});

test('the lint command fails on a warning alone, fails on errors, and accepts clean code', () => {
  assert.equal(packageJson.scripts['lint:eslint'], 'eslint . --max-warnings 0');
  const [, , ...options] = packageJson.scripts['lint:eslint'].split(' ');
  for (const [source, expectedStatus, expectedWarnings, expectedErrors] of [
    ['const unused = 1;', 1, 1, 0],
    ['missingFunction();', 1, 0, 1],
    ['console.log("clean");', 0, 0, 0],
  ]) {
    const result = spawnSync(process.execPath, [
      path.join(root, 'node_modules/eslint/bin/eslint.js'), ...options,
      '--stdin', '--stdin-filename', 'scripts/lint-probe.mjs', '--format', 'json',
    ], { cwd: root, encoding: 'utf8', input: '/** @file CLI severity fixture. */\n' + source });
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    const [report] = JSON.parse(result.stdout);
    assert.equal(report.warningCount, expectedWarnings);
    assert.equal(report.errorCount, expectedErrors);
  }
});

test('source files require an overview before executable statements', async () => {
  for (const source of [
    'console.log("missing overview");',
    'console.log("late overview");\n/** @file Too late. */',
  ]) {
    const [result] = await eslint.lintText(source, { filePath: 'shared/documentation-probe.ts' });
    assert.ok(result.messages.some(message => message.ruleId === 'jsdoc/require-file-overview'));
  }
});

test('public function documentation covers named, default, arrow, CommonJS, and class APIs', async () => {
  for (const [filePath, declaration] of [
    ['shared/probe.ts', 'export function read() { return 1; }'],
    ['shared/probe.ts', 'export default function read() { return 1; }'],
    ['shared/probe.ts', 'export const read = () => 1;'],
    ['shared/probe.ts', 'function read() { return 1; } export { read };'],
    ['shared/probe.ts', 'export class Reader { read() { return 1; } }'],
    ['shared/probe.ts', 'export interface Reader { read(): number; }'],
    ['shared/probe.ts', 'export declare function read(): number;'],
    ['scripts/probe.cjs', 'module.exports = function read() { return 1; };'],
  ]) {
    const [result] = await eslint.lintText('/** @file Public API fixture. */\nconsole.log("fixture");\n' + declaration, { filePath });
    assert.ok(result.messages.some(message => message.ruleId === 'jsdoc/require-jsdoc'), declaration);
  }
});

test('documented exports pass while private implementation helpers remain optional', async () => {
  const [result] = await eslint.lintText(`
    /** @file Documented API with a private helper. */
    function internal() { return 1; }
    /** Returns the fixture value. */
    export function read() { return internal(); }
    /** Holds the fixture reader. */
    export class Reader {
      private internal() { return 1; }
      /** Returns the fixture value. */
      read() { return this.internal(); }
    }
  `, { filePath: 'shared/probe.ts' });
  assert.deepEqual(result.messages, []);
});
