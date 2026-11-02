/** @file Check development-client native compatibility before loading Router or application features. */

// Metro's web Fast Refresh setup must precede registration; keep the entry inside mobile.
require('@expo/metro-runtime');
const { NativeModules, Platform } = require('react-native');
const { registerRootComponent } = require('@mchartier/expo-release/register');

if (Platform.OS !== 'web' && NativeModules.EXDevLauncher) {
  registerRootComponent(() => require('expo-router/build/qualified-entry').App);
} else {
  // Preserve Router's normal web/static-export and release startup behavior.
  require('expo-router/entry');
}
