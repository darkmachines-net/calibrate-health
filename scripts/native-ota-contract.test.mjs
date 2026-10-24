/** @file Regression coverage for native ota contract: native runtime fingerprint ignores server, JS source, and JS-only dependency changes. */

/** Regression coverage for native ota contract and its failure boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAndroidNativeLockSnapshot,
  createNativeRuntimeFingerprint,
  discoverAndroidNativePackageNames,
  resolveExpoUpdateBuildConfig,
  writeNativeOtaBaseline
} from './native-ota-contract.mjs';

/** Create isolated native-input fixtures so tests cannot mutate repository versions. */
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-ota-contract-'));
  for (const file of [
    'package.json',
    'mobile/app.json',
    'mobile/app.config.js',
    'mobile/eas.json',
    'mobile/package.json',
    'mobile/assets/adaptive-icon.png',
    'mobile/assets/icon.png',
    'mobile/assets/notification-icon.png',
    'shared/release.json',
    'mobile/modules/example/android/build.gradle',
    'mobile/plugins/example.js',
    'wear/app/build.gradle.kts'
  ]) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    let contents = file;
    if (file === 'mobile/app.json') {
      contents = JSON.stringify({
        expo: {
          version: '0.1.0',
          android: {
            permissions: ['CAMERA']
          }
        }
      });
    } else if (file === 'shared/release.json') {
      contents = JSON.stringify({
        server: { version: '1.0.0' },
        android: {
          mobile: {
            version_name: '0.1.0',
            version_code: 1,
            minimum_supported_version: '0.1.0'
          }
        }
      });
    } else if (file === 'package.json') {
      contents = JSON.stringify({ name: 'cal-io', version: '1.0.0' });
    } else if (file === 'mobile/package.json') {
      contents = JSON.stringify({
        dependencies: {
          expo: '~57.0.7',
          '@expo/dom-webview': '57.0.1',
          'expo-camera': '~57.0.3',
          'react-native': '0.86.0',
          'js-library': '1.0.0'
        }
      });
    }
    fs.writeFileSync(absolute, contents);
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    packages: {
      '': { name: 'cal-io', version: '1.0.0' },
      mobile: {
        name: 'mobile',
        version: '0.1.0',
        dependencies: {
          expo: '~57.0.7',
          'expo-camera': '~57.0.3',
          'react-native': '0.86.0',
          'js-library': '1.0.0'
        }
      },
      'node_modules/expo': {
        version: '57.0.7',
        dependencies: {
          '@expo/config': '1.0.0',
          '@expo/dom-webview': '57.0.1'
        }
      },
      'node_modules/@expo/config': { version: '1.0.0' },
      'node_modules/@expo/dom-webview': { version: '57.0.1' },
      'node_modules/expo-camera': { version: '57.0.3' },
      'node_modules/react-native': { version: '0.86.0' },
      'node_modules/js-library': { version: '1.0.0', dependencies: { 'brace-expansion': '5.0.7' } },
      'node_modules/brace-expansion': { version: '5.0.7' },
      backend: { dependencies: { express: '5.0.0' } },
      'node_modules/express': { version: '5.0.0' }
    }
  }));
  for (const file of [
    'node_modules/expo/android/build.gradle',
    'node_modules/@expo/dom-webview/expo-module.config.json',
    'node_modules/expo-camera/expo-module.config.json',
    'node_modules/react-native/android/build.gradle'
  ]) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const contents = file.endsWith('expo-module.config.json')
      ? JSON.stringify({ platforms: ['android'], android: { modules: ['ExampleModule'] } })
      : file;
    fs.writeFileSync(absolute, contents);
  }
  return root;
}

