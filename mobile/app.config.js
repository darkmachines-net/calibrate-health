/** @file Configure native provider callbacks, release updates and separate development clients without changing store identities. */

/** Resolve the native Expo project, update channel, and automatic runtime compatibility. */
const { runtimeVersion, developmentConfig } = require('@mchartier/expo-release/expo');
const release = require('./release-version.json');
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Add EAS Update configuration only when a project ID is supplied. This keeps
 * normal web development usable. The shared helper owns development identity and runtime isolation.
 */
function createExpoConfig({ config }) {
  // Preview and beta share an EAS environment but have separate iOS bundle identities.
  const iosClientId = (process.env.EXPO_RELEASE_VARIANT === 'development'
    ? process.env.EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID
    : process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID)?.trim();
  if (iosClientId && !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(iosClientId)) {
    throw new Error('The selected Google iOS client must be an iOS OAuth client ID.');
  }
  config = {
    ...config,
    ...(iosClientId ? { extra: { ...config.extra, googleIosClientId: iosClientId } } : {}),
    ios: { ...config.ios, usesAppleSignIn: true },
    plugins: [
      ...(config.plugins ?? []),
      'expo-apple-authentication',
      ...(iosClientId ? [['@react-native-google-signin/google-signin', {
        iosUrlScheme: iosClientId.split('.').reverse().join('.')
      }]] : [])
    ]
  };
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || config.extra?.eas?.projectId;
  if (!projectId) return developmentConfig(config);
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID must be an Expo project UUID.');
  }

  const channel = process.env.EXPO_UPDATES_CHANNEL?.trim() || 'beta';
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('EXPO_UPDATES_CHANNEL must contain only letters, numbers, dots, dashes, or underscores.');
  }

  return developmentConfig({
    ...config,
    version: release.version,
    runtimeVersion: runtimeVersion(release.version),
    updates: {
      ...config.updates,
      url: `https://u.expo.dev/${projectId}`,
      requestHeaders: {
        ...config.updates?.requestHeaders,
        'expo-channel-name': channel
      }
    },
    extra: {
      ...config.extra,
      releaseVersion: release.version,
      eas: {
        ...config.extra?.eas,
        projectId
      }
    }
  });
}

module.exports = createExpoConfig;
module.exports.createExpoConfig = createExpoConfig;
