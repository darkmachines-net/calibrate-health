/** @file app config: Add EAS Update configuration only when a project ID is supplied. This keeps normal web development usable while making release builds explicit and reproducible. */

/** Resolve the native Expo project, update channel, and automatic runtime compatibility. */
const { runtimeVersion } = require('@mchartier/expo-release/expo');
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Add EAS Update configuration only when a project ID is supplied. This keeps
 * normal web development usable while making release builds explicit and reproducible.
 */
function createExpoConfig({ config }) {
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || config.extra?.eas?.projectId;
  if (!projectId) return config;
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID must be an Expo project UUID.');
  }

  const channel = process.env.EXPO_UPDATES_CHANNEL?.trim() || 'internal';
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('EXPO_UPDATES_CHANNEL must contain only letters, numbers, dots, dashes, or underscores.');
  }

  return {
    ...config,
    runtimeVersion: runtimeVersion('fingerprint'),
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
      eas: {
        ...config.extra?.eas,
        projectId
      }
    }
  };
}

module.exports = createExpoConfig;
module.exports.createExpoConfig = createExpoConfig;
