/** @file Regression coverage for native release devices: release device CLI supports repeat installs and explicit non-interactive targets. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NATIVE_RELEASE_ARTIFACT_CONTRACTS } from './native-release-evidence.mjs';
import {
  assertNativeReleaseArtifactVersions,
  assertNativeReleaseEvidenceMode,
  assertNativeReleaseEvidenceTargets,
  assertNativeReleaseEvidenceUpgradePlans,
  classifyReleaseDevice,
  createNativeReleaseDeviceRunner,
  createNativeReleaseUpgradeEvidence,
  deduplicateReleaseDevices,
  displayNativeReleaseTarget,
  inspectNativeReleaseArtifactSet,
  nativeReleaseToolEnvironment,
  parseAabManifestMetadata,
  parseAdbDeviceRows,
  parseApkBadging,
  parseInstalledPackageState,
  parseNativeReleaseDeviceArgs,
  parseSignerFingerprint,
  readNativeReleaseArtifactVersions,
  releaseDeviceCandidates,
  retainedNativeReleaseDevices,
  resolveNativeReleaseDeviceTooling
} from './native-release-devices.mjs';

function withTempReleaseManifest(manifest, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-device-test-'));
  try {
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared', 'release.json'), JSON.stringify(manifest));
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('release device CLI supports repeat installs and explicit non-interactive targets', () => {
  assert.deepEqual(parseNativeReleaseDeviceArgs([
    '--skip-build',
    '--phone-serial', 'phone-1',
    '--watch-serial', 'watch-1',
    '--server-url', 'https://health.example',
    '--keystore', 'signing/calibrate.p12',
    '--key-alias', 'calibrate',
    '--eas-project-id', '01234567-89ab-4def-8123-456789abcdef',
    '--updates-channel', 'internal',
    '--replace-incompatible',
    '--no-launch'
  ]), {
    skipBuild: true,
    phoneSerial: 'phone-1',
    watchSerial: 'watch-1',
    serverUrl: 'https://health.example',
    keystore: 'signing/calibrate.p12',
    keyAlias: 'calibrate',
    easProjectId: '01234567-89ab-4def-8123-456789abcdef',
    updatesChannel: 'internal',
    candidateCommit: null,
    evidenceObservation: null,
    replaceIncompatible: true,
    launch: false,
    help: false
  });
  assert.throws(() => parseNativeReleaseDeviceArgs(['--unknown']), /Unknown native release device option/);
});

test('ADB parsing preserves Windows mDNS serials containing a duplicate suffix', () => {
  const rows = parseAdbDeviceRows(`List of devices attached
R5Cphone device product:phone model:Galaxy transport_id:1
adb-watch (2)._adb-tls-connect._tcp device product:watch model:Ultra transport_id:2
offline-one offline transport_id:3
`);
  assert.deepEqual(rows.map(({ serial, state }) => ({ serial, state })), [
    { serial: 'R5Cphone', state: 'device' },
    { serial: 'adb-watch (2)._adb-tls-connect._tcp', state: 'device' },
    { serial: 'offline-one', state: 'offline' }
  ]);
});

test('duplicate watch routes collapse to the stable mDNS serial', () => {
  const base = {
    hardwareSerial: 'RFAXB16LVCJ',
    model: 'SM-L705U',
    characteristics: 'watch',
    role: 'watch',
    isEmulator: false
  };
  const devices = deduplicateReleaseDevices([
    { ...base, serial: 'adb-watch (2)._adb-tls-connect._tcp' },
    { ...base, serial: 'adb-watch._adb-tls-connect._tcp' }
  ]);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, 'adb-watch._adb-tls-connect._tcp');
  assert.equal(classifyReleaseDevice('nosdcard,watch'), 'watch');
  assert.equal(classifyReleaseDevice('phone,nosdcard'), 'phone');
  assert.equal(classifyReleaseDevice('default'), 'phone');
  assert.equal(classifyReleaseDevice('tablet'), 'phone');
  assert.equal(classifyReleaseDevice('phone,tablet'), 'phone');
  for (const characteristics of ['tv', 'automotive', 'embedded', 'nosdcard']) {
    assert.equal(classifyReleaseDevice(characteristics), 'unsupported');
  }
});

test('physical devices are preferred over emulators for release installation', () => {
  const candidates = releaseDeviceCandidates('phone', [
    { role: 'phone', serial: 'emulator-5554', isEmulator: true },
    { role: 'watch', serial: 'watch-1', isEmulator: false },
    { role: 'phone', serial: 'R5Cphone', isEmulator: false }
  ]);
  assert.deepEqual(candidates.map(({ serial }) => serial), ['R5Cphone']);
});

test('Android tablets are valid mobile release installation targets', () => {
  const candidates = releaseDeviceCandidates('phone', [
    { role: classifyReleaseDevice('tablet'), serial: 'tablet-1', isEmulator: false },
    { role: 'watch', serial: 'watch-1', isEmulator: false }
  ]);
  assert.deepEqual(candidates.map(({ serial }) => serial), ['tablet-1']);
});

test('APK parsers retain release identity and normalize certificate fingerprints', () => {
  assert.deepEqual(
    parseApkBadging("package: name='net.darkmachines.healthtracker' versionCode='2' versionName='0.2.0' platformBuildVersionName='16'"),
    { applicationId: 'net.darkmachines.healthtracker', versionCode: 2, versionName: '0.2.0' }
  );
  const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':');
  assert.equal(
    parseSignerFingerprint(`V2 Signer: certificate SHA-256 digest: ${fingerprint}`),
    fingerprint.replaceAll(':', '')
  );
});

test('release artifact versions are read from the canonical manifest', () => {
  withTempReleaseManifest({
    android: {
      mobile: { version_name: '0.3.0', version_code: 3 },
      wear: { version_name: '0.4.0', version_code: 4 }
    }
  }, (root) => {
    assert.deepEqual(readNativeReleaseArtifactVersions(root), {
      phone: { versionName: '0.3.0', versionCode: 3 },
      watch: { versionName: '0.4.0', versionCode: 4 }
    });
  });
});

test('stale phone and Wear APK versions are rejected before installation', () => {
  const expected = {
    phone: { versionName: '0.2.0', versionCode: 2 },
    watch: { versionName: '0.2.0', versionCode: 2 }
  };
  const current = {
    phone: { versionName: '0.2.0', versionCode: 2 },
    watch: { versionName: '0.2.0', versionCode: 2 }
  };

  assert.doesNotThrow(() => assertNativeReleaseArtifactVersions(current, expected));
  assert.throws(
    () => assertNativeReleaseArtifactVersions({
      ...current,
      phone: { versionName: '0.1.0', versionCode: 2 }
    }, expected),
    /phone release APK is stale: found 0\.1\.0 \(2\), expected 0\.2\.0 \(2\).*without --skip-build/
  );
  assert.throws(
    () => assertNativeReleaseArtifactVersions({
      ...current,
      watch: { versionName: '0.2.0', versionCode: 1 }
    }, expected),
    /watch release APK is stale: found 0\.2\.0 \(1\), expected 0\.2\.0 \(2\).*without --skip-build/
  );
});

test('tool resolution uses standard Windows Android Studio paths and newest build tools', () => {
  const root = path.join('C:', 'Android');
  const result = resolveNativeReleaseDeviceTooling({
    ANDROID_HOME: root,
    JAVA_HOME: path.join('C:', 'Java'),
    BUNDLETOOL_JAR: path.join('C:', 'Tools', 'bundletool-all.jar')
  }, {
    platform: 'win32',
    buildToolVersions: ['36.0.0', '37.0.0'],
    fileExists: () => true
  });
  assert.equal(result.sdkRoot, root);
  assert.match(result.apksignerJar, /37\.0\.0/);
  assert.match(result.bundletoolJar, /bundletool-all\.jar$/);
  assert.deepEqual(nativeReleaseToolEnvironment({}, result), {
    JAVA_HOME: result.javaHome,
    ANDROID_HOME: result.sdkRoot,
    ANDROID_SDK_ROOT: result.sdkRoot
  });
});

test('tool resolution honors the exact configured Android build-tools version', () => {
  const root = path.join('C:', 'Android');
  const result = resolveNativeReleaseDeviceTooling({
    ANDROID_HOME: root,
    ANDROID_BUILD_TOOLS_VERSION: '36.0.0',
    JAVA_HOME: path.join('C:', 'Java')
  }, {
    platform: 'win32',
    buildToolVersions: ['36.0.0', '37.0.0-rc1'],
    fileExists: () => true
  });

  assert.match(result.aapt, /36\.0\.0/);
  assert.match(result.apksignerJar, /36\.0\.0/);
  assert.doesNotMatch(result.aapt, /37\.0\.0-rc1/);
});

test('tool resolution rejects a missing exact Android build-tools version', () => {
  const root = path.join('C:', 'Android');
  const requestedDirectory = path.join(root, 'build-tools', '36.0.0');

  assert.throws(() => resolveNativeReleaseDeviceTooling({
    ANDROID_HOME: root,
    ANDROID_BUILD_TOOLS_VERSION: '36.0.0',
    JAVA_HOME: path.join('C:', 'Java')
  }, {
    platform: 'win32',
    buildToolVersions: ['37.0.0-rc1'],
    fileExists: (candidate) => candidate !== requestedDirectory
  }), /Configured Android build-tools 36\.0\.0 are missing/);
});


test('evidence CLI requires explicit candidate and observation inputs', () => {
  const candidateCommit = 'a'.repeat(40);
  const config = parseNativeReleaseDeviceArgs([
    '--skip-build',
    '--phone-serial', 'phone-private-runtime-only',
    '--watch-serial', 'watch-private-runtime-only',
    '--candidate', candidateCommit,
    '--evidence-observation', 'tmp/native-observation.json'
  ]);
  assert.equal(config.candidateCommit, candidateCommit);
  assert.equal(config.evidenceObservation, 'tmp/native-observation.json');
  assert.equal(assertNativeReleaseEvidenceMode(config, {
    headCommit: candidateCommit,
    worktreeStatus: ''
  }), true);
  assert.throws(
    () => assertNativeReleaseEvidenceMode({ ...config, skipBuild: false }, {
      headCommit: candidateCommit,
      worktreeStatus: ''
    }),
    /requires --skip-build/
  );
  assert.throws(
    () => assertNativeReleaseEvidenceMode(config, {
      headCommit: 'b'.repeat(40),
      worktreeStatus: ' M shared/release.json'
    }),
    /checked-out HEAD/
  );
});

test('strict evidence targets are physical Samsung devices and retained metadata omits serials', () => {
  const targets = {
    phone: {
      role: 'phone',
      serial: 'phone-private-runtime-only',
      hardwareSerial: 'hardware-private-runtime-only',
      manufacturer: 'Samsung',
      model: 'Galaxy fixture',
      characteristics: 'phone,nosdcard',
      osVersion: '16',
      apiLevel: 36,
      isEmulator: false
    },
    watch: {
      role: 'watch',
      serial: 'watch-private-runtime-only',
      hardwareSerial: 'watch-hardware-private-runtime-only',
      manufacturer: 'Samsung Electronics',
      model: 'Galaxy Watch Ultra fixture',
      characteristics: 'watch,nosdcard',
      osVersion: '6',
      apiLevel: 35,
      isEmulator: false
    }
  };
  assert.doesNotThrow(() => assertNativeReleaseEvidenceTargets(targets));
  const retained = retainedNativeReleaseDevices(targets);
  assert.equal(JSON.stringify(retained).includes('private-runtime-only'), false);
  const display = displayNativeReleaseTarget(targets.phone, true);
  assert.equal(display, 'Galaxy fixture (physical phone)');
  assert.equal(display.includes('private-runtime-only'), false);
  assert.deepEqual(Object.keys(retained[0]).sort(), [
    'apiLevel', 'deviceClass', 'isEmulator', 'isPhysical', 'manufacturer', 'model', 'osVersion', 'role'
  ]);
  assert.equal(retained[0].deviceClass, 'handset');
  assert.equal(retained[1].deviceClass, 'watch');
  assert.throws(
    () => assertNativeReleaseEvidenceTargets({
      ...targets,
      watch: { ...targets.watch, isEmulator: true }
    }),
    /physical non-emulator watch/
  );
  assert.throws(
    () => assertNativeReleaseEvidenceTargets({
      ...targets,
      phone: { ...targets.phone, manufacturer: 'Google' }
    }),
    /Samsung phone/
  );
  for (const characteristics of ['tablet', 'tv', 'automotive', 'embedded', 'phone,tablet']) {
    assert.throws(
      () => assertNativeReleaseEvidenceTargets({
        ...targets,
        phone: { ...targets.phone, characteristics }
      }),
      /handset-compatible phone/
    );
  }
});

test('strict upgrade plans require same-signer lower versions and preserve firstInstallTime', () => {
  const signerSha256 = 'c'.repeat(64);
  const plan = (role, versionCode, installedVersionCode) => ({
    target: { role },
    artifact: {
      versionName: '2.0.0',
      versionCode,
      signerSha256
    },
    state: 'upgrade',
    installedVersionName: '1.0.0',
    installedVersionCode,
    installedFirstInstallTime: '2026-07-01 10:00:00',
    installedSignerSha256: signerSha256
  });
  const prePlans = [plan('phone', 7, 6), plan('watch', 9, 8)];
  assert.doesNotThrow(() => assertNativeReleaseEvidenceUpgradePlans(prePlans));
  assert.throws(
    () => assertNativeReleaseEvidenceUpgradePlans([
      { ...prePlans[0], installedVersionCode: 7 },
      prePlans[1]
    ]),
    /strictly lower phone pre-version/
  );

  const postPlans = prePlans.map((pre) => ({
    ...pre,
    installedVersionName: pre.artifact.versionName,
    installedVersionCode: pre.artifact.versionCode
  }));
  const upgrades = createNativeReleaseUpgradeEvidence(prePlans, postPlans);
  assert.equal(upgrades.phone.installMode, 'adb-install-r');
  assert.equal(upgrades.phone.pre.firstInstallTime, upgrades.phone.post.firstInstallTime);
  assert.throws(
    () => createNativeReleaseUpgradeEvidence(prePlans, [
      { ...postPlans[0], installedFirstInstallTime: '2026-08-01 10:00:00' },
      postPlans[1]
    ]),
    /firstInstallTime changed/
  );
});

test('package dump parser retains version and firstInstallTime for upgrade continuity', () => {
  assert.deepEqual(parseInstalledPackageState(`
    versionCode=7 minSdk=26 targetSdk=36
    versionName=0.2.5
    firstInstallTime=2026-07-01 10:00:00
  `), {
    versionCode: 7,
    versionName: '0.2.5',
    firstInstallTime: '2026-07-01 10:00:00'
  });
});

test('artifact capture independently inspects two APK and two AAB signers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    android: {
      application_id: 'net.darkmachines.healthtracker',
      mobile: { version_name: '0.2.5', version_code: 7 },
      wear: { version_name: '0.3.0', version_code: 8 }
    }
  };
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared', 'release.json'), JSON.stringify(manifest));
  for (const contract of NATIVE_RELEASE_ARTIFACT_CONTRACTS) {
    const file = path.join(root, contract.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture-${contract.id}`);
  }

  const signer = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':');
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.command === 'aapt') {
      const watch = request.args.at(-1).includes(`${path.sep}wear${path.sep}`);
      return {
        status: 0,
        stderr: '',
        stdout: `package: name='net.darkmachines.healthtracker' versionCode='${watch ? 8 : 7}' versionName='${watch ? '0.3.0' : '0.2.5'}'`
      };
    }
    if (request.command === 'keytool') {
      return { status: 0, stderr: '', stdout: `Owner: CN=fixture\nSHA256: ${signer}` };
    }
    if (request.args?.includes('bundletool.jar')) {
      const watch = request.args.at(-1).includes(`${path.sep}wear${path.sep}`);
      return {
        status: 0,
        stderr: '',
        stdout: `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="net.darkmachines.healthtracker" android:versionCode="${watch ? 8 : 7}" android:versionName="${watch ? '0.3.0' : '0.2.5'}"></manifest>`
      };
    }
    return {
      status: 0,
      stderr: '',
      stdout: `Signer #1 certificate SHA-256 digest: ${signer}`
    };
  };
  const captured = await inspectNativeReleaseArtifactSet(root, {
    aapt: 'aapt',
    java: 'java',
    apksignerJar: 'apksigner.jar',
    keytool: 'keytool',
    bundletoolJar: 'bundletool.jar'
  }, runner);

  assert.equal(captured.artifacts.length, 4);
  assert.equal(calls.filter(({ command }) => command === 'keytool').length, 2);
  assert.equal(calls.filter(({ args }) => args?.includes('apksigner.jar')).length, 2);
  assert.equal(calls.filter(({ args }) => args?.includes('bundletool.jar')).length, 2);
  assert.equal(new Set(captured.artifacts.map(({ signerSha256 }) => signerSha256)).size, 1);
  assert.ok(captured.artifacts.every(({ path: artifactPath }) => !path.isAbsolute(artifactPath)));
});


test('artifact parsers reject stale AAB metadata and multiple signer identities', async (t) => {
  assert.deepEqual(parseAabManifestMetadata(
    '<manifest package="net.darkmachines.healthtracker" android:versionName="1.2.3" android:versionCode="12"></manifest>'
  ), {
    applicationId: 'net.darkmachines.healthtracker',
    versionName: '1.2.3',
    versionCode: 12
  });
  const first = '11'.repeat(32).match(/.{2}/g).join(':');
  const second = '22'.repeat(32).match(/.{2}/g).join(':');
  assert.throws(
    () => parseSignerFingerprint(
      `Signer #1 certificate SHA-256 digest: ${first}\nSigner #2 certificate SHA-256 digest: ${second}`
    ),
    /exactly one unique signing certificate/
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-stale-aab-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    android: {
      application_id: 'net.darkmachines.healthtracker',
      mobile: { version_name: '0.2.5', version_code: 7 },
      wear: { version_name: '0.3.0', version_code: 8 }
    }
  };
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared', 'release.json'), JSON.stringify(manifest));
  for (const contract of NATIVE_RELEASE_ARTIFACT_CONTRACTS) {
    const file = path.join(root, contract.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture-${contract.id}`);
  }
  const runner = async (request) => {
    const artifact = request.args?.at(-1) ?? '';
    const watch = artifact.includes(`${path.sep}wear${path.sep}`);
    if (request.command === 'aapt') {
      return {
        status: 0,
        stderr: '',
        stdout: `package: name='net.darkmachines.healthtracker' versionCode='${watch ? 8 : 7}' versionName='${watch ? '0.3.0' : '0.2.5'}'`
      };
    }
    if (request.command === 'keytool') {
      return { status: 0, stderr: '', stdout: `SHA256: ${first}` };
    }
    if (request.args?.includes('bundletool.jar')) {
      return {
        status: 0,
        stderr: '',
        stdout: `<manifest package="net.darkmachines.healthtracker" android:versionCode="${watch ? 99 : 7}" android:versionName="${watch ? 'stale' : '0.2.5'}"></manifest>`
      };
    }
    return { status: 0, stderr: '', stdout: `certificate SHA-256 digest: ${first}` };
  };
  await assert.rejects(
    inspectNativeReleaseArtifactSet(root, {
      aapt: 'aapt',
      java: 'java',
      apksignerJar: 'apksigner.jar',
      keytool: 'keytool',
      bundletoolJar: 'bundletool.jar'
    }, runner),
    /watch-aab version does not match shared\/release\.json/
  );
});

test('device runner redacts ADB serial and bundletool path sentinels from command failure detail', async () => {
  const serial = 'SERIAL-SENTINEL-DO-NOT-LOG';
  const bundletoolJar = 'C:\\Users\\fixture-user\\Tools\\BUNDLETOOL-PATH-SENTINEL.jar';
  const runner = createNativeReleaseDeviceRunner({
    output: { write() {} },
    spawnSync: (_command, args) => ({
      status: 1,
      stdout: '',
      stderr: args.includes(bundletoolJar)
        ? `java failed while opening ${bundletoolJar}`
        : `adb failed while targeting ${serial}`
    })
  });
  await assert.rejects(
    runner({
      command: 'adb',
      args: ['-s', serial, 'shell', 'false'],
      label: 'fixture adb failure',
      redactValues: [serial]
    }),
    (error) => {
      assert.equal(error.message.includes(serial), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
  await assert.rejects(
    runner({
      command: 'java',
      args: ['-jar', bundletoolJar, 'dump', 'manifest'],
      label: 'fixture bundletool failure',
      redactValues: [bundletoolJar]
    }),
    (error) => {
      assert.equal(error.message.includes(bundletoolJar), false);
      assert.equal(error.message.includes('fixture-user'), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});
