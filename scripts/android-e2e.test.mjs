/** @file Regression coverage for android e2e: Android E2E uses the same localhost Metro origin as the hosted readiness probe. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ANDROID_E2E_INITIAL_LAUNCH_TIMEOUT_MS,
  ANDROID_E2E_METRO_STATUS_URL,
  assertAndroidAppLinkLaunch,
  buildAddFoodDeepLink,
  buildAddFoodLaunchArgs,
  buildAndroidE2eAdbArgs,
  buildE2eRequestHeaders,
  buildOpenFoodDayRequest,
  crashBufferContainsCalibrateProcess,
  fetchAndroidE2eProxyUpstream,
  isAndroidE2eAddAndCloseNode,
  isAndroidE2eRecentFoodNode,
  parseAndroidPackageVersion,
  resolveAndroidE2eAdb,
  summarizeAndroidE2eUi
} from './android-e2e.mjs';

const release = JSON.parse(readFileSync(new URL('../shared/release.json', import.meta.url), 'utf8'));
const androidE2eSource = readFileSync(new URL('./android-e2e.mjs', import.meta.url), 'utf8');

test('Android E2E uses the same localhost Metro origin as the hosted readiness probe', () => {
  assert.equal(ANDROID_E2E_METRO_STATUS_URL, 'http://localhost:8081/status');
  assert.equal(ANDROID_E2E_INITIAL_LAUNCH_TIMEOUT_MS, 150_000);
});

test('Android E2E proxy retries only idempotent GET transport failures', async () => {
  const delays = [];
  let getAttempts = 0;
  const response = await fetchAndroidE2eProxyUpstream(
    new URL('http://127.0.0.1:3000/api/v1/food-days'),
    { method: 'GET' },
    {
      fetchImpl: async () => {
        getAttempts += 1;
        if (getAttempts < 3) throw new Error('transient socket');
        return { ok: true };
      },
      sleepImpl: async (delay) => delays.push(delay)
    }
  );
  assert.equal(response.ok, true);
  assert.equal(getAttempts, 3);
  assert.deepEqual(delays, [250, 500]);

  let postAttempts = 0;
  await assert.rejects(
    fetchAndroidE2eProxyUpstream(
      new URL('http://127.0.0.1:3000/api/v1/food'),
      { method: 'POST' },
      {
        fetchImpl: async () => {
          postAttempts += 1;
          throw new Error('ambiguous mutation transport');
        },
        sleepImpl: async () => assert.fail('POST must not retry')
      }
    ),
    /ambiguous mutation transport/
  );
  assert.equal(postAttempts, 1);
});

test('Android E2E opens Add food through a fresh canonical native route', () => {
  assert.equal(buildAddFoodDeepLink('2026-08-10'), 'https://calibratehealth.app/log?date=2026-08-10');
  assert.deepEqual(buildAddFoodLaunchArgs('2026-08-10'), [
    'shell', 'am', 'start', '-W', '-S',
    '-a', 'android.intent.action.VIEW',
    '-d', 'https://calibratehealth.app/log?date=2026-08-10',
    'net.darkmachines.healthtracker',
  ]);
  assert.doesNotThrow(() => assertAndroidAppLinkLaunch(
    'Status: ok\nActivity: net.darkmachines.healthtracker/.MainActivity\nTotalTime: 842',
  ));
  assert.throws(
    () => assertAndroidAppLinkLaunch('Status: ok\nActivity: com.android.chrome/.Main'),
    /did not launch the Calibrate activity/,
  );
  assert.throws(() => buildAddFoodDeepLink('08/10/2026'), /must be YYYY-MM-DD/);
  assert.doesNotMatch(androidE2eSource, /'monkey'/);
  assert.match(
    androidE2eSource,
    /logRecentFood\(onlineName, date, ANDROID_E2E_INITIAL_LAUNCH_TIMEOUT_MS\)/,
  );
});

test('Android E2E failure diagnostics expose only fixed UI markers', () => {
  const xml = '<hierarchy>'
    + '<node text="Today" content-desc="" />'
    + '<node text="Private seeded value" content-desc="" />'
    + '<node text="" content-desc="Add food" />'
    + '</hierarchy>';
  assert.equal(summarizeAndroidE2eUi(xml), 'Add food, Today');
  assert.equal(summarizeAndroidE2eUi('<hierarchy />'), 'none');
});

test('Android E2E matches only enabled recent-food action rows', () => {
  assert.equal(isAndroidE2eRecentFoodNode({ label: 'Choose amount for Android E2E latte', clickable: true }, 'Android E2E latte'), true);
  assert.equal(isAndroidE2eRecentFoodNode({ label: 'Choose amount for Android E2E latte', clickable: false }, 'Android E2E latte'), false);
  assert.equal(isAndroidE2eRecentFoodNode({ label: 'Choose amount for Another food', clickable: true }, 'Android E2E latte'), false);
});

test('Android E2E submits the selected recent-food amount through Add & close', () => {
  assert.equal(isAndroidE2eAddAndCloseNode({ label: 'Add & close', clickable: true }), true);
  assert.equal(isAndroidE2eAddAndCloseNode({ label: 'Add & close', clickable: false }), false);
  assert.equal(isAndroidE2eAddAndCloseNode({ label: 'Add another', clickable: true }), false);
});

test('Android E2E API probes identify the current phone release', () => {
  const headers = buildE2eRequestHeaders({
    authorization: 'Bearer test-token',
    'x-calibrate-client-platform': 'wear_os',
    'x-calibrate-client-version': '0.0.0'
  });

  assert.equal(headers.get('authorization'), 'Bearer test-token');
  assert.equal(headers.get('x-calibrate-client-platform'), 'android_phone');
  assert.equal(headers.get('x-calibrate-client-version'), release.android.mobile.version_name);
});

test('Android E2E explicitly reopens the seeded current day before adding recent foods', () => {
  const request = buildOpenFoodDayRequest('test-token', '2026-08-10', 'android-open-day-operation');
  assert.equal(request.method, 'PATCH');
  assert.equal(request.headers.authorization, 'Bearer test-token');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['x-client-operation-id'], 'android-open-day-operation');
  assert.deepEqual(JSON.parse(request.body), { date: '2026-08-10', status: 'OPEN' });
});

test('Android E2E crash checks ignore uiautomator but catch Java and native Calibrate crashes', () => {
  const uiautomatorCrash = `
E/AndroidRuntime( 4036): FATAL EXCEPTION: main
E/AndroidRuntime( 4036): PID: 4036
E/AndroidRuntime( 4036): java.lang.RuntimeException: Timeout while connecting UiAutomation`;
  const calibrateCrash = `
E/AndroidRuntime( 8123): FATAL EXCEPTION: main
E/AndroidRuntime( 8123): Process: net.darkmachines.healthtracker, PID: 8123`;

  const nativeCrash = 'Fatal signal 11 (SIGSEGV)\npid: 8123 >>> net.darkmachines.healthtracker <<<';

  assert.equal(crashBufferContainsCalibrateProcess(uiautomatorCrash), false);
  assert.equal(crashBufferContainsCalibrateProcess(calibrateCrash), true);
  assert.equal(crashBufferContainsCalibrateProcess(nativeCrash), true);
});

test('hosted Android E2E scopes every adb request to its explicit emulator', () => {
  assert.deepEqual(buildAndroidE2eAdbArgs(['shell', 'getprop', 'ro.kernel.qemu'], ' emulator-5554 '), [
    '-s', 'emulator-5554', 'shell', 'getprop', 'ro.kernel.qemu'
  ]);
  assert.throws(
    () => buildAndroidE2eAdbArgs(['devices'], ''),
    /must explicitly name an emulator-<port>/
  );
  assert.throws(
    () => buildAndroidE2eAdbArgs(['devices'], 'R5CRphysical'),
    /must explicitly name an emulator-<port>/
  );
  assert.equal(
    resolveAndroidE2eAdb({ ANDROID_HOME: '/opt/android-sdk' }, 'linux'),
    '/opt/android-sdk/platform-tools/adb'
  );
  assert.equal(
    resolveAndroidE2eAdb({ ANDROID_SDK_ROOT: 'C:\\Android' }, 'win32'),
    'C:\\Android\\platform-tools\\adb.exe'
  );
});

test('hosted Android evidence parses only fixed installed package identity', () => {
  assert.deepEqual(
    parseAndroidPackageVersion('versionCode=7 minSdk=24 targetSdk=35\nversionName=0.2.5-dev'),
    { versionName: '0.2.5-dev', versionCode: 7 }
  );
  assert.throws(
    () => parseAndroidPackageVersion('versionName=0.2.5-dev'),
    /parse installed Android package version/
  );
});