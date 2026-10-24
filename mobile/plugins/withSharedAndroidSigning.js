/** @file with Shared Android Signing: Persist shared release signing in regenerated Expo Android projects. */

const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = '// calibrate: shared phone/watch release signing';
const SIGNING_CONFIG_NAME = 'calibrateSharedRelease';

const SUPPORT_BLOCK = `${MARKER}
def calibrateSigningValue = { String name ->
    def value = project.findProperty(name) ?: System.getenv(name)
    value instanceof String && !value.trim().isEmpty() ? value : null
}
def calibrateSigningNames = [
    'CALIBRATE_ANDROID_SIGNING_STORE_FILE',
    'CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD',
    'CALIBRATE_ANDROID_SIGNING_KEY_ALIAS',
    'CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD'
]
def calibrateSigningValues = calibrateSigningNames.collectEntries { name -> [(name): calibrateSigningValue(name)] }
def calibrateSuppliedSigningNames = calibrateSigningNames.findAll { name -> calibrateSigningValues[name] != null }
if (!calibrateSuppliedSigningNames.isEmpty() && calibrateSuppliedSigningNames.size() != calibrateSigningNames.size()) {
    def missing = calibrateSigningNames.findAll { name -> calibrateSigningValues[name] == null }
    throw new GradleException("Shared Android release signing is incomplete. Missing: \${missing.join(', ')}")
}
def calibrateHasSharedReleaseSigning = calibrateSuppliedSigningNames.size() == calibrateSigningNames.size()
def calibrateSigningStorePath = calibrateHasSharedReleaseSigning
    ? new File(calibrateSigningValues['CALIBRATE_ANDROID_SIGNING_STORE_FILE'])
    : null
def calibrateRepositoryRoot = rootProject.projectDir.parentFile.parentFile
def calibrateSigningStoreFile = calibrateSigningStorePath == null
    ? null
    : (calibrateSigningStorePath.isAbsolute() ? calibrateSigningStorePath : new File(calibrateRepositoryRoot, calibrateSigningStorePath.path))
if (calibrateHasSharedReleaseSigning && !calibrateSigningStoreFile.isFile()) {
    throw new GradleException('CALIBRATE_ANDROID_SIGNING_STORE_FILE does not point to a file.')
}
`;

const SIGNING_BLOCK = `
    // The Wear Data Layer requires the phone and watch to share package ID and signing certificate.
    signingConfigs {
        if (calibrateHasSharedReleaseSigning) {
            ${SIGNING_CONFIG_NAME} {
                storeFile calibrateSigningStoreFile
                storePassword calibrateSigningValues['CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD']
                keyAlias calibrateSigningValues['CALIBRATE_ANDROID_SIGNING_KEY_ALIAS']
                keyPassword calibrateSigningValues['CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD']
            }
        }
    }
`;

const RELEASE_TASK_GUARD = `
// Fail only release work so local debug builds do not require production credentials.
tasks.configureEach { task ->
    if (task.name.toLowerCase().contains('release')) {
        task.doFirst {
            if (!calibrateHasSharedReleaseSigning) {
                throw new GradleException('Release tasks require all CALIBRATE_ANDROID_SIGNING_* values so phone and watch use the same certificate.')
            }
        }
    }
}
`;

function findBlock(source, label, startAt = 0) {
  const pattern = new RegExp(`\\b${label}\\s*\\{`, 'g');
  pattern.lastIndex = startAt;
  const match = pattern.exec(source);
  if (!match) throw new Error(`Unable to configure shared Android signing: ${label} block was not found.`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { start: match.index, open, end: index + 1 };
  }
  throw new Error(`Unable to configure shared Android signing: ${label} block is incomplete.`);
}

/** Persist shared release signing in regenerated Expo Android projects. */
function injectSharedAndroidSigning(source) {
  if (source.includes(MARKER)) return source;
  const androidBlock = findBlock(source, 'android');
  const buildTypes = findBlock(source, 'buildTypes', androidBlock.open);
  const releaseBlock = findBlock(source, 'release', buildTypes.open);
  const releaseSource = source.slice(releaseBlock.start, releaseBlock.end);
  if (!/signingConfig\s+signingConfigs\.debug/.test(releaseSource)) {
    throw new Error('Unable to configure shared Android signing: generated release debug signing was not found.');
  }
  const configuredRelease = releaseSource.replace(
    /signingConfig\s+signingConfigs\.debug/,
    `if (calibrateHasSharedReleaseSigning) {\n                signingConfig signingConfigs.${SIGNING_CONFIG_NAME}\n            }`,
  );
  let result = `${source.slice(0, androidBlock.start)}${SUPPORT_BLOCK}\n${source.slice(androidBlock.start)}`;
  const shiftedBuildTypes = findBlock(result, 'buildTypes', findBlock(result, 'android').open);
  result = `${result.slice(0, shiftedBuildTypes.start)}${SIGNING_BLOCK}${result.slice(shiftedBuildTypes.start)}`;
  const shiftedRelease = findBlock(result, 'release', findBlock(result, 'buildTypes').open);
  result = `${result.slice(0, shiftedRelease.start)}${configuredRelease}${result.slice(shiftedRelease.end)}`;
  return `${result.trimEnd()}\n${RELEASE_TASK_GUARD}`;
}

/** Injects shared release-signing configuration into the generated Groovy Android app build. */
const withSharedAndroidSigning = (config) => withAppBuildGradle(config, (gradleConfig) => {
  if (gradleConfig.modResults.language !== 'groovy') {
    throw new Error('Shared Android signing requires the generated Groovy app/build.gradle.');
  }
  gradleConfig.modResults.contents = injectSharedAndroidSigning(gradleConfig.modResults.contents);
  return gradleConfig;
});

module.exports = withSharedAndroidSigning;
module.exports.injectSharedAndroidSigning = injectSharedAndroidSigning;
