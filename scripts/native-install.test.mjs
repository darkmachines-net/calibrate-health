/** @file Device installation accepts the common retained pair and verifies its bytes before contacting adb. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelease, finalizePlan, createArtifactReceipt, writeLocalReceipt } from '@mchartier/expo-release';
import { installRetainedNative } from './native-install.mjs';

test('install resolves exact retained phone/watch APK and AAB paths without rebuild or publication credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'master', components:
    ['phone', 'wear'].map(id => ({ id, kind: 'native', builder: 'command', platform: 'android' })) };
  fs.writeFileSync(path.join(root, 'release.config.json'), JSON.stringify(config));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-q']); git(['add', 'release.config.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const source = { repository: config.repository, commit: git(['rev-parse', 'HEAD']), toolkitCommit: 'a'.repeat(40), origin: 'local' };
  const observations = config.components.map(({ id }) => ({ id, identity: id, runtime: id, version: '1.0.0', versionCode: id === 'phone' ? 1 : 2 }));
  const plan = finalizePlan(planRelease({ config, source, origin: { kind: 'local' }, observations, operation: 'build' }), source, observations);
  const artifacts = [];
  for (const target of ['phone', 'wear']) {
    const directory = path.join(root, '.release', target); fs.mkdirSync(directory, { recursive: true });
    for (const format of ['apk', 'aab']) fs.writeFileSync(path.join(directory, `native.${format}`), `${target} ${format}`);
    artifacts.push({ target, directory, receipt: await createArtifactReceipt({ plan, target, directory }) });
  }
  const { file } = writeLocalReceipt(root, plan, artifacts); let calls = 0;
  const install = async value => {
    calls++;
    assert.equal(value.config.skipBuild, true); assert.equal(value.config.phoneSerial, 'fixture-phone');
    assert.equal(value.environment.EXPO_TOKEN, undefined); assert.equal(value.environment.GH_TOKEN, undefined);
    assert.deepEqual(Object.keys(value.retainedFiles).sort(), ['phone-aab', 'phone-apk', 'watch-aab', 'watch-apk']);
    assert.equal(fs.readFileSync(value.retainedFiles['watch-apk'], 'utf8'), 'wear apk');
    return { installed: true };
  };
  const args = ['--receipt', file, '--phone-serial', 'fixture-phone'];
  assert.deepEqual(await installRetainedNative(args, { root, install, environment: { EXPO_TOKEN: 'secret', GH_TOKEN: 'secret' } }), { installed: true });
  fs.writeFileSync(path.join(artifacts[0].directory, 'native.apk'), 'altered');
  await assert.rejects(installRetainedNative(args, { root, install, environment: {} }), /mismatch|differ/);
  assert.equal(calls, 1);
  await assert.rejects(installRetainedNative(['--receipt', file, '--skip-build'], { root, install }), /Unknown/);
});
