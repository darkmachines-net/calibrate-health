/** @file Regression coverage for app config: static Expo config supports iPhone, iPad, and iOS Simulator builds. */

/** Regression coverage for app.config and its failure boundaries. */
const assert = require('node:assert/strict');
const test = require('node:test');

const appConfig = require('./app.json');
const releaseConfig = require('../shared/release.json');
const easConfig = require('./eas.json');
const packageConfig = require('./package.json');
const { createExpoConfig } = require('./app.config.js');

/** Read a configured plugin’s options for native configuration assertions. */
function pluginOptions(name) {
  const entry = appConfig.expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === name
  );
  assert.ok(entry, `Missing Expo plugin: ${name}`);
  return entry[1];
}

const originalProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const originalChannel = process.env.EXPO_UPDATES_CHANNEL;

test.afterEach(() => {
  if (originalProjectId === undefined) delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  else process.env.EXPO_PUBLIC_EAS_PROJECT_ID = originalProjectId;
  if (originalChannel === undefined) delete process.env.EXPO_UPDATES_CHANNEL;
  else process.env.EXPO_UPDATES_CHANNEL = originalChannel;
});

test('static Expo config supports iPhone, iPad, and iOS Simulator builds', () => {
  assert.deepEqual(appConfig.expo.ios, {
    bundleIdentifier: 'app.calibratehealth.mobile',
    buildNumber: String(releaseConfig.android.mobile.version_code),
    supportsTablet: true,
    requireFullScreen: false,
    icon: './assets/icon-ios.png',
    associatedDomains: ['applinks:calibratehealth.app'],
    infoPlist: {
      NSLocalNetworkUsageDescription:
        'Allow calibrate to connect to a self-hosted server on your local network.',
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true
      }
    }
  });
  assert.ok(appConfig.expo.plugins.includes('./plugins/withOptionalCameraHardware'));
  assert.deepEqual(pluginOptions('expo-camera'), {
    cameraPermission: 'Allow calibrate to scan food barcodes and nutrition labels.',
    microphonePermission: false,
    recordAudioAndroid: false
  });
  assert.deepEqual(pluginOptions('expo-image-picker'), {
    photosPermission: 'Allow calibrate to choose profile photos and nutrition labels.',
    cameraPermission: 'Allow calibrate to scan food barcodes and nutrition labels.',
    microphonePermission: false
  });
  assert.deepEqual(easConfig.build['ios-simulator'], {
    extends: 'development',
    ios: { simulator: true }
  });
  assert.equal(packageConfig.scripts['prebuild:ios'], 'expo prebuild --platform ios --no-install');
});

test('Expo config leaves updates disabled when no EAS project is configured', () => {
  delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const config = { name: 'calibrate', extra: { router: { origin: false } } };
  assert.strictEqual(createExpoConfig({ config }), config);
});

test('Expo config embeds a project-scoped update URL, runtime, and local-build channel', () => {
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '01234567-89ab-4def-8123-456789abcdef';
  process.env.EXPO_UPDATES_CHANNEL = 'beta';
  const result = createExpoConfig({
    config: { name: 'calibrate', extra: { router: { origin: false } } }
  });

  assert.equal(result.runtimeVersion, require('./release-version.json').version.split('.')[0]);
  assert.equal(result.updates.url, 'https://u.expo.dev/01234567-89ab-4def-8123-456789abcdef');
  assert.equal(result.updates.requestHeaders['expo-channel-name'], 'beta');
  assert.equal(result.extra.eas.projectId, '01234567-89ab-4def-8123-456789abcdef');
  assert.deepEqual(result.extra.router, { origin: false });
});

test('Expo config accepts the public project link written by eas init', () => {
  delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const result = createExpoConfig({
    config: { extra: { eas: { projectId: '01234567-89ab-4def-8123-456789abcdef' } } }
  });
  assert.equal(result.updates.url, 'https://u.expo.dev/01234567-89ab-4def-8123-456789abcdef');
});

test('Expo config rejects malformed project IDs and channel names', () => {
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'not-a-uuid';
  assert.throws(() => createExpoConfig({ config: {} }), /project UUID/);

  process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '01234567-89ab-4def-8123-456789abcdef';
  process.env.EXPO_UPDATES_CHANNEL = 'internal channel';
  assert.throws(() => createExpoConfig({ config: {} }), /EXPO_UPDATES_CHANNEL/);
});
