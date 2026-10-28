/** @file Behavioral coverage of PR check selection, dependency graph comparison, and complete Git change discovery. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyChanges, inspectPullRequest, mobileDependencyGraph, nativeDependenciesChanged } from './ci-changes.mjs';

const heavy = ['backend_build', 'web', 'wear', 'native_runtime', 'native_package', 'image', 'database', 'migrations'];

test('documentation and test-only changes avoid unrelated compilation, images and database rehearsals', () => {
  for (const file of ['README.md', 'backend/README.md', 'mobile/src/README.md', 'wear/README.md',
    'mobile/src/components/AppCard.test.tsx', 'backend/test/auth.test.js', 'mobile/test/jest.setup.ts']) {
    const selected = classifyChanges([file]);
    assert.deepEqual(heavy.filter(key => selected[key]), [], file);
    if (file.endsWith('.md')) {
      assert.deepEqual(Object.keys(selected).filter(key => selected[key]), ['non_release_mirror']);
    }
  }
  assert.equal(classifyChanges(['backend/test/auth.test.js']).backend, true);
  assert.equal(classifyChanges(['mobile/src/components/AppCard.test.tsx']).mobile, true);
});

test('ordinary app source bundles native JavaScript without compiling phone packages or Wear', () => {
  const selected = classifyChanges(['mobile/src/components/AppCard.tsx']);
  assert.deepEqual(heavy.filter(key => selected[key]), ['web', 'native_runtime', 'image']);
  assert.equal(selected.mobile, true);
  assert.equal(selected.api, false);
  assert.equal(selected.kotlin, false);
  assert.equal(selected.type_backend, false);
});

test('MCP browser, data and plugin inputs select their independent integration suite', () => {
  for (const file of ['backend/src/mcp/ui/main.ts', 'backend/src/services/mcpProgressAnalysis.ts',
    'backend/scripts/build-mcp-app.mjs', 'backend/scripts/dev-mcp-server.mjs', 'e2e/mcp-app/progress.spec.ts', 'playwright.mcp-app.config.ts',
    'plugins/calibrate-health/.codex-plugin/plugin.json', 'plugins/calibrate-health/skills/calibrate-progress/SKILL.md',
    'scripts/calibrate-plugin.mjs', 'backend/package-lock.json', 'shared/designTokens.ts',
    'backend/tsconfig.mcp-app.json', 'LICENSE', 'NOTICE']) {
    assert.equal(classifyChanges([file]).mcp, true, file);
  }
  assert.equal(classifyChanges(['backend/tsconfig.mcp-app.json']).type_backend, true);
  for (const file of ['backend/src/routes/food.ts', 'mobile/src/components/AppCard.tsx', 'README.md']) {
    assert.equal(classifyChanges([file]).mcp, false, file);
  }
});

test('platform-specific source selects its runtime, and backend source never selects phone builds', () => {
  assert.equal(classifyChanges(['mobile/src/platform/network.web.ts']).native_runtime, false);
  assert.equal(classifyChanges(['mobile/src/platform/network.native.ts']).web, false);
  assert.equal(classifyChanges(['mobile/src/platform/network.native.ts']).image, false);
  const backend = classifyChanges(['backend/src/routes/food.ts']);
  assert.equal(backend.backend_build, true);
  assert.equal(backend.backend, true);
  assert.equal(backend.image, true);
  assert.equal(backend.mobile, false);
  assert.equal(backend.native_package, false);
  const aliases = classifyChanges(['mobile/tsconfig.json']);
  assert.equal(aliases.web, true);
  assert.equal(aliases.native_runtime, true);
  assert.equal(aliases.native_package, false);
});

test('compiled configuration and packaged icons select native builds; ordinary runtime images do not', () => {
  for (const file of ['mobile/app.config.js', 'mobile/app.json', 'mobile/eas.json',
    'mobile/plugins/withHealthConnect.js', 'mobile/modules/wear-pairing/android/src/Module.kt',
    'mobile/modules/wear-pairing/ios/Module.swift', 'mobile/modules/wear-pairing/expo-module.config.json',
    'mobile/assets/icon-ios.png', 'patches/react-native.patch', 'mobile/react-native.config.js',
    'mobile/fingerprint.config.js']) {
    assert.equal(classifyChanges([file]).native_package, true, file);
  }
  for (const file of ['mobile/assets/food.png', 'mobile/modules/wear-pairing/src/index.ts']) {
    assert.equal(classifyChanges([file]).native_package, false, file);
    assert.equal(classifyChanges([file]).native_runtime, true, file);
  }
  const wear = classifyChanges(['wear/app/src/main/java/app/Screen.kt']);
  assert.equal(wear.wear, true);
  assert.equal(wear.kotlin, true);
  assert.equal(wear.native_package, false);
});

test('platform-specific compiled inputs avoid building the other phone platform', () => {
  for (const file of ['mobile/gradle/wrapper/gradle-wrapper.jar',
    'mobile/gradle/native-release/phone/gradle/verification-metadata.xml',
    'mobile/modules/wear-pairing/android/build.gradle', 'mobile/assets/notification-icon.png',
    'wear/gradle/wrapper/gradle-wrapper.jar']) {
    const selected = classifyChanges([file]);
    assert.equal(selected.native_android, true, file);
    assert.equal(selected.native_ios, false, file);
  }
  for (const file of ['mobile/modules/bridge/ios/Bridge.swift', 'mobile/assets/icon-ios.png']) {
    const selected = classifyChanges([file]);
    assert.equal(selected.native_android, false, file);
    assert.equal(selected.native_ios, true, file);
  }
});

test('OpenAPI and database changes retain their specific integration checks', () => {
  const api = classifyChanges(['backend/openapi/v1.yaml']);
  assert.equal(api.api, true);
  assert.equal(api.api_contract, true);
  assert.equal(api.mobile, false);
  assert.equal(api.image, false);
  for (const file of ['backend/prisma/schema.prisma', 'backend/src/services/goalPace.ts', 'shared/caloriePolicy.ts']) {
    const result = classifyChanges([file]);
    assert.equal(result.database, true, file);
    assert.equal(result.migrations, false, file);
  }
  assert.equal(classifyChanges(['backend/prisma/migrations/0099_test/migration.sql']).migrations, true);
  const client = classifyChanges(['packages/api-client/test/transport.test.ts']);
  assert.equal(client.api, true);
  assert.equal(client.type_api, true);
  assert.equal(client.api_contract, false);
  assert.equal(classifyChanges(['wear/app/src/test/java/app/StateTest.kt']).wear, true);
  assert.equal(classifyChanges(['mobile/public/robots.txt']).image, true);
});

test('workflow and selector changes exercise the checks they control', () => {
  assert.equal(classifyChanges(['release.config.json']).release_config, true);
  const builds = classifyChanges(['.github/workflows/builds.yml']);
  for (const key of ['backend_build', 'web', 'wear', 'native_runtime', 'native_package']) assert.equal(builds[key], true, key);
  const lint = classifyChanges(['.github/workflows/lint.yml']);
  for (const key of ['eslint', 'kotlin', 'type_backend', 'type_shared', 'type_api', 'type_mobile', 'dead_code']) assert.equal(lint[key], true, key);
  const selector = classifyChanges(['scripts/ci-changes.mjs']);
  for (const key of heavy) assert.equal(selector[key], true, key);
  const gate = classifyChanges(['scripts/ci-test-gate.mjs']);
  for (const key of ['backend', 'mobile', 'api', 'api_contract']) assert.equal(gate[key], true, key);
});

function dependencyFixture() {
  const lock = { lockfileVersion: 3, packages: {
    '': { devDependencies: { eslint: '1' } },
    mobile: { version: '1', dependencies: { expo: '1', '@calibrate/api-client': 'file:../packages/api-client' } },
    'node_modules/expo': { version: '1', integrity: 'expo-one', dependencies: { native: '1' } },
    'node_modules/native': { version: '1', integrity: 'native-one', peerDependencies: { peer: '*' } },
    'node_modules/peer': { version: '1' },
    'node_modules/eslint': { version: '1', dev: true },
    'node_modules/@calibrate/api-client': { link: true, resolved: 'packages/api-client' },
    'packages/api-client': { version: '1' },
  } };
  return {
    'package-lock.json': lock, 'package.json': { devDependencies: { eslint: '1' } },
    'mobile/package.json': { dependencies: lock.packages.mobile.dependencies },
    'shared/package.json': {}, 'packages/api-client/package.json': {},
  };
}

function compareFixture(change) {
  const base = dependencyFixture();
  const head = structuredClone(base);
  change(head);
  return nativeDependenciesChanged(file => JSON.stringify(base[file]), file => JSON.stringify(head[file]));
}

test('root tooling and version-only lockfile updates do not compile native apps', () => {
  assert.equal(compareFixture(head => {
    head['package-lock.json'].packages['node_modules/eslint'].version = '2';
    head['package.json'].devDependencies.eslint = '2';
    head['package-lock.json'].packages[''].version = '2';
    head['package-lock.json'].packages.mobile.version = '2';
    head['mobile/package.json'].version = '2';
    head['mobile/package.json'].scripts = { test: 'jest --runInBand' };
  }), false);
});

test('native-relevant dependency identities, peers, hoisting and install behavior select builds', () => {
  for (const change of [
    head => { head['package-lock.json'].packages['node_modules/native'].integrity = 'changed'; },
    head => { head['package-lock.json'].packages['node_modules/peer'].version = '2'; },
    head => { head['package-lock.json'].packages['node_modules/expo/node_modules/native'] = { version: '2' }; },
    head => { head['package.json'].scripts = { postinstall: 'node patch-native.mjs' }; },
    head => { head['mobile/package.json'].scripts = { 'prebuild:ios': 'expo prebuild --clean' }; },
    head => { head['mobile/package.json'].expo = { autolinking: { searchPaths: ['../node_modules'] } }; },
    head => { head['package-lock.json'].packages['packages/api-client'].dependencies = { native: '1' }; },
  ]) assert.equal(compareFixture(change), true);
});

test('unreadable or unrecognized dependency graphs fail conservatively', () => {
  assert.equal(nativeDependenciesChanged(() => { throw new Error('missing'); }, () => '{}'), true);
  assert.equal(compareFixture(head => { delete head['package-lock.json'].packages['node_modules/native']; }), true);
  assert.throws(() => mobileDependencyGraph({ lockfileVersion: 1 }), /workspace npm lockfile/);
  assert.equal(classifyChanges(['package-lock.json']).native_package, true);
});

test('local modules resolve dependencies from the enclosing mobile workspace before the repository root', () => {
  const lock = dependencyFixture()['package-lock.json'];
  lock.packages.mobile.dependencies.bridge = 'file:modules/bridge';
  lock.packages['node_modules/bridge'] = { link: true, resolved: 'mobile/modules/bridge' };
  lock.packages['mobile/modules/bridge'] = { dependencies: { native: '2' } };
  lock.packages['mobile/node_modules/native'] = { version: '2' };
  const graph = mobileDependencyGraph(lock);
  assert.equal(graph['mobile/node_modules/native'].version, '2');
  assert.equal(graph['node_modules/native'].version, '1');
});

test('Git discovery includes deletions, both sides of renames, and files beyond API diff limits', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'calibrate-ci-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.test');
  git('config', 'user.name', 'CI Test');
  mkdirSync(path.join(cwd, 'mobile/plugins'), { recursive: true });
  writeFileSync(path.join(cwd, 'mobile/plugins/native.js'), 'native');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'mobile/plugins/native.js', 'retired.txt');
  for (let index = 0; index < 350; index++) writeFileSync(path.join(cwd, `note-${index}.md`), 'note');
  git('add', '.'); git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  const result = inspectPullRequest(base, head, { cwd });
  assert.equal(result.native_package, true);
  assert.equal(result.backend, false);
  assert.throws(() => inspectPullRequest('main', head, { cwd }), /full Git SHAs/);
  // Advances on the target branch are not changes introduced by this PR.
  git('checkout', '-q', '-b', 'target', base);
  mkdirSync(path.join(cwd, 'backend/src'), { recursive: true });
  writeFileSync(path.join(cwd, 'backend/src/new.ts'), 'export {};');
  git('add', '.'); git('commit', '-qm', 'target advances');
  assert.equal(inspectPullRequest(git('rev-parse', 'HEAD'), head, { cwd }).backend, false);
});
