/** @file Canonical native tool versions, verified download identities, and host prerequisite inspection. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Keep local setup and doctor on the same Android tool versions.
export const NATIVE_TOOLCHAIN = Object.freeze({
  nodeMinimum: '22.14.0',
  platform: '36',
  buildTools: '36.0.0',
  ndk: '27.1.12297006',
  cmake: '3.31.6',
  commandLineTools: '20.0',
  bundletool: '1.18.3'
});

// Bootstrap archives are verified before extraction or execution. SDK packages use Google's SDK Manager.
export const NATIVE_TOOL_DOWNLOADS = Object.freeze({
  java: Object.freeze({
    url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip',
    sha256: 'e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0',
    root: 'jdk-17.0.20.1+1'
  }),
  commandLineTools: Object.freeze({
    url: 'https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip',
    sha256: 'cc610ccbe83faddb58e1aa68e8fc8743bb30aa5e83577eceb4cc168dae95f9ee',
    root: 'cmdline-tools'
  }),
  bundletool: Object.freeze({
    url: 'https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar',
    sha256: 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29'
  })
});

export const NATIVE_SDK_PACKAGES = Object.freeze({
  'SDK platform': 'platforms;android-' + NATIVE_TOOLCHAIN.platform,
  'SDK build-tools': 'build-tools;' + NATIVE_TOOLCHAIN.buildTools,
  'SDK platform-tools': 'platform-tools',
  NDK: 'ndk;' + NATIVE_TOOLCHAIN.ndk,
  CMake: 'cmake;' + NATIVE_TOOLCHAIN.cmake
});

/** Runs a bounded hidden native-tool inspection and returns trimmed standard output. */
export function captureNativeTool(command, args, environment) {
  return execFileSync(command, args, {
    env: environment, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000
  }).trim();
}

/** Rejects a Node runtime below the supported native-toolchain minimum. */
export function assertNativeNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  const [minimumMajor, minimumMinor] = NATIVE_TOOLCHAIN.nodeMinimum.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) ||
      major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    throw new Error('Install Node ' + NATIVE_TOOLCHAIN.nodeMinimum + ' or newer, then rerun npm run native:setup.');
  }
  return version;
}

/** Finds a supported SDK command-line tools installation whose revision and required files match. */
export function findNativeSdkManager(sdkRoot) {
  for (const directory of [NATIVE_TOOLCHAIN.commandLineTools, 'latest']) {
    const root = path.join(sdkRoot, 'cmdline-tools', directory);
    const jar = path.join(root, 'lib', 'sdkmanager-classpath.jar');
    const properties = path.join(root, 'source.properties');
    const revision = fs.existsSync(properties) &&
      fs.readFileSync(properties, 'utf8').match(/^Pkg\.Revision\s*=\s*(\S+)\s*$/m)?.[1];
    if (fs.existsSync(jar) && revision === NATIVE_TOOLCHAIN.commandLineTools) {
      return jar;
    }
  }
  return null;
}

