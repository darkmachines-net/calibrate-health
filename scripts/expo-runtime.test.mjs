/** @file Fail closed when SDK discovery returns an incomplete native graph rather than a reliable fingerprint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validateRuntimeResolution } from './expo-runtime.mjs';

/** Keep the fixture aligned with the locked SDK's normalized fingerprint source shape. */
function resolved() {
  return { runtimeVersion: 'a'.repeat(40), fingerprintSources: [
    { id: 'expoAutolinkingConfig:android', contents: JSON.stringify({ modules: [{ packageName: 'expo-updates' }, { packageName: '@calibrate/wear-pairing' }] }) },
    { id: 'rncoreAutolinkingConfig:android', contents: JSON.stringify({ 'react-native-health-connect': {} }) }
  ] };
}

test('runtime resolution accepts a complete native graph', () => {
  assert.equal(validateRuntimeResolution(resolved()), 'a'.repeat(40));
});

test('a valid-looking hash cannot hide failed autolinking or appVersion policy', () => {
  assert.throws(() => validateRuntimeResolution({ ...resolved(), runtimeVersion: '0.2.8' }), /fingerprint/);
  for (const index of [0, 1]) {
    const value = resolved();
    value.fingerprintSources[index].contents = '{}';
    assert.throws(() => validateRuntimeResolution(value), /Incomplete/);
  }
});

test('SDK hashing ignores transient Kotlin sessions while retaining native plugin source', async (t) => {
  const require = createRequire(new URL('../mobile/package.json', import.meta.url));
  const sdkRoot = path.dirname(require.resolve('@expo/fingerprint/package.json'));
  const { normalizeOptionsAsync } = require(path.join(sdkRoot, 'build/Options.js'));
  const { createFingerprintFromSourcesAsync } = require(path.join(sdkRoot, 'build/hash/Hash.js'));
  const config = require('../mobile/fingerprint.config.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-kotlin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = 'node_modules/expo-updates/expo-updates-gradle-plugin';
  const source = path.join(root, plugin, 'src/Plugin.kt');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'class Plugin');
  const options = await normalizeOptionsAsync(root, { platforms: ['android'], ignorePaths: config.ignorePaths });
  /** Exercise the SDK directory hasher against the same native-module discovery shape. */
  const hash = async (settings = options) => (await createFingerprintFromSourcesAsync(
    [{ type: 'dir', filePath: plugin, reasons: ['expoAutolinkingAndroid'] }], root, settings
  )).hash;
  const clean = await hash();
  const session = path.join(root, plugin, '.kotlin/sessions/compiler.salive');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, '');
  assert.equal(await hash(), clean);
  const defaults = await normalizeOptionsAsync(root, { platforms: ['android'] });
  assert.notEqual(await hash(defaults), clean, 'the locked SDK otherwise hashes the transient session');
  fs.writeFileSync(source, 'class UpdatedPlugin');
  assert.notEqual(await hash(), clean, 'real native source must still change the runtime');
});
