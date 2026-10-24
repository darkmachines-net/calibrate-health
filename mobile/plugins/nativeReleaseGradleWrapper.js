/** @file Reviewed Android wrapper contracts, strict lock restoration, and Windows native path bounds for Expo prebuild. */

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_RELEASE_GRADLE_VERSION = '9.4.1';
const NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL =
  `https://services.gradle.org/distributions/gradle-${NATIVE_RELEASE_GRADLE_VERSION}-bin.zip`;
// Reviewed official checksums:
// https://services.gradle.org/distributions/gradle-9.4.1-bin.zip.sha256
// https://services.gradle.org/distributions/gradle-9.4.1-wrapper.jar.sha256
const NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256 =
  '2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb';
const NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256 =
  '55243ef57851f12b070ad14f7f5bb8302daceeebc5bce5ece5fa6edb23e1145c';

const DISTRIBUTION_URL_PROPERTY = NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL.replace(':', '\\:');
// Wear's independent AGP 8 build retains its reviewed Gradle 8 wrapper.
const WEAR_GRADLE_CONTRACT = Object.freeze({
  version: '8.14.3',
  distributionUrlProperty: 'https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip',
  distributionSha256: 'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531',
  wrapperJarSha256: '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172'
});

/** Returns the reviewed phone or Wear Gradle distribution contract and rejects unknown roles. */
function nativeReleaseGradleContract(label = 'phone') {
  if (label === 'wear') return WEAR_GRADLE_CONTRACT;
  if (label !== 'phone') throw new Error(`Unknown native Gradle platform: ${label}`);
  return {
    version: NATIVE_RELEASE_GRADLE_VERSION,
    distributionUrlProperty: DISTRIBUTION_URL_PROPERTY,
    distributionSha256: NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256,
    wrapperJarSha256: NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256
  };
}
const DEPENDENCY_LOCKING_MARKER = '// calibrate: strict native dependency locking';
const PHONE_DEPENDENCY_STATE_DIRECTORY = path.join('gradle', 'native-release', 'phone');
const WINDOWS_OBJECT_PATH_MARKER = '// calibrate: bounded Windows native object paths';
// Leave room for Ninja's temporary filenames beneath long Expo/worktree paths.
const WINDOWS_CMAKE_OBJECT_PATH_MAX = 180;
const WINDOWS_OBJECT_PATH_BLOCK = `${WINDOWS_OBJECT_PATH_MARKER}
if (System.getProperty('os.name').startsWith('Windows')) {
  allprojects {
    ['com.android.application', 'com.android.library'].each { androidPlugin ->
      plugins.withId(androidPlugin) {
        android.defaultConfig.externalNativeBuild.cmake.arguments '-DCMAKE_OBJECT_PATH_MAX=${WINDOWS_CMAKE_OBJECT_PATH_MAX}'
      }
    }
  }
}
`;
const DEPENDENCY_LOCKING_BLOCK = `${DEPENDENCY_LOCKING_MARKER}
allprojects {
  def calibrateDependencyLockName = project.path == ':'
    ? 'root'
    : project.path.substring(1).replace(':', '--')
  dependencyLocking {
    lockAllConfigurations()
    lockMode = org.gradle.api.artifacts.dsl.LockMode.STRICT
    lockFile = rootProject.file("gradle/dependency-locks/\${calibrateDependencyLockName}.lockfile")
  }
}

buildscript {
  configurations.classpath {
    resolutionStrategy.activateDependencyLocking()
  }
}
`;

function propertyIndexes(lines, name) {
  const pattern = new RegExp(`^\\s*${name}\\s*=`);
  return lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
}

/** Pin the generated Expo wrapper after prebuild has written the Android project. */
function pinNativeReleaseGradleWrapperProperties(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  const distributionUrlIndexes = propertyIndexes(lines, 'distributionUrl');
  if (distributionUrlIndexes.length !== 1) {
    throw new Error('Expo Android prebuild must generate exactly one Gradle distributionUrl property.');
  }
  const checksumIndexes = propertyIndexes(lines, 'distributionSha256Sum');
  if (checksumIndexes.length > 1) {
    throw new Error('Expo Android prebuild generated duplicate Gradle distributionSha256Sum properties.');
  }

  const distributionUrlIndex = distributionUrlIndexes[0];
  lines[distributionUrlIndex] = `distributionUrl=${DISTRIBUTION_URL_PROPERTY}`;
  if (checksumIndexes.length === 1) {
    lines[checksumIndexes[0]] = `distributionSha256Sum=${NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256}`;
  } else {
    lines.splice(
      distributionUrlIndex + 1,
      0,
      `distributionSha256Sum=${NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256}`
    );
  }

  return `${lines.join(newline)}${hasTrailingNewline ? newline : ''}`;
}

/** Adds the dependency-locking block once to generated Gradle source. */
function injectNativeDependencyLocking(source) {
  if (source.includes(DEPENDENCY_LOCKING_MARKER)) return source;
  return `${source.trimEnd()}\n\n${DEPENDENCY_LOCKING_BLOCK}`;
}

/** Adds the Windows native object-path limit once to generated Gradle source. */
function injectWindowsNativeObjectPathLimit(source) {
  if (source.includes(WINDOWS_OBJECT_PATH_MARKER)) return source;
  return `${source.trimEnd()}\n\n${WINDOWS_OBJECT_PATH_BLOCK}`;
}

/** Restores reviewed phone dependency locks and verification metadata after generated Android prebuild. */
function restorePhoneGradleDependencyState(projectRoot, platformProjectRoot) {
  const dependencyStateTemplate = path.join(projectRoot, PHONE_DEPENDENCY_STATE_DIRECTORY);
  let templateStat;
  try {
    templateStat = fs.statSync(dependencyStateTemplate);
  } catch {
    throw new Error('Reviewed phone Gradle dependency state is missing.');
  }
  if (!templateStat.isDirectory()) {
    throw new Error('Reviewed phone Gradle dependency state is missing.');
  }
  fs.copyFileSync(
    path.join(dependencyStateTemplate, 'buildscript-gradle.lockfile'),
    path.join(platformProjectRoot, 'buildscript-gradle.lockfile')
  );
  fs.copyFileSync(
    path.join(dependencyStateTemplate, 'settings-gradle.lockfile'),
    path.join(platformProjectRoot, 'settings-gradle.lockfile')
  );
  fs.cpSync(
    path.join(dependencyStateTemplate, 'gradle'),
    path.join(platformProjectRoot, 'gradle'),
    { recursive: true, force: true }
  );
}

module.exports = {
  DISTRIBUTION_URL_PROPERTY,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL,
  NATIVE_RELEASE_GRADLE_VERSION,
  NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256,
  nativeReleaseGradleContract,
  injectNativeDependencyLocking,
  injectWindowsNativeObjectPathLimit,
  pinNativeReleaseGradleWrapperProperties,
  restorePhoneGradleDependencyState
};
