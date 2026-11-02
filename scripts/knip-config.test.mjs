/** @file Guards Knip package boundaries, dynamic release entrypoints and ordering after TypeScript validation in the consolidated Build check. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const knipConfig = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'knip.json'), 'utf8'));
const buildWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

test('Knip is pinned and dead-code scripts never auto-fix', () => {
  assert.equal(packageJson.devDependencies.knip, '6.29.0');
  assert.equal(packageJson.scripts.knip, 'knip');
  assert.equal(packageJson.scripts['knip:production'], 'knip --production --exclude exports,types');
  assert.match(packageJson.scripts['test:dead-code'], /npm run knip/);
  assert.match(packageJson.scripts['test:dead-code'], /npm run knip:production/);
  assert.match(packageJson.scripts['test:dead-code'], /^node --test scripts\/knip-config\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts['test:dead-code'], /--fix/);
});

test('Knip models every package boundary in the repository', () => {
  const expectedWorkspaces = ['.', 'backend', 'mobile', 'shared', 'packages/api-client', 'mobile/modules/wear-pairing'];
  assert.deepEqual(Object.keys(knipConfig.workspaces), expectedWorkspaces);
  for (const workspace of expectedWorkspaces.slice(1)) {
    assert.ok(fs.existsSync(path.join(repositoryRoot, workspace, 'package.json')), `${workspace} must remain a package boundary`);
  }
});

test('dynamic workflow, plugin, scenario, and Playwright entry points stay discoverable', () => {
  const rootConfig = knipConfig.workspaces['.'];
  assert.equal(rootConfig['github-actions'], true);
  assert.deepEqual(rootConfig.playwright.config, ['playwright.expo-web.config.ts', 'playwright.ux.config.ts']);
  assert.ok(rootConfig.entry.includes('.codex/local-environment.setup.mjs'));
  assert.ok(rootConfig.entry.includes('scripts/reset-test-user-onboarding.mjs'));
  assert.ok(rootConfig.entry.includes('scripts/release-hooks.mjs'));
  assert.deepEqual(knipConfig.workspaces.mobile.entry, [
    'plugins/withHealthConnect.js',
    'plugins/withPinnedGradleWrapper.js',
    'plugins/withSharedAndroidSigning.js',
    'fingerprint.config.js',
  ]);
  assert.deepEqual(knipConfig.workspaces.shared.entry, ['calibrationScenarios.ts']);
});

test('Knip keeps blocking rules and generated/config boundaries explicit', () => {
  assert.deepEqual(knipConfig.rules, { exports: 'error', types: 'error' });
  assert.equal(knipConfig.treatConfigHintsAsErrors, true);
  assert.deepEqual(knipConfig.workspaces['packages/api-client'].ignoreFiles, ['src/generated/v1.ts']);
  assert.deepEqual(knipConfig.workspaces.backend.prisma, { config: [] });
});

test('the Build check blocks on dead-code checks after typecheck', () => {
  const typecheckIndex = buildWorkflow.indexOf('run: npm run typecheck');
  const deadCodeIndex = buildWorkflow.indexOf('run: npm run test:dead-code');
  assert.ok(typecheckIndex >= 0, 'Build must run typecheck');
  assert.ok(deadCodeIndex > typecheckIndex, 'dead-code checks must follow typecheck');
  const deadCodeStep = buildWorkflow.slice(deadCodeIndex);
  assert.match(deadCodeStep, /run: npm run test:dead-code/);
  assert.doesNotMatch(deadCodeStep, /continue-on-error/);
});
