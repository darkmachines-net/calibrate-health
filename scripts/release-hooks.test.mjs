/** @file Application-owned metadata mirrors and compiled Android assertions at the shared hook boundary. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRepository, validateManifest, createServerReleaseReplacements, createNativeReleaseReplacements,
  NATIVE_RELEASE_FILE_PATHS } from './release-metadata.mjs';
import { validateBundleRuntime, parseBundleResourceValue } from './native-runtime-checks.mjs';
import { validateConfig, planRelease } from '@mchartier/expo-release';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('shared/release.json'));
const config = JSON.parse(read('release.config.json'));

test('current application manifests and diagnostic/API mirrors remain consistent', async () => {
  assert.deepEqual((await checkRepository(root)).errors, []);
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(validateConfig(config), config);
});

test('server metadata transformation preserves independently versioned phone and Wear fields', () => {
  const files = { manifest: 'shared/release.json', diagnostics: 'shared/client-diagnostic-versions.json', rootPackage: 'package.json',
    rootLock: 'package-lock.json', backendPackage: 'backend/package.json', backendLock: 'backend/package-lock.json',
    openApi: 'docs/openapi/v1.yaml', generatedApi: 'packages/api-client/src/generated/v1.ts' };
  const original = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, read(file)]));
  const next = createServerReleaseReplacements(original, '0.41.0');
  assert.deepEqual(JSON.parse(next.manifest).android, manifest.android);
  for (const key of ['rootPackage', 'backendPackage', 'rootLock', 'backendLock']) assert.equal(JSON.parse(next[key]).version, '0.41.0');
  assert.equal(JSON.parse(next.rootLock).packages[''].version, '0.41.0');
  assert.match(next.openApi, /0\.41\.0/); assert.match(next.generatedApi, /0\.41\.0/);
});

test('native metadata maps the shared reservation into existing phone/Wear files without changing server version', () => {
  const original = Object.fromEntries(Object.entries(NATIVE_RELEASE_FILE_PATHS).map(([key, file]) => [key, read(file)]));
  const next = createNativeReleaseReplacements(original, '0.2.10', { mobileVersionCode: 19, wearVersionCode: 20 });
  const changed = JSON.parse(next.manifest);
  assert.deepEqual(changed.server, manifest.server);
  assert.equal(changed.android.mobile.version_code, 19); assert.equal(changed.android.wear.version_code, 20);
  assert.equal(changed.android.mobile.native_release_tag, 'native-v0.2.10');
  assert.deepEqual(validateManifest(changed), []);
});

test('Calibrate configuration keeps paired reservations, metadata server dependency, and explicit internal source-runtime policy', () => {
  const observations = config.components.map(({ id, kind }) => ({ id, identity: id, runtime: 'a'.repeat(40), fingerprint: 'a'.repeat(40),
    version: kind === 'server' ? manifest.server.version : manifest.android.mobile.version_name,
    ...(kind === 'native' ? { versionCode: id === 'wear' ? 18 : 17 } : {}) }));
  const plan = planRelease({ config, source: { repository: config.repository, commit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40), origin: 'local' },
    origin: { kind: 'local' }, observations, targets: ['phone'] });
  assert(plan.selection.selected.includes('wear')); assert(plan.selection.selected.includes('server'));
  assert.equal(plan.components.find(value => value.id === 'phone').next.versionCode % 2, 1);
  assert.equal(plan.components.find(value => value.id === 'wear').next.versionCode % 2, 0);
  assert.equal(config.components.find(value => value.id === 'ota-internal').runtimeBinding, 'source');
  assert.notEqual(config.components.find(value => value.id === 'ota-production').runtimeBinding, 'source');
  assert(plan.graph.stages.find(value => value.id === 'wear:handoff').needs.includes('phone:submit'));
});

test('compiled phone manifest must preserve exact project, channel and runtime without permitting debug/cleartext', () => {
  const expected = { role: 'phone', projectId: config.expo.projectId, channel: 'internal', runtime: 'a'.repeat(40) };
  const xml = `<application android:usesCleartextTraffic="false"><meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/${expected.projectId}"/>
    <meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="@runtime"/>
    <meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" android:value="{&quot;expo-channel-name&quot;:&quot;internal&quot;}"/></application>`;
  validateBundleRuntime(xml, expected, () => expected.runtime);
  validateBundleRuntime(xml, expected, () => 'file:fingerprint', () => expected.runtime);
  assert.throws(() => validateBundleRuntime(xml, expected, () => 'file:fingerprint'), /RUNTIME_VERSION/);
  assert.throws(() => validateBundleRuntime(xml, expected, () => 'file:fingerprint', () => 'b'.repeat(40)), /RUNTIME_VERSION/);
  assert.throws(() => validateBundleRuntime(xml, expected, () => 'file:other', () => expected.runtime), /RUNTIME_VERSION/);
  assert.throws(() => validateBundleRuntime(xml, { ...expected, channel: 'production' }, () => expected.runtime), /channel differs/);
  assert.throws(() => validateBundleRuntime(xml, expected, () => 'other'), /RUNTIME_VERSION/);
  assert.throws(() => validateBundleRuntime(xml.replace('"false"', '"true"'), expected), /HTTPS-only/);
  assert.equal(parseBundleResourceValue(' - [STR] "runtime"\n - [STR] "runtime"'), 'runtime');
  assert.throws(() => parseBundleResourceValue(' - [STR] "one"\n - [STR] "two"'), /consistent/);
});
