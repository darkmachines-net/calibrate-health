/** @file Check native provider configuration, release destinations, store/development identities and invalid Expo inputs. */

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
const originalVariant = process.env.EXPO_RELEASE_VARIANT;
const originalGoogleIosId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const originalGoogleDevIosId = process.env.EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID;

test.afterEach(() => {
  if (originalGoogleDevIosId === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID;
  else process.env.EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID = originalGoogleDevIosId;
  if (originalGoogleIosId === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  else process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = originalGoogleIosId;
  if (originalProjectId === undefined) delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  else process.env.EXPO_PUBLIC_EAS_PROJECT_ID = originalProjectId;
  if (originalChannel === undefined) delete process.env.EXPO_UPDATES_CHANNEL;
  else process.env.EXPO_UPDATES_CHANNEL = originalChannel;
  if (originalVariant === undefined) delete process.env.EXPO_RELEASE_VARIANT;
  else process.env.EXPO_RELEASE_VARIANT = originalVariant;
});

test('Google iOS selects separate development and store clients within the shared preview environment', () => {
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = '123-store.apps.googleusercontent.com';
  process.env.EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID = '123-dev.apps.googleusercontent.com';
  process.env.EXPO_RELEASE_VARIANT = 'development';
  const dev = createExpoConfig({ config: appConfig.expo });
  assert.equal(dev.extra.googleIosClientId, '123-dev.apps.googleusercontent.com');
  assert.deepEqual(dev.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === '@react-native-google-signin/google-signin'), [
    '@react-native-google-signin/google-signin', { iosUrlScheme: 'com.googleusercontent.apps.123-dev' }
  ]);
  delete process.env.EXPO_RELEASE_VARIANT;
  assert.equal(createExpoConfig({ config: appConfig.expo }).extra.googleIosClientId, '123-store.apps.googleusercontent.com');
});

test('native provider config enables Apple and uses the matching reversed Google iOS scheme', () => {
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = '123-native.apps.googleusercontent.com';
  const result = createExpoConfig({ config: appConfig.expo });
  assert.equal(result.ios.usesAppleSignIn, true);
  assert.ok(result.plugins.includes('expo-apple-authentication'));
  assert.deepEqual(result.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === '@react-native-google-signin/google-signin'), [
    '@react-native-google-signin/google-signin', { iosUrlScheme: 'com.googleusercontent.apps.123-native' }
  ]);
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = 'https://invalid.example';
  assert.throws(() => createExpoConfig({ config: appConfig.expo }), /iOS OAuth client ID/);
});

test('static Expo config supports iPhone, iPad, and iOS Simulator builds', () => {
  assert.deepEqual(appConfig.expo.ios, {
    bundleIdentifier: 'app.calibratehealth.mobile',
    buildNumber: String(releaseConfig.android.mobile.version_code),
    config: { usesNonExemptEncryption: false },
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

test('beta native profiles use store signing for TestFlight and Android testing against the GCP server', () => {
  const beta = easConfig.build.beta;
  assert.equal(beta.distribution, 'store', 'TestFlight requires store signing, not ad hoc distribution');
  assert.equal(beta.android.buildType, 'app-bundle');
  assert.equal(beta.environment, 'preview');
  assert.equal(beta.channel, 'beta');
  assert.equal(beta.autoIncrement, false);
  assert.equal(easConfig.build.production.autoIncrement, false);
  assert.equal(beta.env.EXPO_UPDATES_CHANNEL, 'beta');
  assert.equal(beta.env.EXPO_PUBLIC_CALIBRATE_SERVER_URL, 'https://calibratehealth.app');
  assert.equal(easConfig.submit['phone-beta'].android.track, 'internal');
  assert.equal(easConfig.submit['wear-beta'].android.track, 'wear:internal');
  assert.equal(easConfig.submit['ios-beta'].ios.bundleIdentifier, appConfig.expo.ios.bundleIdentifier);
  assert.equal(easConfig.submit['ios-beta'].ios.ascAppId, '6826924944');
  assert.equal(easConfig.build.production.env.EXPO_UPDATES_CHANNEL, 'production');
  assert.equal(easConfig.build.production.env.EXPO_PUBLIC_CALIBRATE_SERVER_URL, 'https://calibratehealth.app');
});

test('Expo config leaves updates disabled when no EAS project is configured', () => {
  delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const config = { name: 'calibrate', extra: { router: { origin: false } } };
  const result = createExpoConfig({ config });
  assert.equal(result.updates, undefined);
  assert.equal(result.name, config.name);
  assert.deepEqual(result.extra, config.extra);
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
  process.env.EXPO_UPDATES_CHANNEL = 'beta channel';
  assert.throws(() => createExpoConfig({ config: {} }), /EXPO_UPDATES_CHANNEL/);
});

test('development clients isolate native identity, links and update runtime from store builds', () => {
  process.env.EXPO_RELEASE_VARIANT = 'development';
  process.env.EXPO_UPDATES_CHANNEL = 'beta';
  const result = createExpoConfig({ config: appConfig.expo });
  assert.equal(result.name, 'Calibrate Dev');
  assert.equal(result.scheme, 'calibrate-health-app-dev');
  assert.equal(result.android.package, 'net.darkmachines.healthtracker.development');
  assert.equal(result.ios.bundleIdentifier, 'app.calibratehealth.mobile.development');
  assert.deepEqual(result.android.intentFilters, []);
  assert.deepEqual(result.ios.associatedDomains, []);
  assert.deepEqual(result.runtimeVersion, { policy: 'fingerprint' });
  assert.equal(result.updates.requestHeaders['expo-channel-name'], undefined);
  assert.deepEqual(result.plugins.at(-1), ['expo-dev-client', { launchMode: 'launcher' }]);
  assert.equal(appConfig.expo.android.package, 'net.darkmachines.healthtracker');
  assert.ok(appConfig.expo.android.intentFilters.length);
});

test('beta and production retain store identity and use their declared update channels', () => {
  delete process.env.EXPO_RELEASE_VARIANT;
  for (const channel of ['beta', 'production']) {
    process.env.EXPO_UPDATES_CHANNEL = channel;
    const result = createExpoConfig({ config: appConfig.expo });
    assert.equal(result.android.package, appConfig.expo.android.package);
    assert.equal(result.ios.bundleIdentifier, appConfig.expo.ios.bundleIdentifier);
    assert.equal(result.updates.requestHeaders['expo-channel-name'], channel);
    assert.equal(result.runtimeVersion, require('./release-version.json').version.split('.')[0]);
  }
});
