/** @file Regression coverage for hosted android e2e: hosted Android command plan is Linux-only and scopes install to one emulator. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {
  HOSTED_ANDROID_LOG_MAX_BYTES,
  boundHostedAndroidLog,
  createHostedAndroidCommandPlan,
  createHostedAndroidMetroEnvironment,
  redactHostedAndroidDiagnostics,
  runHostedAndroidE2e,
  waitForHostedAndroidMetro
} from './hosted-android-e2e.mjs';

const HOSTED_ENVIRONMENT = Object.freeze({
  ADB: '/opt/android-sdk/platform-tools/adb',
  ANDROID_ADB_SERIAL: 'emulator-5554',
  CALIBRATE_ANDROID_APK: '.ci-artifacts/android-debug/app-debug.apk',
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Linux',
  RUNNER_TEMP: '/runner-temp'
});

function fakeMetro(overrides = {}) {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 4321,
    signalCode: null
  }, overrides);
}

test('hosted Android command plan is Linux-only and scopes install to one emulator', () => {
  assert.throws(
    () => createHostedAndroidCommandPlan({ ...HOSTED_ENVIRONMENT, GITHUB_ACTIONS: 'false' }, 'linux'),
    /restricted to GitHub Actions Linux runners/
  );
  assert.throws(
    () => createHostedAndroidCommandPlan(HOSTED_ENVIRONMENT, 'win32'),
    /restricted to GitHub Actions Linux runners/
  );
  assert.throws(
    () => createHostedAndroidCommandPlan({ ...HOSTED_ENVIRONMENT, ANDROID_ADB_SERIAL: 'device' }, 'linux'),
    /explicitly name an emulator-<port>/
  );

  const plan = createHostedAndroidCommandPlan(HOSTED_ENVIRONMENT, 'linux', '/repo');
  assert.deepEqual(plan.metro.args, [
    '--prefix', 'mobile', 'run', 'dev', '--', '--host', 'localhost', '--port', '8081'
  ]);
  assert.deepEqual(plan.install.args, [
    '-s', 'emulator-5554', 'install', '-r', path.resolve('/repo/.ci-artifacts/android-debug/app-debug.apk')
  ]);
  assert.deepEqual(plan.e2e.args, ['run', 'test:android:e2e']);
  assert.equal(plan.config.logFile, path.resolve('/runner-temp/calibrate-native/metro.log'));
});

test('hosted Metro environment forces CI without mutating caller environment', () => {
  const environment = { TOKEN: 'value', CI: '0' };
  const metroEnvironment = createHostedAndroidMetroEnvironment(environment);
  assert.deepEqual(metroEnvironment, { TOKEN: 'value', CI: '1' });
  assert.notEqual(metroEnvironment, environment);
  assert.equal(environment.CI, '0');
});

test('hosted Android Metro wait accepts readiness and detects early exit and timeout', async () => {
  await waitForHostedAndroidMetro(fakeMetro(), {
    fetchImpl: async (url) => ({
      ok: url === 'http://localhost:8081/status',
      text: async () => 'packager-status:running'
    }),
    timeoutMs: 10
  });

  await assert.rejects(
    waitForHostedAndroidMetro(fakeMetro({ exitCode: 1 }), {
      fetchImpl: async () => { throw new Error('must not fetch after exit'); },
      timeoutMs: 10
    }),
    /exited before becoming ready/
  );

  let currentTime = 0;
  const fetchTimeouts = [];
  const sleeps = [];
  await assert.rejects(
    waitForHostedAndroidMetro(fakeMetro(), {
      abortSignalTimeout: (milliseconds) => {
        fetchTimeouts.push(milliseconds);
        return new AbortController().signal;
      },
      fetchImpl: async () => { throw new Error('connection refused'); },
      now: () => currentTime,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
      timeoutMs: 2_500
    }),
    /did not become ready within 90 seconds/
  );
  assert.deepEqual(fetchTimeouts, [2_000, 1_500, 500]);
  assert.deepEqual(sleeps, [1_000, 1_000, 500]);
});

test('hosted Android Metro diagnostics are redacted and byte bounded', () => {
  const secret = 'CALIBRATE_TOKEN=visible Bearer abc.def password';
  const redacted = redactHostedAndroidDiagnostics(`\u001b[31m${secret}\u001b[0m`);
  assert.equal(redacted.includes('visible'), false);
  assert.equal(redacted.includes('abc.def'), false);
  assert.equal(redacted.includes('\u001b'), false);

  const bounded = boundHostedAndroidLog(`Bearer token\n${'x'.repeat(HOSTED_ANDROID_LOG_MAX_BYTES + 500)}`);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= HOSTED_ANDROID_LOG_MAX_BYTES);
  assert.equal(bounded.includes('token'), false);

  const unicodeLimit = HOSTED_ANDROID_LOG_MAX_BYTES - 1;
  const unicodeTail = boundHostedAndroidLog(`${String.fromCodePoint(0x20AC).repeat(87382)}a`, unicodeLimit);
  assert.ok(Buffer.byteLength(unicodeTail, 'utf8') <= unicodeLimit);
  assert.equal(unicodeTail.includes('\uFFFD'), false);
});

test('hosted Android lifecycle always terminates Metro when a command fails', async () => {
  const calls = [];
  const metro = fakeMetro();
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (message) => errors.push(message);
  try {
    await assert.rejects(
      runHostedAndroidE2e(HOSTED_ENVIRONMENT, {
        platform: 'linux',
        createLog: () => ({ diagnostics: () => '', write: () => undefined }),
        startMetro: () => metro,
        waitForMetro: async () => undefined,
        runCommand: async (request, environment) => {
          assert.equal(environment, HOSTED_ENVIRONMENT);
          calls.push(request.args);
          throw new Error('install failed');
        },
        terminateMetro: async (child) => {
          assert.equal(child, metro);
          calls.push('terminated');
        }
      }),
      /install failed/
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 4), ['-s', 'emulator-5554', 'install', '-r']);
  assert.equal(calls[1], 'terminated');
  assert.deepEqual(errors, ['[hosted-android-e2e] install failed']);
});
