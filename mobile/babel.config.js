/** @file Expo Babel configuration with the required Worklets transform. */

/** Configures cached Expo Babel transforms with the Worklets plugin. */
module.exports = function (api) {
  /** Configures cached Expo Babel transforms with the Worklets plugin. */
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin']
  };
};
