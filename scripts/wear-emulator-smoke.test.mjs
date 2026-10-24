/** @file Regression coverage for wear emulator smoke: Wear connection actions expose one explicitly named semantic click target. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertWearRequestedPermissions,
  auditWearActionTargets,
  crashBufferContainsWearProcess,
  createRecoveringWearUiReader,
  findTextNode,
  listWearUiPackages,
  parseBounds,
  parseBoundsRectangle,
  parseWearPackageVersion,
  parseWearFontScale,
  parseWearRequestedPermissions,
  parseWearUiNodes,
  parseWmDensity,
  parseWmSize,
  prepareWearUi,
  restoreWearFontScale,
  resolveWearAdb,
  setAndVerifyWearFontScale,
  summarizeWearScale,
  waitForScrollableWearUi,
  waitForWearUi
} from './wear-emulator-smoke.mjs';

test('Wear connection actions expose one explicitly named semantic click target', () => {
  const source = readFileSync(new URL(
    '../wear/app/src/main/java/app/calibratehealth/wear/CalibrateWearApp.kt',
    import.meta.url,
  ), 'utf8');
  assert.equal(
    source.split(`.clearAndSetSemantics {`).length - 1,
    2,
  );
  assert.equal(source.split(`onClick(label = "Connection") {`).length - 1, 2);
  assert.equal(source.split('contentDescription = "Connection. ${').length - 1, 2);
  assert.match(source, /connectionLabel\(appState, homeState\.syncStatus\)/);
  assert.match(source, /connectionLabel\(WearAppState\.Ready\(summary\), homeState\.syncStatus\)/);
  assert.equal(
    source.includes(`.semantics(mergeDescendants = true) { contentDescription = "Connection" }`),
    false,
  );
});

function node(attributes) {
  return `<node ${Object.entries(attributes).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
}

test('Wear UI preparation provisions, verifies, wakes, and unlocks the emulator before launch', () => {
  const commands = [];
  prepareWearUi((args) => {
    commands.push(args);
    if (args[2] === 'get') return '1';
    return '';
  });
  assert.deepEqual(commands, [
    ['shell', 'settings', 'put', 'global', 'device_provisioned', '1'],
    ['shell', 'settings', 'put', 'secure', 'user_setup_complete', '1'],
    ['shell', 'settings', 'get', 'global', 'device_provisioned'],
    ['shell', 'settings', 'get', 'secure', 'user_setup_complete'],
    ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
    ['shell', 'wm', 'dismiss-keyguard'],
    ['shell', 'input', 'keyevent', '82']
  ]);

  assert.throws(
    () => prepareWearUi((args) => (
      args[2] === 'get' && args[4] === 'device_provisioned' ? '0' : '1'
    )),
    /did not persist global device_provisioned=1/
  );
});

test('Wear adb resolution trims an explicit executable override', () => {
  assert.equal(
    resolveWearAdb({ ADB: '  /opt/platform-tools/custom-adb  ' }, 'linux'),
    '/opt/platform-tools/custom-adb',
  );
});

test('Wear adb resolution uses Linux SDK roots and a PATH fallback', () => {
  assert.equal(
    resolveWearAdb({ ANDROID_HOME: '/opt/android-sdk' }, 'linux'),
    '/opt/android-sdk/platform-tools/adb',
  );
  assert.equal(resolveWearAdb({ ANDROID_SDK_ROOT: '/srv/android-sdk' }, 'linux'), '/srv/android-sdk/platform-tools/adb');
  assert.equal(resolveWearAdb({}, 'linux'), 'adb');
});

test('Wear adb resolution uses Windows SDK and local-app-data paths', () => {
  assert.equal(resolveWearAdb({ ANDROID_SDK_ROOT: 'C:\\Android' }, 'win32'), 'C:\\Android\\platform-tools\\adb.exe');
  assert.equal(
    resolveWearAdb({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'win32'),
    'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
  );
  assert.equal(resolveWearAdb({}, 'win32'), 'adb.exe');
});

test('Wear smoke parser derives tap coordinates from the UI tree', () => {
  const xml = '<hierarchy><node text="Connection" bounds="[24,156][430,260]" /></hierarchy>';

  const found = findTextNode(xml, 'Connection');
  assert.deepEqual(found, { text: 'Connection', bounds: '[24,156][430,260]' });
  assert.deepEqual(parseBounds(found.bounds), { x: 227, y: 208 });
  assert.deepEqual(parseBoundsRectangle(found.bounds), { left: 24, top: 156, right: 430, bottom: 260 });
});

test('Wear smoke parser finds exact accessibility descriptions', () => {
  const xml = '<hierarchy><node text="" content-desc="Connection. Phone setup required" bounds="[24,156][430,260]" /></hierarchy>';

  assert.deepEqual(findTextNode(xml, 'Connection. Phone setup required'), {
    text: 'Connection. Phone setup required',
    bounds: '[24,156][430,260]'
  });
  assert.equal(findTextNode(xml, 'Connection'), null);
});

test('Wear readiness waits for one complete exact UI tree', () => {
  const expected = ['calibrate', 'Connection'];
  const trees = [
    '<hierarchy />',
    '<hierarchy><node text="calibrate" bounds="[1,1][2,2]" /></hierarchy>',
    '<hierarchy><node text="calibrate" bounds="[1,1][2,2]" />' +
      '<node text="Connection" bounds="[2,2][3,3]" /></hierarchy>'
  ];
  let reads = 0;
  let waits = 0;
  const ready = waitForWearUi(expected, () => trees[reads++], () => { waits += 1; }, 3);
  assert.equal(ready, trees[2]);
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('Wear readiness reasserts the app after first-boot System UI takes foreground', () => {
  const trees = [
    '<hierarchy><node package="com.google.android.wearable.sysui" /></hierarchy>',
    '<hierarchy><node package="net.darkmachines.healthtracker" text="calibrate" /></hierarchy>'
  ];
  let reads = 0;
  let relaunches = 0;
  const readUi = createRecoveringWearUiReader(
    'net.darkmachines.healthtracker',
    () => trees[reads++],
    () => { relaunches += 1; }
  );

  assert.equal(readUi(), trees[0]);
  assert.equal(relaunches, 1);
  assert.equal(readUi(), trees[1]);
  assert.equal(relaunches, 1);
  assert.throws(
    () => createRecoveringWearUiReader('bad package', () => '', () => {}),
    /exact package name/
  );
});

test('Wear readiness fails closed after its bounded exact-selector attempts', () => {
  const blockedTree = '<hierarchy><node text="calibrate" package="com.google.android.wearable.setupwizard" ' +
    'bounds="[1,1][2,2]" /></hierarchy>';
  assert.deepEqual(listWearUiPackages(blockedTree), ['com.google.android.wearable.setupwizard']);

  let reads = 0;
  let waits = 0;
  assert.throws(
    () => waitForWearUi(
      ['calibrate', 'Connection'],
      () => {
        reads += 1;
        return blockedTree;
      },
      () => { waits += 1; },
      3
    ),
    /did not become ready with expected text: Connection; visible packages: com.google.android.wearable.setupwizard/
  );
  assert.equal(reads, 3);
  assert.equal(waits, 2);
  assert.throws(() => waitForWearUi([], () => '', () => {}), /exact non-empty text selectors/);
  assert.throws(() => waitForWearUi(['calibrate'], () => '', () => {}, 0), /positive integer/);
});

test('Wear scrollable readiness verifies exact rows across one bounded surface', () => {
  const trees = [
    '<hierarchy><node text="Connection" bounds="[1,1][2,2]" /></hierarchy>',
    '<hierarchy><node text="release build" bounds="[1,1][2,2]" /></hierarchy>',
    '<hierarchy><node text="Pair on phone" bounds="[1,1][2,2]" /></hierarchy>'
  ];
  let reads = 0;
  let scrolls = 0;
  const ready = waitForScrollableWearUi(
    ['Connection', 'release build', 'Pair on phone'],
    () => trees[reads++],
    () => { scrolls += 1; },
    3
  );
  assert.equal(ready, trees[2]);
  assert.equal(reads, 3);
  assert.equal(scrolls, 2);
  assert.throws(
    () => waitForScrollableWearUi(['Connection', 'Pair on phone'], () => trees[0], () => {}, 2),
    /did not expose expected text: Pair on phone/
  );
});


test('Wear display parsers prefer active overrides and reject malformed values', () => {
  assert.deepEqual(parseWmSize('Physical size: 454x454\nOverride size: 400x400'), { width: 400, height: 400 });
  assert.equal(parseWmDensity('Physical density: 320\nOverride density: 280'), 280);
  assert.throws(() => parseWmSize('unknown'), /parse Wear screen size/);
  assert.throws(() => parseWmDensity('0'), /parse Wear screen density/);
  assert.throws(() => parseBounds('24,156,430,260'), /Invalid Android bounds/);
  assert.throws(() => parseBoundsRectangle('[1,1][1,5]'), /positive area/);
});

test('Wear action audit accepts named 48 dp targets and ignores disabled nodes', () => {
  const xml = `<hierarchy>${node({
    text: 'Connection',
    'content-desc': '',
    clickable: 'true',
    enabled: 'true',
    bounds: '[0,0][96,96]'
  })}${node({
    text: '',
    'content-desc': '',
    clickable: 'true',
    enabled: 'false',
    bounds: '[0,0][2,2]'
  })}</hierarchy>`;
  const parsed = parseWearUiNodes(xml);
  assert.equal(parsed.length, 2);
  const audit = auditWearActionTargets(xml, { width: 454, height: 454 }, 320);
  assert.deepEqual(audit, { actionCount: 1, minimumWidthDp: 48, minimumHeightDp: 48 });
});

test('Wear action audit excludes unrelated System UI actions', () => {
  const appPackage = 'net.darkmachines.healthtracker';
  const xml = `<hierarchy>${node({
    package: appPackage,
    text: 'Connection',
    'content-desc': '',
    clickable: 'true',
    enabled: 'true',
    bounds: '[0,0][96,96]'
  })}${node({
    package: 'com.google.android.wearable.sysui',
    text: '',
    'content-desc': '',
    clickable: 'true',
    enabled: 'true',
    bounds: '[0,0][2,2]'
  })}</hierarchy>`;
  assert.equal(parseWearUiNodes(xml)[0].packageName, appPackage);
  assert.deepEqual(
    auditWearActionTargets(xml, { width: 454, height: 454 }, 320, { packageName: appPackage }),
    { actionCount: 1, minimumWidthDp: 48, minimumHeightDp: 48 },
  );
  assert.throws(
    () => auditWearActionTargets(xml, { width: 454, height: 454 }, 320, { packageName: 'bad package' }),
    /exact package name/
  );
});

test('Wear action audit rejects 47 dp, clipping, and unnamed actions', () => {
  const base = { clickable: 'true', enabled: 'true', text: 'Action', 'content-desc': '' };
  assert.throws(
    () => auditWearActionTargets(`<hierarchy>${node({ ...base, bounds: '[0,0][94,96]' })}</hierarchy>`,
      { width: 454, height: 454 }, 320),
    /smaller than 48 dp/
  );
  assert.throws(
    () => auditWearActionTargets(`<hierarchy>${node({ ...base, bounds: '[400,0][500,100]' })}</hierarchy>`,
      { width: 454, height: 454 }, 320),
    /clipped outside/
  );
  assert.throws(
    () => auditWearActionTargets(`<hierarchy>${node({ ...base, text: '', bounds: '[0,0][96,96]' })}</hierarchy>`,
      { width: 454, height: 454 }, 320),
    /no accessible name/
  );
});

test('Wear scale summary combines surfaces without retaining UI XML', () => {
  const summary = summarizeWearScale(1.3, { width: 454, height: 454 }, 320, [
    { actionCount: 2, minimumWidthDp: 52, minimumHeightDp: 48 },
    { actionCount: 0, minimumWidthDp: null, minimumHeightDp: null }
  ]);
  assert.deepEqual(summary, {
    fontScale: 1.3,
    screenWidthPx: 454,
    screenHeightPx: 454,
    densityDpi: 320,
    actionCount: 2,
    minimumWidthDp: 52,
    minimumHeightDp: 48
  });
  assert.equal(JSON.stringify(summary).includes('hierarchy'), false);
});

test('Wear package and font-scale restoration helpers fail closed', () => {
  assert.deepEqual(
    parseWearPackageVersion('versionCode=7 minSdk=30 targetSdk=35\nversionName=0.2.5'),
    { versionName: '0.2.5', versionCode: 7 }
  );
  assert.throws(() => parseWearPackageVersion('versionName=0.2.5'), /parse installed Wear package version/);
  assert.equal(parseWearFontScale('1.0\r\n'), 1);
  assert.equal(parseWearFontScale('1.3'), 1.3);
  assert.throws(() => parseWearFontScale('null'), /parse the Wear font scale/);
  assert.throws(() => parseWearFontScale('0'), /parse the Wear font scale/);

  const restored = [];
  assert.equal(restoreWearFontScale('1.15', (value) => restored.push(value), () => '1.150'), true);
  assert.deepEqual(restored, ['1.15']);
  assert.equal(
    restoreWearFontScale(null, () => assert.fail('must not set'), () => assert.fail('must not read')),
    false
  );
  assert.throws(
    () => restoreWearFontScale('1.15', () => {}, () => '1.0'),
    /readback 1 did not match requested 1.15/
  );
});

test('Wear font-scale exercise rejects ignored and clamped settings writes', () => {
  const writes = [];
  assert.equal(setAndVerifyWearFontScale(1.3, (value) => writes.push(value), () => '1.30'), 1.3);
  assert.deepEqual(writes, ['1.3']);
  assert.throws(
    () => setAndVerifyWearFontScale(1.3, () => {}, () => '1.0'),
    /readback 1 did not match requested 1.3/
  );
  assert.throws(
    () => setAndVerifyWearFontScale(1.3, () => {}, () => '1.2'),
    /readback 1.2 did not match requested 1.3/
  );
});
test('Wear package evidence requires the exact permission set and detects native crashes', () => {
  const reviewed = [
    'Package [net.darkmachines.healthtracker]',
    '    requested permissions:',
    '      android.permission.INTERNET',
    '      android.permission.ACCESS_NETWORK_STATE',
    '      android.permission.FOREGROUND_SERVICE',
    '      android.permission.POST_NOTIFICATIONS',
    '      android.permission.RECEIVE_BOOT_COMPLETED',
    '      android.permission.WAKE_LOCK',
    '      net.darkmachines.healthtracker.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
    '    install permissions:',
    '      android.permission.INTERNET: granted=true'
  ].join('\n');
  assert.deepEqual(parseWearRequestedPermissions(reviewed), [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.WAKE_LOCK',
    'net.darkmachines.healthtracker.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
  ]);
  assert.deepEqual(assertWearRequestedPermissions(reviewed), parseWearRequestedPermissions(reviewed));
  assert.throws(
    () => assertWearRequestedPermissions(reviewed.replace(
      '      android.permission.POST_NOTIFICATIONS',
      '      android.permission.POST_NOTIFICATIONS\n      android.permission.BLUETOOTH_SCAN'
    )),
    /differ from the reviewed allowlist/
  );
  assert.throws(() => parseWearRequestedPermissions('Package without section'), /section is missing/);

  const nativeCrash = 'Fatal signal 11\npid: 42 >>> net.darkmachines.healthtracker <<<';
  const javaCrash = 'FATAL EXCEPTION: main\nProcess: net.darkmachines.healthtracker, PID: 42';
  const unrelatedCrash = 'FATAL EXCEPTION: main\nProcess: com.android.systemui, PID: 50';
  assert.equal(crashBufferContainsWearProcess(nativeCrash), true);
  assert.equal(crashBufferContainsWearProcess(javaCrash), true);
  assert.equal(crashBufferContainsWearProcess(unrelatedCrash), false);
});
