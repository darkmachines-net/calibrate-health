/** @file Regression coverage for native: root exposes native package commands and a separate OTA publication command without implementation stages. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseNativeArguments, runNative } from './native.mjs';

function fixture() {
  const calls = [];
  const environment = {
    PATH: 'tools', JAVA_HOME: 'explicit-java',
    CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: 'signing-secret',
    google_play_access_token: 'play-secret', GOOGLE_APPLICATION_CREDENTIALS: 'secret-file',
    EXPO_TOKEN: 'expo-secret'
  };
  const record = (name) => (...args) => { calls.push([name, ...args]); return { ok: true }; };
  return { calls, environment, options: {
    environment, platform: 'win32', readUserEnvironment: () => {
      calls.push(['settings']);
      return { JAVA_HOME: 'saved-java', BUNDLETOOL_JAR: 'saved-bundletool' };
    },
    internal: record('internal'), setup: record('setup'), ota: record('ota'),
    configure: record('configure'), log: record('log'),
    resolveCredentialFile: (field, override) => override ||
      (field === 'credentialsFile' ? 'configured-signing.json' : 'configured-play.json'),
    verifyArtifacts: record('verify'), devices: record('devices')
  } };
}

test('root exposes native package commands and a separate OTA publication command without implementation stages', () => {
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const nativeActions = ['build', 'install', 'submit', 'configure', 'setup'];
  for (const action of nativeActions) assert.equal(scripts['native:' + action], 'node scripts/native.mjs ' + action);
  assert.deepEqual(Object.keys(scripts).filter((name) => name.startsWith('native:')).sort(),
    nativeActions.map((action) => 'native:' + action).sort());
  assert.equal(scripts['ota:publish'], 'node scripts/native.mjs ota');
  assert.equal(scripts.native, undefined);
  assert.deepEqual(Object.keys(scripts).filter((key) => /^(?:setup:|prepare:|build:|release:)native/.test(key)), []);
});

test('root and per-action help do not inspect settings, credentials or artifacts', async () => {
  const { options, calls } = fixture();
  options.resolveCredentialFile = () => assert.fail('Help must not read configured credentials');
  for (const argv of [[], ['--help'], ...['build','ota','install','submit','configure','setup'].map((action) => [action, '--help'])]) {
    const output = await runNative(argv, options);
    if (argv[0] === 'ota') assert.match(output, /npm run ota:publish -- /);
    else assert.match(output, /npm run /);
    assert.doesNotMatch(output, /npm run native --/);
    assert.doesNotMatch(output, /native:(?:doctor|version|status)/);
  }
  assert.deepEqual(calls, []);
});

test('invalid actions and options fail before any side effects or authentication', async () => {
  const { options, calls } = fixture();
  for (const argv of [
    ['prepare'], ['deploy'], ['doctor'], ['version'], ['status'],
    ['build', '--credentials-file'], ['build', '--credentials-file', 'a', '--track', 'production'],
    ['submit', '--service-account-file'], ['submit', '--service-account-file', 'a', '--confirm-play-console-clean', '--track', 'production'],
    ['configure', '--credentials-file'], ['configure', '--service-account-file', 'a', '--service-account-file', 'b'],
    ['install', '--skip-build'], ['install', '--keystore', 'secret'], ['install', '--phone-serial'],
    ['install', '--no-launch', '--no-launch'], ['version', '--bump', 'invalid'], ['ota', '--credentials-file', 'a']
  ]) await assert.rejects(runNative(argv, options));
  assert.deepEqual(calls, []);
});

test('configure admits only Expo authentication before SDK setup', async () => {
  const { options, calls } = fixture();
  await runNative(['configure', '--service-account-file', 'play.json'], options);
  assert.deepEqual(calls.map(([name]) => name), ['configure']);
  assert.deepEqual(calls[0][1], { serviceAccountFile: 'play.json' });
  assert.equal(calls[0][2].environment.EXPO_TOKEN, 'expo-secret');
  assert.equal(calls[0][2].environment.CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, undefined);
});

test('bare build and submit use machine configuration and submit supplies Console coordination implicitly', async () => {
  const { options, calls } = fixture();
  for (const [action, expected] of [
    ['build', ['build', '--credentials-file', 'configured-signing.json']],
    ['submit', ['submit', '--service-account-file', 'configured-play.json', '--confirm-play-console-clean']]
  ]) {
    calls.length = 0;
    await runNative([action], options);
    assert.deepEqual(calls.at(-1)[1], expected);
    if (action === 'submit') assert.deepEqual(calls.map(([name]) => name), ['settings', 'log', 'internal']);
    else assert.deepEqual(calls.map(([name]) => name), ['settings', 'internal']);
  }
  options.resolveCredentialFile = () => { throw new Error('Run native:configure first'); };
  calls.length = 0;
  await assert.rejects(runNative(['build'], options), /native:configure/);
  assert.deepEqual(calls, []);
});

test('build uses external credentials after isolating inherited secrets and restores saved tool paths', async () => {
  const { options, calls, environment } = fixture();
  await runNative(['build', '--credentials-file', 'external.json'], options);
  assert.deepEqual(calls.map(([name]) => name), ['settings', 'internal']);
  assert.deepEqual(calls[1][1], ['build', '--credentials-file', 'external.json']);
  assert.deepEqual(calls[1][2].environment, { PATH: 'tools', JAVA_HOME: 'explicit-java', BUNDLETOOL_JAR: 'saved-bundletool' });
  assert.equal(environment.CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, 'signing-secret');
  assert.equal(environment.BUNDLETOOL_JAR, undefined);
});

test('install verifies retained artifacts before device access and always skips building', async () => {
  const { options, calls } = fixture();
  await runNative(['install', '--phone-serial', 'phone', '--watch-serial', 'watch', '--no-launch'], options);
  assert.deepEqual(calls.map(([name]) => name), ['settings', 'verify', 'devices']);
  const { config, environment } = calls[2][1];
  assert.equal(config.skipBuild, true);
  assert.equal(config.phoneSerial, 'phone');
  assert.equal(config.watchSerial, 'watch');
  assert.equal(config.launch, false);
  assert.equal(config.replaceIncompatible, false);
  assert.equal(environment.EXPO_UPDATES_CHANNEL, 'internal');
  options.verifyArtifacts = () => { throw new Error('Stale build'); };
  calls.length = 0;
  await assert.rejects(runNative(['install'], options), /Stale build/);
  assert.deepEqual(calls.map(([name]) => name), ['settings']);
});

test('submit reuses the local internal worker and explicit Play file', async () => {
  const { options, calls } = fixture();
  const argv = ['submit', '--service-account-file', 'play.json', '--confirm-play-console-clean'];
  await runNative(argv, options);
  assert.deepEqual(calls.map(([name]) => name), ['settings', 'log', 'internal']);
  assert.deepEqual(calls.at(-1)[1], argv);
  assert.equal(calls.at(-1)[2].environment.EXPO_TOKEN, undefined);
});

test('OTA forwards dry-run and baseline options, admits only Expo auth, and needs no Android SDK', async () => {
  const { options, calls } = fixture();
  await runNative(['ota', '--dry-run', '--non-interactive', '--baseline', 'baseline.json', '--message', 'Test update'], options);
  assert.deepEqual(calls.map(([name]) => name), ['ota']);
  const { environment, config } = calls[0][1];
  assert.equal(environment.EXPO_TOKEN, 'expo-secret');
  assert.equal(environment.CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, undefined);
  assert.equal(environment.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(config.dryRun, true);
  assert.equal(config.nonInteractive, true);
  assert.equal(config.baseline, 'baseline.json');
  assert.equal(config.message, 'Test update');
  assert.equal(parseNativeArguments(['ota']).config.dryRun, false);
});

test('setup delegates read-only checks without injecting credentials', async () => {
  const { options, calls } = fixture();
  options.resolveCredentialFile = () => assert.fail('Tool setup must not read configured credentials');
  await runNative(['setup', '--check'], options);
  assert.deepEqual(calls.map(([name]) => name), ['setup']);
  assert.deepEqual(calls[0][1], ['--check']);
  assert.equal(calls[0][2].environment.EXPO_TOKEN, undefined);
});
