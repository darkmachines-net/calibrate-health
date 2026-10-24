/** @file Regression coverage for hosted native emulators: hosted Wear lifecycle is unavailable on operator and non-Linux hosts. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  HOSTED_ANDROID_CMDLINE_TOOLS_VERSION,
  HOSTED_WEAR_API_LEVEL,
  HOSTED_WEAR_AVD,
  HOSTED_WEAR_SERIAL,
  HOSTED_WEAR_SYSTEM_IMAGE,
  assertHostedNativeRunner,
  createHostedWearCommandPlan,
  parseHostedNativeEmulatorCommand
} from './hosted-native-emulators.mjs';

const HOSTED_ENVIRONMENT = Object.freeze({
  ANDROID_HOME: '/opt/android-sdk',
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Linux',
  RUNNER_TEMP: '/runner-temp'
});

test('hosted Wear lifecycle is unavailable on operator and non-Linux hosts', () => {
  assert.throws(() => assertHostedNativeRunner({}), /restricted to GitHub Actions Linux runners/);
  assert.throws(
    () => assertHostedNativeRunner({ ...HOSTED_ENVIRONMENT, RUNNER_OS: 'Windows' }),
    /restricted to GitHub Actions Linux runners/
  );
});

test('hosted Wear plan owns one deterministic API 35 x86_64 emulator target', () => {
  const plan = createHostedWearCommandPlan(HOSTED_ENVIRONMENT, 'linux');
  assert.equal(plan.config.avdName, HOSTED_WEAR_AVD);
  assert.equal(plan.config.serial, HOSTED_WEAR_SERIAL);
  assert.equal(plan.config.systemImage, HOSTED_WEAR_SYSTEM_IMAGE);
  assert.equal(HOSTED_WEAR_API_LEVEL, '35-ext15');
  assert.equal(HOSTED_ANDROID_CMDLINE_TOOLS_VERSION, '15859902');
  assert.equal(plan.config.sdkmanager, '/opt/android-sdk/cmdline-tools/15859902/bin/sdkmanager');
  assert.equal(plan.config.avdmanager, '/opt/android-sdk/cmdline-tools/15859902/bin/avdmanager');
  assert.equal(plan.config.serial, 'emulator-5556');
  assert.deepEqual(plan.prepare[0].args, [
    '--install', 'emulator', 'platform-tools',
    'system-images;android-35-ext15;android-wear;x86_64'
  ]);
  assert.deepEqual(plan.wait.args, ['-s', 'emulator-5556', 'wait-for-device']);
  assert.deepEqual(plan.stop.args, ['-s', 'emulator-5556', 'emu', 'kill']);
  assert.ok(plan.start.args.includes('-no-window'));
  assert.ok(plan.start.args.includes('-wipe-data'));
  assert.equal(plan.start.args.includes('-writable-system'), false);
});

test('hosted Wear CLI accepts only fixed lifecycle operations', () => {
  assert.equal(parseHostedNativeEmulatorCommand(['prepare-wear']), 'prepare-wear');
  assert.equal(parseHostedNativeEmulatorCommand(['stop-wear']), 'stop-wear');
  assert.throws(() => parseHostedNativeEmulatorCommand(['start', '--serial', 'device']), /Usage:/);
});

test('hosted workflows activate the same reviewed Android command-line tools', () => {
  const workflow = fs.readFileSync('.github/workflows/builds.yml', 'utf8');
  const activation = 'echo "$ANDROID_HOME/cmdline-tools/15859902/bin" >> "$GITHUB_PATH"';
  assert.equal(workflow.split(activation).length - 1, 5);
  assert.equal(workflow.includes('cmdline-tools/latest/bin'), false);
  assert.match(workflow, /api-level: 35-ext15\s+target: android-wear/);
});
