/** Fail closed when SDK discovery returns an incomplete native graph rather than a reliable fingerprint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validateRuntimeResolution } from './expo-runtime.mjs';

test('runtime resolution accepts only the explicit major policy', () => {
  assert.equal(validateRuntimeResolution({ runtimeVersion: '2' }), '2');
  for (const runtimeVersion of ['0.2.8', 'a'.repeat(40), '02']) assert.throws(() => validateRuntimeResolution({ runtimeVersion }), /major-only/);
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
