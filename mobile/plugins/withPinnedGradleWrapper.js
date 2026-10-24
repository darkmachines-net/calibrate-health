/** @file Expo prebuild plugin restoring the reviewed Gradle wrapper and dependency verification inputs. */

const fs = require('node:fs');
const path = require('node:path');
const { withFinalizedMod } = require('@expo/config-plugins');
const {
  injectNativeDependencyLocking,
  injectWindowsNativeObjectPathLimit,
  pinNativeReleaseGradleWrapperProperties,
  restorePhoneGradleDependencyState
} = require('./nativeReleaseGradleWrapper');

/** Pins the generated Android wrapper and restores reviewed dependency verification state after prebuild. */
const withPinnedGradleWrapper = (config) => withFinalizedMod(config, ['android', async (modConfig) => {
  const wrapperProperties = path.join(
    modConfig.modRequest.platformProjectRoot,
    'gradle',
    'wrapper',
    'gradle-wrapper.properties'
  );
  const source = fs.readFileSync(wrapperProperties, 'utf8');
  fs.writeFileSync(wrapperProperties, pinNativeReleaseGradleWrapperProperties(source));
  fs.copyFileSync(
    path.join(modConfig.modRequest.projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
    path.join(modConfig.modRequest.platformProjectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  );

  const rootBuildGradle = path.join(modConfig.modRequest.platformProjectRoot, 'build.gradle');
  fs.writeFileSync(
    rootBuildGradle,
    injectWindowsNativeObjectPathLimit(injectNativeDependencyLocking(fs.readFileSync(rootBuildGradle, 'utf8')))
  );
  restorePhoneGradleDependencyState(
    modConfig.modRequest.projectRoot,
    modConfig.modRequest.platformProjectRoot
  );
  return modConfig;
}]);

module.exports = withPinnedGradleWrapper;