test('native runtime fingerprint ignores server, JS source, and JS-only dependency changes', () => {
  const root = createFixture();
  try {
    const initial = createNativeRuntimeFingerprint(root);
    fs.mkdirSync(path.join(root, 'mobile', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'mobile', 'src', 'screen.tsx'), 'safe JS change');
    assert.equal(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    const releasePath = path.join(root, 'shared', 'release.json');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    release.server.version = '1.0.1';
    release.android.mobile.minimum_supported_version = '0.1.1';
    fs.writeFileSync(releasePath, JSON.stringify(release));
    assert.equal(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    const rootPackagePath = path.join(root, 'package.json');
    fs.writeFileSync(rootPackagePath, JSON.stringify({ name: 'cal-io', version: '1.0.1' }));
    assert.equal(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    const mobilePackagePath = path.join(root, 'mobile', 'package.json');
    const mobilePackage = JSON.parse(fs.readFileSync(mobilePackagePath, 'utf8'));
    mobilePackage.dependencies['js-library'] = '1.1.0';
    fs.writeFileSync(mobilePackagePath, JSON.stringify(mobilePackage));
    assert.equal(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    const lockPath = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages[''].version = '1.0.1';
    lock.packages['node_modules/js-library'].version = '1.1.0';
    lock.packages['node_modules/brace-expansion'].version = '5.0.8';
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    assert.equal(createNativeRuntimeFingerprint(root).sha256, initial.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native runtime fingerprint changes for native packages, config, plugins, and assets', () => {
  const root = createFixture();
  try {
    const initial = createNativeRuntimeFingerprint(root);
    const lockPath = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/expo-camera'].version = '57.0.4';
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    lock.packages['node_modules/expo-camera'].version = '57.0.3';
    lock.packages['node_modules/@expo/dom-webview'].version = '57.0.2';
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    lock.packages['node_modules/@expo/dom-webview'].version = '57.0.1';
    fs.writeFileSync(lockPath, JSON.stringify({
      ...lock,
      packages: {
        ...lock.packages,
        'node_modules/expo-camera': { version: '57.0.3' },
        'node_modules/react-native': { version: '0.87.0' }
      }
    }));
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    fs.writeFileSync(lockPath, JSON.stringify({
      ...lock,
      packages: {
        ...lock.packages,
        'node_modules/expo-camera': { version: '57.0.3' },
        'node_modules/react-native': { version: '0.86.0' }
      }
    }));
    const appConfigPath = path.join(root, 'mobile', 'app.json');
    const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'));
    appConfig.expo.android.permissions.push('POST_NOTIFICATIONS');
    fs.writeFileSync(appConfigPath, JSON.stringify(appConfig));
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    fs.writeFileSync(appConfigPath, JSON.stringify({
      expo: {
        version: '0.1.0',
        android: {
          permissions: ['CAMERA']
        }
      }
    }));
    fs.writeFileSync(path.join(root, 'mobile', 'plugins', 'example.js'), 'native config change');
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    fs.writeFileSync(path.join(root, 'mobile', 'plugins', 'example.js'), 'mobile/plugins/example.js');
    fs.writeFileSync(path.join(root, 'mobile', 'assets', 'icon.png'), 'changed native icon');
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    fs.writeFileSync(path.join(root, 'mobile', 'assets', 'icon.png'), 'mobile/assets/icon.png');
    fs.writeFileSync(
      path.join(root, 'mobile', 'modules', 'example', 'android', 'build.gradle'),
      'changed local native module'
    );
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);

    fs.writeFileSync(
      path.join(root, 'mobile', 'modules', 'example', 'android', 'build.gradle'),
      'mobile/modules/example/android/build.gradle'
    );
    fs.writeFileSync(path.join(root, 'wear', 'app', 'build.gradle.kts'), 'changed Wear build');
    assert.notEqual(createNativeRuntimeFingerprint(root).sha256, initial.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Android native lock snapshot excludes backend and JS-only packages', () => {
  const base = {
    packages: {
      mobile: {
        dependencies: {
          expo: '57.0.7',
          '@expo/dom-webview': '57.0.1',
          'expo-camera': '57.0.3',
          'js-library': '1.0.0'
        }
      },
      'node_modules/expo': { version: '57.0.7' },
      'node_modules/@expo/dom-webview': { version: '57.0.1' },
      'node_modules/expo-camera': { version: '57.0.3' },
      'node_modules/js-library': { version: '1.0.0', dependencies: { 'brace-expansion': '5.0.7' } },
      'node_modules/brace-expansion': { version: '5.0.7' },
      backend: { dependencies: { express: '5.0.0' } },
      'node_modules/express': { version: '5.0.0' }
    }
  };
  const nativePackageNames = new Set(['@expo/dom-webview', 'expo', 'expo-camera']);
  const changedBackend = structuredClone(base);
  changedBackend.packages['node_modules/express'].version = '5.1.0';
  const changedJs = structuredClone(base);
  changedJs.packages['node_modules/brace-expansion'].version = '5.0.8';
  assert.deepEqual(
    createAndroidNativeLockSnapshot(base, nativePackageNames),
    createAndroidNativeLockSnapshot(changedBackend, nativePackageNames)
  );
  assert.deepEqual(
    createAndroidNativeLockSnapshot(base, nativePackageNames),
    createAndroidNativeLockSnapshot(changedJs, nativePackageNames)
  );

  const changedNative = structuredClone(base);
  changedNative.packages['node_modules/expo-camera'].version = '57.0.4';
  assert.notDeepEqual(
    createAndroidNativeLockSnapshot(base, nativePackageNames),
    createAndroidNativeLockSnapshot(changedNative, nativePackageNames)
  );
});

test('Android native package discovery uses installed module metadata', () => {
  const root = createFixture();
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const nativePackageNames = discoverAndroidNativePackageNames(root, lock);
    assert.equal(nativePackageNames.has('@expo/dom-webview'), true);
    assert.equal(nativePackageNames.has('expo-camera'), true);
    assert.equal(nativePackageNames.has('react-native'), true);
    assert.equal(nativePackageNames.has('js-library'), false);
    assert.equal(nativePackageNames.has('brace-expansion'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OTA build config validates project UUID and update channel', () => {
  assert.deepEqual(resolveExpoUpdateBuildConfig({}), { projectId: null, channel: 'internal' });
  assert.deepEqual(resolveExpoUpdateBuildConfig({
    EXPO_PUBLIC_EAS_PROJECT_ID: '01234567-89ab-4def-8123-456789abcdef',
    EXPO_UPDATES_CHANNEL: 'production'
  }), {
    projectId: '01234567-89ab-4def-8123-456789abcdef',
    channel: 'production'
  });
  assert.throws(() => resolveExpoUpdateBuildConfig({ EXPO_PUBLIC_EAS_PROJECT_ID: 'bad' }), /project UUID/);
  assert.throws(() => resolveExpoUpdateBuildConfig({ EXPO_UPDATES_CHANNEL: 'bad channel' }), /EXPO_UPDATES_CHANNEL/);
});

test('OTA baseline records the exact native runtime contract without secrets', () => {
  const root = createFixture();
  try {
    const result = writeNativeOtaBaseline({
      resolveRuntime: () => "a".repeat(40),
      root,
      environment: {
        EXPO_PUBLIC_EAS_PROJECT_ID: '01234567-89ab-4def-8123-456789abcdef',
        EXPO_UPDATES_CHANNEL: 'internal',
        EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'https://health.example',
        CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: 'secret'
      },
      commit: 'abc123',
      createdAt: '2026-07-19T00:00:00.000Z'
    });
    assert.equal(result.baseline.runtime_version, 'a'.repeat(40));
    assert.equal(result.baseline.channel, 'internal');
    assert.equal(result.baseline.server_url, 'https://health.example');
    assert.equal(result.baseline.commit, 'abc123');
    assert.doesNotMatch(fs.readFileSync(result.output, 'utf8'), /secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
