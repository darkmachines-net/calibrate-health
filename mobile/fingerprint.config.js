/** @file Native compatibility includes application inputs but excludes allocated version metadata. */
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { fingerprintTransform } = require('@mchartier/expo-release/expo');
const pairing = 'modules/wear-pairing/';
const normalized = file => readFileSync(resolve(__dirname, file), 'utf8')
  .replace(/^version\s*=\s*['"][^'"]+['"]/gm, "version = '<allocated>'")
  .replace(/versionCode\s+\d+/g, 'versionCode <allocated>')
  .replace(/versionName\s+['"][^'"]+['"]/g, "versionName '<allocated>'");
const pkg = JSON.parse(readFileSync(resolve(__dirname, pairing, 'package.json')));
delete pkg.version;
module.exports = {
  sourceSkips: ['ExpoConfigVersions', 'ExpoConfigRuntimeVersionIfString'],
  // Tests and documentation do not contribute code to the production native binary.
  // Kotlin daemon session/cache files appear during Gradle execution, then disappear on exit.
  ignorePaths: ['**/.kotlin/**', '**/__tests__/**', '**/__mocks__/**', '**/src/test/**', '**/src/androidTest/**',
    '**/*.test.*', '**/*.spec.*', '**/docs/**', '**/README*', '**/AGENTS.md', 'release-version.json',
    `${pairing}package.json`, `${pairing}android/build.gradle`],
  extraSources: [
    { type: 'dir', filePath: 'gradle/native-release/phone', reasons: ['Phone Gradle integrity templates'] },
    { type: 'file', filePath: '../wear/gradle/wrapper/gradle-wrapper.jar', reasons: ['CNG Gradle wrapper'] },
    { type: 'contents', id: 'pairing-package', contents: JSON.stringify(pkg), reasons: ['Native module package without allocated version'] },
    { type: 'contents', id: 'pairing-gradle', contents: normalized(`${pairing}android/build.gradle`), reasons: ['Native Gradle without allocated version'] }
  ],
  /** Remove the diagnostic label mirrored from the native version; preserve all executable config. */
  fileHookTransform(source, chunk) {
    const transformed = fingerprintTransform(source, chunk);
    if (source.type === 'contents' && source.id.startsWith('expoAutolinkingConfig:') && transformed) {
      const linking = JSON.parse(String(transformed));
      for (const module of linking.modules ?? []) if (module.packageName === '@calibrate/wear-pairing') delete module.packageVersion;
      return JSON.stringify(linking);
    }
    if (source.type !== 'contents' || source.id !== 'expoConfig' || !transformed) return transformed;
    const config = JSON.parse(String(transformed));
    if (config.extra?.calibrate) delete config.extra.calibrate.nativeReleaseTag;
    return JSON.stringify(config);
  }
};