/** Computes the SHA-256 digest used to verify a downloaded native tool. */
export function nativeFileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Report every missing tool in one pass; a missing JDK must not hide missing SDK components. */
export function inspectNativeToolchain(environment = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const capture = options.capture ?? captureNativeTool;
  const sdkRoot = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT ||
    (environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Android', 'Sdk') : '');
  const javaHome = environment.JAVA_HOME ||
    (platform === 'win32' ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : '');
  const executable = (name) => name + (platform === 'win32' ? '.exe' : '');
  const checks = [];
  const check = (name, action) => {
    try { checks.push({ name, ok: true, detail: action() }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  };
  const requireFile = (file) => {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error('Missing ' + (file || 'configured path') + '. Run npm run native:setup.');
    }
    return file;
  };
  const runVersion = (command, args, pattern, label) => {
    requireFile(command);
    let output;
    try { output = capture(command, args, environment); }
    catch { throw new Error(label + ' could not run. Run npm run native:setup.'); }
    if (!pattern.test(output)) throw new Error(label + ' has an unsupported version. Run npm run native:setup.');
    return output;
  };
  check('JDK 17', () => {
    if (!javaHome) throw new Error('Set JAVA_HOME to JDK 17. Run npm run native:setup.');
    requireFile(path.join(javaHome, 'bin', executable('keytool')));
    requireFile(path.join(javaHome, 'bin', executable('jar')));
    runVersion(path.join(javaHome, 'bin', executable('javac')), ['--version'], /^javac 17\./, 'JDK compiler');
    return runVersion(path.join(javaHome, 'bin', executable('java')), ['--version'], /^(?:openjdk|java) 17\./, 'JDK 17');
  });
  if (platform === 'win32') check('SDK command-line tools', () => {
    const jar = sdkRoot && findNativeSdkManager(sdkRoot);
    if (!jar) throw new Error('Install SDK command-line tools ' + NATIVE_TOOLCHAIN.commandLineTools + '. Run npm run native:setup.');
    return jar;
  });
  check('SDK platform', () => requireFile(path.join(sdkRoot, 'platforms', 'android-' + NATIVE_TOOLCHAIN.platform, 'android.jar')));
  check('SDK build-tools', () => {
    const directory = path.join(sdkRoot, 'build-tools', NATIVE_TOOLCHAIN.buildTools);
    requireFile(path.join(directory, 'lib', 'apksigner.jar'));
    requireFile(path.join(directory, 'lib', 'd8.jar'));
    requireFile(path.join(directory, executable('aapt2')));
    requireFile(path.join(directory, executable('zipalign')));
    return requireFile(path.join(directory, executable('aapt')));
  });
  check('SDK platform-tools', () => runVersion(
    path.join(sdkRoot, 'platform-tools', executable('adb')), ['version'], /Android Debug Bridge version/, 'ADB'
  ));
  check('NDK', () => {
    const file = requireFile(path.join(sdkRoot, 'ndk', NATIVE_TOOLCHAIN.ndk, 'source.properties'));
    if (!fs.readFileSync(file, 'utf8').includes('Pkg.Revision = ' + NATIVE_TOOLCHAIN.ndk)) {
      throw new Error('NDK revision does not match ' + NATIVE_TOOLCHAIN.ndk + '. Run npm run native:setup.');
    }
    if (platform === 'win32') requireFile(path.join(sdkRoot, 'ndk', NATIVE_TOOLCHAIN.ndk,
      'toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe'));
    return file;
  });
  if (platform === 'win32') check('CMake', () => {
    const directory = path.join(sdkRoot, 'cmake', NATIVE_TOOLCHAIN.cmake, 'bin');
    const expectedVersion = new RegExp('^cmake version ' + NATIVE_TOOLCHAIN.cmake.replaceAll('.', '\\.') + '(?:\\s|$)');
    const cmake = runVersion(path.join(directory, 'cmake.exe'), ['--version'], expectedVersion, 'CMake');
    const ninja = runVersion(path.join(directory, 'ninja.exe'), ['--version'], /^\d+\.\d+\.\d+$/, 'Ninja');
    const [major, minor] = ninja.split('.').map(Number);
    if (major < 1 || (major === 1 && minor < 12)) throw new Error('Install SDK CMake with Ninja 1.12 or newer.');
    return { cmake, ninja };
  });
  check('bundletool', () => {
    const file = requireFile(environment.BUNDLETOOL_JAR);
    if (nativeFileSha256(file) !== NATIVE_TOOL_DOWNLOADS.bundletool.sha256) {
      throw new Error('BUNDLETOOL_JAR does not match the pinned bundletool SHA-256. Run npm run native:setup.');
    }
    const expectedVersion = new RegExp('^' + NATIVE_TOOLCHAIN.bundletool.replaceAll('.', '\\.') + '$');
    return runVersion(path.join(javaHome, 'bin', executable('java')), ['-jar', file, 'version'], expectedVersion, 'bundletool');
  });
  return checks;
}
