/** @file Disposable native upgrade rehearsal with isolated version allocation and retained evidence. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createStartedHostedNativeEvidence,
  validateHostedNativeEvidence,
  writeHostedNativeEvidence
} from './hosted-native-evidence.mjs';

export const APPLICATION_ID = 'net.darkmachines.healthtracker';
export const REHEARSAL_STORE_PASSWORD_ENV = 'CALIBRATE_REHEARSAL_STORE_PASSWORD';
export const REHEARSAL_KEY_PASSWORD_ENV = 'CALIBRATE_REHEARSAL_KEY_PASSWORD';

const PERMANENT_SIGNING_ENV = Object.freeze([
  'CALIBRATE_ANDROID_SIGNING_STORE_FILE',
  'CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD',
  'CALIBRATE_ANDROID_SIGNING_KEY_ALIAS',
  'CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD'
]);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
// Native CMake object paths are long, so keep the owned Windows rehearsal root deliberately short.
const TEMP_PREFIX = 'cnu-';
const SUPPORTED_EMULATOR_ABIS = Object.freeze(['arm64-v8a', 'x86_64', 'x86', 'armeabi-v7a']);
const MAX_COMMAND_ERROR_CHARACTERS = 12_000;
const BUILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'ComSpec', 'GRADLE_USER_HOME', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemDrive',
  'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'windir'
]);

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveVersionCode(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_100_000_000) {
    throw new Error(`${option} must be a positive Android version code.`);
  }
  return parsed;
}

/** Keep disposable builds in the same odd phone/even Wear lanes as modern release validation. */
export function rehearsalVersionCodes(phoneVersionCode) {
  const phone = positiveVersionCode(phoneVersionCode, 'Phone version code');
  if (phone % 2 !== 1) throw new Error('Phone version code must be odd; Wear uses the next even code.');
  const wear = positiveVersionCode(phone + 1, 'Wear version code');
  return { phone, wear };
}

/** Parse a dry-run-by-default CLI so emulator mutation always requires explicit intent. */
export function parseNativeUpgradeArgs(argv, options = {}) {
  const values = {
    baselineRef: null,
    candidateRef: 'HEAD',
    baselineVersionCode: 1,
    candidateVersionCode: 3,
    phoneSerial: null,
    wearSerial: null,
    serverUrl: 'https://calibratehealth.app',
    outputFile: null,
    disposableKeystore: null,
    disposableKeyAlias: 'calibrate-upgrade',
    allowExistingPackage: false,
    packageOnly: false,
    dryRun: true,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--execute') values.dryRun = false;
    else if (option === '--dry-run') values.dryRun = true;
    else if (option === '--allow-existing-package') values.allowExistingPackage = true;
    else if (option === '--package-only') values.packageOnly = true;
    else if (option === '--help' || option === '-h') values.help = true;
    else if (option === '--baseline') values.baselineRef = requiredValue(argv, index++, option);
    else if (option === '--candidate') values.candidateRef = requiredValue(argv, index++, option);
    else if (option === '--phone-serial') values.phoneSerial = requiredValue(argv, index++, option);
    else if (option === '--wear-serial') values.wearSerial = requiredValue(argv, index++, option);
    else if (option === '--server-url') values.serverUrl = requiredValue(argv, index++, option);
    else if (option === '--output') values.outputFile = requiredValue(argv, index++, option);
    else if (option === '--disposable-keystore') values.disposableKeystore = requiredValue(argv, index++, option);
    else if (option === '--disposable-key-alias') values.disposableKeyAlias = requiredValue(argv, index++, option);
    else if (option === '--baseline-version-code') {
      values.baselineVersionCode = positiveVersionCode(requiredValue(argv, index++, option), option);
    } else if (option === '--candidate-version-code') {
      values.candidateVersionCode = positiveVersionCode(requiredValue(argv, index++, option), option);
    } else {
      throw new Error(`Unknown native upgrade option: ${option}`);
    }
  }

  if (values.help) return values;
  if (!values.baselineRef) throw new Error('--baseline is required.');
  if (!values.phoneSerial || !values.wearSerial) {
    throw new Error('--phone-serial and --wear-serial are required so no implicit device can be changed.');
  }
  if (values.phoneSerial === values.wearSerial) throw new Error('Phone and Wear serials must be different.');
  const baselineCodes = rehearsalVersionCodes(values.baselineVersionCode);
  const candidateCodes = rehearsalVersionCodes(values.candidateVersionCode);
  if (candidateCodes.phone <= baselineCodes.wear) {
    throw new Error('Candidate version code must be greater than the baseline version code.');
  }
  let serverUrl;
  try {
    serverUrl = new URL(values.serverUrl);
  } catch {
    throw new Error('--server-url must be a credential-free HTTPS origin.');
  }
  if (serverUrl.protocol !== 'https:' || serverUrl.origin !== values.serverUrl) {
    throw new Error('--server-url must be a credential-free HTTPS origin.');
  }

  const root = options.repositoryRoot ?? repositoryRoot;
  if (values.disposableKeystore) values.disposableKeystore = path.resolve(root, values.disposableKeystore);
  if (values.outputFile) values.outputFile = path.resolve(root, values.outputFile);
  return values;
}

/** Execute one host command without exposing environment-provided signing passwords. */
export function createCommandRunner(options = {}) {
  const output = options.output ?? process.stdout;
  return async function runCommand(request) {
    if (request.label) output.write(`[native-upgrade] ${request.label}\n`);
    const result = spawnSync(request.command, request.args ?? [], {
      cwd: request.cwd,
      env: request.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) throw result.error;
    const response = {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    };
    if (response.status !== 0 && !request.allowFailure) {
      let detail = response.stderr.trim() || response.stdout.trim() || `exit ${response.status}`;
      for (const name of [
        'CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD',
        'CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD',
        REHEARSAL_STORE_PASSWORD_ENV,
        REHEARSAL_KEY_PASSWORD_ENV
      ]) {
        const secret = request.env?.[name];
        if (secret) detail = detail.replaceAll(secret, '[REDACTED]');
      }
      if (detail.length > MAX_COMMAND_ERROR_CHARACTERS) {
        detail = `[earlier command output omitted]\n${detail.slice(-MAX_COMMAND_ERROR_CHARACTERS)}`;
      }
      throw new Error(`${request.label ?? request.command} failed: ${detail}`);
    }
    return response;
  };
}

function commandPath(root, windowsName, unixName = windowsName) {
  return process.platform === 'win32' ? path.join(root, windowsName) : path.join(root, unixName);
}

/** Resolve Android/JDK tools without consulting global package managers or downloading anything. */
export function resolveNativeUpgradeTooling(environment = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const sdkRoot = environment.ANDROID_HOME
    ?? environment.ANDROID_SDK_ROOT
    ?? (environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Android', 'Sdk') : null);
  const javaHome = environment.JAVA_HOME
    ?? (platform === 'win32' ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : null);
  if (!sdkRoot) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required.');
  if (!javaHome) throw new Error('JAVA_HOME is required.');

  const buildToolsRoot = path.join(sdkRoot, 'build-tools');
  const versions = fs.existsSync(buildToolsRoot)
    ? fs.readdirSync(buildToolsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    : [];
  if (versions.length === 0) throw new Error(`Android build-tools are missing under ${buildToolsRoot}.`);
  const buildTools = path.join(buildToolsRoot, versions[0]);
  return {
    sdkRoot,
    javaHome,
    adb: environment.ADB ?? commandPath(path.join(sdkRoot, 'platform-tools'), 'adb.exe', 'adb'),
    aapt: commandPath(buildTools, 'aapt.exe', 'aapt'),
    apksignerJar: path.join(buildTools, 'lib', 'apksigner.jar'),
    java: commandPath(path.join(javaHome, 'bin'), 'java.exe', 'java'),
    keytool: commandPath(path.join(javaHome, 'bin'), 'keytool.exe', 'keytool'),
    npmCli: environment.NPM_CLI_JS
      ?? environment.npm_execpath
      ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  };
}

/** Rejects a rehearsal configuration when a required executable or artifact tool is missing. */
export function assertToolingExists(tooling) {
  for (const [name, candidate] of Object.entries(tooling)) {
    if (name === 'sdkRoot' || name === 'javaHome') continue;
    if (!fs.existsSync(candidate)) throw new Error(`Required ${name} tool is missing: ${candidate}`);
  }
}

function adbRequest(tooling, serial, args, label, allowFailure = false) {
  return {
    command: tooling.adb,
    args: serial ? ['-s', serial, ...args] : args,
    label,
    allowFailure
  };
}

function parseAdbDevices(output) {
  return output.split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 2);
      return { serial, state };
    });
}

function packagePathFromPm(output) {
  const match = output.match(/^package:(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

/** Verify explicitly named emulator roles and record whether Calibrate is already installed. */
export async function verifyAdbUpgradeTargets(config, tooling, runner) {
  const listed = await runner(adbRequest(tooling, null, ['devices', '-l'], 'list adb targets'));
  const devices = parseAdbDevices(listed.stdout);
  const targets = [];
  for (const [role, serial] of [['phone', config.phoneSerial], ['wear', config.wearSerial]]) {
    const listedTarget = devices.find((device) => device.serial === serial);
    if (!listedTarget || listedTarget.state !== 'device') throw new Error(`${role} target ${serial} is not connected.`);
    if (!serial.startsWith('emulator-')) {
      throw new Error(`${role} target ${serial} is not emulator-scoped; this rehearsal refuses physical devices.`);
    }
    const [qemu, characteristics, model, api, abi, packageResult] = await Promise.all([
      runner(adbRequest(tooling, serial, ['shell', 'getprop', 'ro.kernel.qemu'], `${role} qemu state`)),
      runner(adbRequest(tooling, serial, ['shell', 'getprop', 'ro.build.characteristics'], `${role} characteristics`)),
      runner(adbRequest(tooling, serial, ['shell', 'getprop', 'ro.product.model'], `${role} model`)),
      runner(adbRequest(tooling, serial, ['shell', 'getprop', 'ro.build.version.sdk'], `${role} API level`)),
      runner(adbRequest(tooling, serial, ['shell', 'getprop', 'ro.product.cpu.abi'], `${role} primary ABI`)),
      runner(adbRequest(tooling, serial, ['shell', 'pm', 'path', APPLICATION_ID], `${role} installed package`, true))
    ]);
    if (qemu.stdout.trim() !== '1') throw new Error(`${role} target ${serial} is not an Android emulator.`);
    const isWatch = characteristics.stdout.trim().split(',').includes('watch');
    if (role === 'phone' && isWatch) throw new Error(`${serial} is a Wear target, not a phone target.`);
    if (role === 'wear' && !isWatch) throw new Error(`${serial} is not a Wear target.`);
    const primaryAbi = abi.stdout.trim();
    if (!SUPPORTED_EMULATOR_ABIS.includes(primaryAbi)) {
      throw new Error(`${role} target ${serial} has unsupported primary ABI: ${primaryAbi || 'missing'}.`);
    }
    targets.push({
      role,
      serial,
      model: model.stdout.trim(),
      apiLevel: Number(api.stdout.trim()),
      primaryAbi,
      characteristics: characteristics.stdout.trim(),
      installedPackagePath: packagePathFromPm(packageResult.stdout)
    });
  }
  return targets;
}

async function resolveCommit(repository, ref, runner) {
  const result = await runner({
    command: 'git',
    args: ['-C', repository, 'rev-parse', '--verify', `${ref}^{commit}`],
    label: `resolve ${ref}`
  });
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Git did not resolve ${ref} to a commit.`);
  return commit.toLowerCase();
}

/** Builds a dry-run or execution plan for exact baseline/candidate commits and temporary version lanes. */
export function createNativeUpgradePlan(config, context) {
  return {
    schemaVersion: 1,
    mode: config.dryRun ? 'dry-run' : 'execute',
    baseline: {
      ref: config.baselineRef, commit: context.baselineCommit, versionCode: config.baselineVersionCode,
      wearVersionCode: rehearsalVersionCodes(config.baselineVersionCode).wear
    },
    candidate: {
      ref: config.candidateRef, commit: context.candidateCommit, versionCode: config.candidateVersionCode,
      wearVersionCode: rehearsalVersionCodes(config.candidateVersionCode).wear
    },
    targets: context.targets,
    signing: {
      source: config.disposableKeystore ? 'operator-acknowledged disposable keystore copy' : 'generated disposable key',
      permanentSigningEnvironmentRejected: true,
      passwordsRecorded: false
    },
    evidenceScope: config.packageOnly
      ? 'package-install-launch-and-crash-only'
      : 'operator-prepared-state-plus-package-install-launch-and-crash',
    safety: [
      'Only local clones under a uniquely marked short build root in the user profile are edited or recursively removed.',
      'Physical devices, implicit adb targets, permanent signing environment, uninstall, pm clear, and version downgrade are refused.',
      'Existing emulator installs require --allow-existing-package and an explicitly supplied disposable keystore whose signer matches the installed APK.',
      'The candidate is installed with adb install -r; no app storage is cleared.'
    ],
    steps: [
      'Resolve immutable baseline and candidate commits.',
      'Copy or generate one disposable keystore inside the unique temp root.',
      'Clone both commits locally and override version codes only inside those clones.',
      'Build release APKs for phone and Wear with the same disposable signer.',
      'Verify package IDs, version codes, and all artifact signing fingerprints.',
      config.packageOnly
        ? 'Install or replace and launch the baseline; explicitly skip behavioral state preparation.'
        : 'Install or replace and launch the baseline, then pause for login, cached state, and offline outbox preparation.',
      'Clear only crash logs and install the candidate with adb install -r.',
      'Verify version, firstInstallTime continuity, signer continuity, launches, and crash buffers.',
      'Write JSON evidence and delete only the marked temp root.'
    ]
  };
}

function assertNoPermanentSigningEnvironment(environment) {
  const active = PERMANENT_SIGNING_ENV.filter((name) => environment[name]?.trim());
  if (active.length > 0) {
    throw new Error(`Permanent signing environment is active (${active.join(', ')}). Clear it before a disposable rehearsal.`);
  }
}

function createTempRoot(id) {
  const root = path.join(os.homedir(), `${TEMP_PREFIX}${id}`);
  fs.mkdirSync(root, { recursive: false });
  fs.writeFileSync(path.join(root, '.calibrate-native-upgrade-owner'), `${id}\n`, { flag: 'wx' });
  return root;
}

/** Recursively remove only the exact temp directory carrying this run's ownership marker. */
export function removeOwnedTempRoot(root, id) {
  const resolved = path.resolve(root);
  const expected = path.resolve(os.homedir(), `${TEMP_PREFIX}${id}`);
  if (resolved !== expected) throw new Error(`Refusing to remove unexpected temp path: ${resolved}`);
  const marker = path.join(resolved, '.calibrate-native-upgrade-owner');
  if (fs.readFileSync(marker, 'utf8').trim() !== id) throw new Error(`Refusing to remove unowned temp path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: false });
}

/** Applies temporary paired version codes only inside the disposable rehearsal checkout. */
export function overrideCheckoutVersions(checkout, versionCode) {
  const { wear: wearVersionCode } = rehearsalVersionCodes(versionCode);
  const appJsonPath = path.join(checkout, 'mobile', 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.expo.android.versionCode = versionCode;
  // Historical Android-only checkouts have no iOS config; newer checkouts share the mobile counter.
  if (appJson.expo.ios) appJson.expo.ios.buildNumber = String(versionCode);
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);

  const releasePath = path.join(checkout, 'shared', 'release.json');
  if (fs.existsSync(releasePath)) {
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    release.android.mobile.version_code = versionCode;
    release.android.wear.version_code = wearVersionCode;
    fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  }

  const wearGradlePath = path.join(checkout, 'wear', 'app', 'build.gradle.kts');
  const wearGradle = fs.readFileSync(wearGradlePath, 'utf8');
  const matches = wearGradle.match(/versionCode\s*=\s*\d+/g) ?? [];
  if (matches.length !== 1) throw new Error(`Expected one Wear versionCode in ${wearGradlePath}.`);
  fs.writeFileSync(wearGradlePath, wearGradle.replace(/versionCode\s*=\s*\d+/, `versionCode = ${wearVersionCode}`));

  const pairingGradlePath = path.join(checkout, 'mobile', 'modules', 'wear-pairing', 'android', 'build.gradle');
  const pairingGradle = fs.readFileSync(pairingGradlePath, 'utf8');
  const pairingMatches = pairingGradle.match(/versionCode\s+\d+/g) ?? [];
  if (pairingMatches.length !== 1) throw new Error(`Expected one pairing module versionCode in ${pairingGradlePath}.`);
  fs.writeFileSync(
    pairingGradlePath,
    pairingGradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  );
}

async function createCheckout(root, label, repository, commit, versionCode, runner) {
  const checkout = path.join(root, label);
  await runner({
    command: 'git',
    // Codex and containerized runners can read an operator-owned checkout without owning its Git metadata.
    // Keep the exception scoped to this exact source instead of mutating global Git configuration.
    args: [
      '-c', `safe.directory=${repository}`,
      '-c', `safe.directory=${path.join(repository, '.git')}`,
      'clone', '--local', '--no-hardlinks', '--no-checkout', '--quiet', repository, checkout
    ],
    label: `clone ${label} source`
  });
  await runner({
    command: 'git',
    args: ['-C', checkout, 'checkout', '--detach', '--quiet', commit],
    label: `checkout ${label} commit`
  });
  overrideCheckoutVersions(checkout, versionCode);
  return checkout;
}

/** Expose only build plumbing to historical source; unrelated tokens and service credentials stay out of child code. */
export function signingEnvironment(base, tooling, key) {
  const allowed = {};
  for (const requestedName of BUILD_ENVIRONMENT_ALLOWLIST) {
    const actualName = Object.keys(base).find((name) => name.toLowerCase() === requestedName.toLowerCase());
    if (actualName && base[actualName] !== undefined) allowed[actualName] = base[actualName];
  }
  return {
    ...allowed,
    JAVA_HOME: tooling.javaHome,
    ANDROID_HOME: tooling.sdkRoot,
    CALIBRATE_ANDROID_SIGNING_STORE_FILE: key.file,
    CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: key.storePassword,
    CALIBRATE_ANDROID_SIGNING_KEY_ALIAS: key.alias,
    CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: key.keyPassword,
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: key.serverUrl,
    EXPO_NO_METRO_WORKSPACE_ROOT: '1',
    NODE_ENV: 'production'
  };
}

async function prepareDisposableKey(config, root, tooling, runner, environment) {
  const suppliedExtension = config.disposableKeystore ? path.extname(config.disposableKeystore) : '';
  const file = path.join(root, `disposable-upgrade${suppliedExtension || '.p12'}`);
  if (config.disposableKeystore) {
    if (!fs.statSync(config.disposableKeystore).isFile()) {
      throw new Error(`Disposable keystore is not a file: ${config.disposableKeystore}`);
    }
    const storePassword = environment[REHEARSAL_STORE_PASSWORD_ENV];
    const keyPassword = environment[REHEARSAL_KEY_PASSWORD_ENV];
    if (!storePassword || !keyPassword) {
      throw new Error(`Existing disposable keystore credentials must be supplied through ${REHEARSAL_STORE_PASSWORD_ENV} and ${REHEARSAL_KEY_PASSWORD_ENV}.`);
    }
    fs.copyFileSync(config.disposableKeystore, file, fs.constants.COPYFILE_EXCL);
    return { file, alias: config.disposableKeyAlias, storePassword, keyPassword, generated: false };
  }

  const password = crypto.randomBytes(36).toString('base64url');
  const alias = `calibrate-upgrade-${path.basename(root).slice(-12)}`;
  const keyEnvironment = {
    ...environment,
    [REHEARSAL_STORE_PASSWORD_ENV]: password,
    [REHEARSAL_KEY_PASSWORD_ENV]: password
  };
  await runner({
    command: tooling.keytool,
    args: [
      '-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', file,
      '-storepass:env', REHEARSAL_STORE_PASSWORD_ENV,
      '-keypass:env', REHEARSAL_KEY_PASSWORD_ENV,
      '-alias', alias, '-keyalg', 'RSA', '-keysize', '3072', '-validity', '7',
      '-dname', 'CN=Calibrate Disposable Upgrade Rehearsal,OU=Local QA,O=Calibrate,C=US'
    ],
    env: keyEnvironment,
    label: 'generate disposable signing key'
  });
  return { file, alias, storePassword: password, keyPassword: password, generated: true };
}

function gradleRequest(checkout, project, args, tooling, environment, label) {
  const cwd = path.join(checkout, project);
  return {
    command: tooling.java,
    args: [
      '-classpath', path.join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
      'org.gradle.wrapper.GradleWrapperMain',
      ...args,
      '--no-daemon',
      '--console=plain'
    ],
    cwd,
    env: environment,
    label
  };
}

/** Builds one rehearsal checkout with credential-free dependency installation and a validated emulator ABI. */
export async function buildCheckout(label, checkout, tooling, environment, runner, phoneAbi, options = {}) {
  if (!SUPPORTED_EMULATOR_ABIS.includes(phoneAbi)) throw new Error(`Unsupported phone build ABI: ${phoneAbi}.`);
  await runner({
    command: process.execPath,
    args: [tooling.npmCli, 'ci', '--ignore-scripts', '--no-audit', '--fund=false'],
    cwd: checkout,
    env: environment,
    label: `install ${label} dependencies`
  });
  await runner({
    command: process.execPath,
    args: [
      path.join(checkout, 'node_modules', 'expo', 'bin', 'cli'),
      'prebuild', '--platform', 'android', '--clean', '--no-install'
    ],
    cwd: path.join(checkout, 'mobile'),
    env: environment,
    label: `prebuild ${label} phone`
  });
  await runner({
    command: process.execPath,
    args: [path.join(checkout, 'scripts', 'release-config.mjs'), 'check'],
    cwd: checkout,
    env: environment,
    label: `verify ${label} release mirrors`
  });
  await runner(gradleRequest(
    checkout,
    path.join('mobile', 'android'),
    [
      `-PreactNativeArchitectures=${phoneAbi}`,
      ':app:assembleRelease',
      ...(options.packageOnly ? ['-x', 'lintVitalAnalyzeRelease'] : [])
    ],
    tooling,
    environment,
    `build ${label} phone APK`
  ));
  await runner(gradleRequest(
    checkout,
    'wear',
    [`-PcalibrateWearServerUrl=${environment.EXPO_PUBLIC_CALIBRATE_SERVER_URL}`, ':app:assembleRelease'],
    tooling,
    environment,
    `build ${label} Wear APK`
  ));
  return {
    phone: path.join(checkout, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    wear: path.join(checkout, 'wear', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  };
}

/** Extracts application and version identity from rehearsal APK badging output. */
export function parseApkBadging(output) {
  const match = output.match(/package:\s+name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']+)'/);
  if (!match) throw new Error('Unable to parse APK package metadata.');
  return { applicationId: match[1], versionCode: Number(match[2]), versionName: match[3] };
}

/** Extracts the normalized signing certificate fingerprint from rehearsal APK inspection. */
export function parseSignerFingerprint(output) {
  const match = output.match(/certificate SHA-256 digest:\s*([0-9a-f:]+)/i);
  if (!match) throw new Error('Unable to parse APK signing certificate fingerprint.');
  return match[1].replaceAll(':', '').toLowerCase();
}

async function inspectApk(file, tooling, runner, label) {
  if (!fs.statSync(file).isFile()) throw new Error(`${label} APK is missing: ${file}`);
  const [badging, signing] = await Promise.all([
    runner({ command: tooling.aapt, args: ['dump', 'badging', file], label: `${label} package metadata` }),
    runner({
      command: tooling.java,
      args: ['-jar', tooling.apksignerJar, 'verify', '--print-certs', file],
      label: `${label} signer`
    })
  ]);
  return {
    ...parseApkBadging(badging.stdout),
    signerSha256: parseSignerFingerprint(signing.stdout),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    bytes: fs.statSync(file).size
  };
}

/** Requires baseline and candidate phone/watch artifacts to match the application, version lanes, and signer policy. */
export function assertArtifactSet(artifacts, config) {
  const rows = [artifacts.baseline.phone, artifacts.baseline.wear, artifacts.candidate.phone, artifacts.candidate.wear];
  for (const artifact of rows) {
    if (artifact.applicationId !== APPLICATION_ID) throw new Error(`Unexpected APK application ID: ${artifact.applicationId}`);
  }
  for (const stage of ['baseline', 'candidate']) {
    const codes = rehearsalVersionCodes(config[stage + 'VersionCode']);
    for (const role of ['phone', 'wear']) {
      if (artifacts[stage][role].versionCode !== codes[role]) {
        throw new Error(`${stage} ${role} APK version override was not applied.`);
      }
    }
  }
  const signers = new Set(rows.map((artifact) => artifact.signerSha256));
  if (signers.size !== 1) throw new Error('Phone/Wear baseline and candidate APKs do not share one disposable signer.');
}

/** Extracts installed version, install/update times, and signing evidence from an Android package dump. */
export function parsePackageDump(output) {
  const versionCode = Number(output.match(/\bversionCode=(\d+)/)?.[1]);
  const versionName = output.match(/\bversionName=([^\r\n]+)/)?.[1]?.trim();
  const firstInstallTime = output.match(/\bfirstInstallTime=([^\r\n]+)/)?.[1]?.trim();
  const lastUpdateTime = output.match(/\blastUpdateTime=([^\r\n]+)/)?.[1]?.trim();
  const packageSignature = output.match(/signatures=PackageSignatures\{[^\r\n]+/)?.[0] ?? null;
  if (!versionCode || !versionName || !firstInstallTime || !lastUpdateTime) {
    throw new Error('Unable to parse installed package evidence.');
  }
  return { versionCode, versionName, firstInstallTime, lastUpdateTime, packageSignature };
}

async function packageEvidence(serial, tooling, runner, label) {
  const result = await runner(adbRequest(
    tooling,
    serial,
    ['shell', 'dumpsys', 'package', APPLICATION_ID],
    `${label} installed package evidence`
  ));
  return parsePackageDump(result.stdout);
}

async function installedSigner(target, destination, tooling, runner) {
  if (!target.installedPackagePath) return null;
  await runner(adbRequest(
    tooling,
    target.serial,
    ['pull', target.installedPackagePath, destination],
    `copy ${target.role} installed APK into owned temp root`
  ));
  const signing = await runner({
    command: tooling.java,
    args: ['-jar', tooling.apksignerJar, 'verify', '--print-certs', destination],
    label: `inspect ${target.role} installed signer`
  });
  return parseSignerFingerprint(signing.stdout);
}

async function defaultBaselinePause() {
  if (!process.stdin.isTTY) {
    throw new Error('Execute mode requires an interactive terminal for the baseline-state checkpoint.');
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question(
      '\nPrepare baseline state now: sign in, select the server, sync phone/watch, queue one offline phone write and one watch action if pairing is available. Press Enter to perform the in-place candidate upgrade... '
    );
  } finally {
    terminal.close();
  }
}

const POST_UPGRADE_GATES = Object.freeze([
  ['sessionAndServer', 'The phone login, selected server, and settings survived'],
  ['phoneCachedData', 'Existing phone food and weight data survived'],
  ['phoneOutbox', 'Pending phone mutations reconciled exactly once after reconnect'],
  ['wearPairingAndCache', 'Wear pairing and the cached summary survived'],
  ['wearOutbox', 'A pending Wear action reconciled exactly once after reconnect']
]);

async function defaultPostUpgradeVerification() {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive state evidence requires a TTY for the post-upgrade verification checkpoint.');
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmations = {};
  try {
    process.stdout.write('\nVerify the upgraded apps now. Reconnect them before checking queued operations.\n');
    for (const [key, label] of POST_UPGRADE_GATES) {
      const answer = await terminal.question(`${label}. Type YES to confirm: `);
      if (answer.trim() !== 'YES') throw new Error(`Post-upgrade behavior was not confirmed: ${label}.`);
      confirmations[key] = true;
    }
  } finally {
    terminal.close();
  }
  return { mode: 'operator-confirmed', confirmations };
}

function assertNoUpgradeCrashes(role, crashLog) {
  if (/FATAL EXCEPTION|AndroidRuntime|Fatal signal|tombstone/i.test(crashLog)) {
    throw new Error(`${role} crash buffer contains an upgrade failure.`);
  }
}

function runningProcessIds(role, output) {
  const ids = output.trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
  if (ids.length === 0) throw new Error(`${role} process was not alive after the upgraded launch.`);
  return ids;
}

function launchRequest(role, target, tooling, label) {
  const activity = role === 'phone'
    ? `${APPLICATION_ID}/${APPLICATION_ID}.MainActivity`
    : `${APPLICATION_ID}/app.calibratehealth.wear.MainActivity`;
  return adbRequest(tooling, target.serial, ['shell', 'am', 'start', '-W', '-n', activity], label);
}

function assertLaunchSucceeded(role, output) {
  if (!/^Status:\s*ok\s*$/im.test(output)) {
    throw new Error(`${role} activity did not report a successful launch.`);
  }
}

/** Install baseline then candidate in strict order, preserving application storage throughout. */
export async function executeUpgradeInstallSequence(options) {
  const {
    config, targets, artifacts, tooling, runner,
    pauseForBaselineState = defaultBaselinePause,
    verifyPostUpgradeState = defaultPostUpgradeVerification,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  } = options;
  const preexisting = Object.fromEntries(targets.map((target) => [target.role, Boolean(target.installedPackagePath)]));
  const baselineStates = {};
  for (const role of ['phone', 'wear']) {
    const target = targets.find((entry) => entry.role === role);
    const installArgs = ['install'];
    if (preexisting[role]) installArgs.push('-r');
    installArgs.push(artifacts.baseline[role].file);
    await runner(adbRequest(tooling, target.serial, installArgs, `install ${role} baseline`));
    baselineStates[role] = await packageEvidence(target.serial, tooling, runner, `${role} baseline`);
    if (baselineStates[role].versionCode !== rehearsalVersionCodes(config.baselineVersionCode)[role]) {
      throw new Error(`${role} baseline version code did not install.`);
    }
    const launch = await runner(launchRequest(role, target, tooling, `launch ${role} baseline`));
    assertLaunchSucceeded(role, launch.stdout);
  }

  const baselineCheckpoint = config.packageOnly
    ? { mode: 'package-only', operatorPreparedState: false }
    : { mode: 'interactive-state', operatorPreparedState: true };
  if (!config.packageOnly) await pauseForBaselineState({ baselineStates, targets });
  for (const target of targets) {
    await runner(adbRequest(
      tooling,
      target.serial,
      ['logcat', '-b', 'crash', '-c'],
      `clear ${target.role} crash evidence window`
    ));
  }

  for (const role of ['phone', 'wear']) {
    const target = targets.find((entry) => entry.role === role);
    await runner(adbRequest(
      tooling,
      target.serial,
      ['install', '-r', artifacts.candidate[role].file],
      `in-place upgrade ${role} candidate`
    ));
  }
  for (const role of ['phone', 'wear']) {
    const target = targets.find((entry) => entry.role === role);
    const launch = await runner(launchRequest(role, target, tooling, `launch upgraded ${role}`));
    assertLaunchSucceeded(role, launch.stdout);
  }
  await delay(2_000);

  const candidateStates = {};
  const crashEvidence = {};
  for (const role of ['phone', 'wear']) {
    const target = targets.find((entry) => entry.role === role);
    candidateStates[role] = await packageEvidence(target.serial, tooling, runner, `${role} candidate`);
    if (candidateStates[role].versionCode !== rehearsalVersionCodes(config.candidateVersionCode)[role]) {
      throw new Error(`${role} candidate version code did not install.`);
    }
    if (candidateStates[role].firstInstallTime !== baselineStates[role].firstInstallTime) {
      throw new Error(`${role} firstInstallTime changed; the app was not upgraded in place.`);
    }
    const processResult = await runner(adbRequest(
      tooling,
      target.serial,
      ['shell', 'pidof', APPLICATION_ID],
      `verify upgraded ${role} process`
    ));
    const processIds = runningProcessIds(role, processResult.stdout);
    const crashes = await runner(adbRequest(
      tooling,
      target.serial,
      ['logcat', '-b', 'crash', '-d', '-v', 'brief'],
      `collect ${role} crash evidence`
    ));
    assertNoUpgradeCrashes(role, crashes.stdout);
    // Never retain the device-wide crash buffer: it can contain unrelated application data.
    crashEvidence[role] = {
      clean: true,
      processAlive: true,
      processIds,
      checkedPatterns: ['FATAL EXCEPTION', 'AndroidRuntime', 'Fatal signal', 'tombstone'],
      rawLogRetained: false
    };
  }
  const behaviorVerification = config.packageOnly
    ? { mode: 'not-performed', reason: 'package-only execution' }
    : await verifyPostUpgradeState({ baselineStates, candidateStates, targets });
  return {
    preexisting,
    baselineCheckpoint,
    baselineStates,
    candidateStates,
    crashEvidence,
    behaviorVerification
  };
}

/** Normalizes raw rehearsal observations into hosted upgrade evidence tied to the exact candidate source. */
export function createHostedUpgradeEvidence(rawEvidence, sourceCommit) {
  const hosted = createStartedHostedNativeEvidence('upgrade', sourceCommit);
  const plan = rawEvidence?.plan;
  const passed = ['package-check-passed', 'behavior-check-passed'].includes(rawEvidence?.status);
  if (plan?.candidate?.commit && plan.candidate.commit !== sourceCommit) {
    throw new Error('Hosted upgrade sourceCommit does not match the candidate plan.');
  }
  if (Array.isArray(plan?.targets)) {
    hosted.emulators = plan.targets.map((target) => ({
      role: target.role,
      apiLevel: target.apiLevel,
      model: target.model,
      abi: target.primaryAbi,
      physical: false
    }));
    hosted.checkpoints.emulatorsValidated = hosted.emulators.length === 2;
    hosted.stage = 'emulators';
  }
  const artifactRows = [
    ['baseline-phone', rawEvidence?.artifacts?.baseline?.phone],
    ['baseline-wear', rawEvidence?.artifacts?.baseline?.wear],
    ['candidate-phone', rawEvidence?.artifacts?.candidate?.phone],
    ['candidate-wear', rawEvidence?.artifacts?.candidate?.wear]
  ];
  if (artifactRows.every(([, artifact]) => artifact)) {
    hosted.artifacts = artifactRows.map(([id, artifact]) => ({
      id,
      packageName: artifact.applicationId,
      versionName: artifact.versionName,
      versionCode: artifact.versionCode,
      sha256: artifact.sha256,
      buildType: 'release',
      disposableSigning: true
    }));
    hosted.stage = 'build';
  }
  const signers = new Set(artifactRows.map(([, artifact]) => artifact?.signerSha256).filter(Boolean));
  const signerEqual = signers.size === 1;
  const baselineStates = rawEvidence?.install?.baselineStates;
  const candidateStates = rawEvidence?.install?.candidateStates;
  const roles = ['phone', 'wear'];
  const baselineInstalled = roles.every((role) => baselineStates?.[role]);
  const candidateInstalled = roles.every((role) => candidateStates?.[role]);
  const installTimePreserved = roles.every((role) =>
    baselineStates?.[role]?.firstInstallTime &&
    baselineStates[role].firstInstallTime === candidateStates?.[role]?.firstInstallTime
  );
  const processAlive = roles.every((role) => rawEvidence?.install?.crashEvidence?.[role]?.processAlive === true);
  const crashClean = roles.every((role) => rawEvidence?.install?.crashEvidence?.[role]?.clean === true);
  // Older retained evidence used one code for both roles. New plans record each role explicitly.
  const plannedCode = (stage, role) => role === 'wear'
    ? plan?.[stage]?.wearVersionCode ?? plan?.[stage]?.versionCode
    : plan?.[stage]?.versionCode;
  const versionAdvanced = roles.every((role) => {
    const baselineCode = plannedCode('baseline', role);
    const candidateCode = plannedCode('candidate', role);
    return Number.isSafeInteger(baselineCode) && baselineCode > 0
      && Number.isSafeInteger(candidateCode) && candidateCode > baselineCode
      && baselineStates?.[role]?.versionCode === baselineCode
      && candidateStates?.[role]?.versionCode === candidateCode
      && rawEvidence?.artifacts?.baseline?.[role]?.versionCode === baselineCode
      && rawEvidence?.artifacts?.candidate?.[role]?.versionCode === candidateCode;
  });
  hosted.checkpoints.disposableSigning = rawEvidence?.signing?.source?.includes('disposable') === true;
  hosted.checkpoints.baselineInstalled = baselineInstalled;
  hosted.checkpoints.candidateInstalledWithReplace = candidateInstalled;
  hosted.checkpoints.noUninstall = passed;
  hosted.checkpoints.noDataClear = passed;
  hosted.checkpoints.signerContinuous = signerEqual;
  hosted.checkpoints.installTimePreserved = installTimePreserved;
  hosted.checkpoints.versionAdvanced = versionAdvanced;
  hosted.checkpoints.processAlive = processAlive;
  hosted.checkpoints.crashClean = crashClean;
  if (passed) {
    hosted.upgrade = {
      baselineCommit: plan.baseline.commit,
      candidateCommit: plan.candidate.commit,
      baselineVersionCode: plan.baseline.versionCode,
      candidateVersionCode: plan.candidate.versionCode,
      installMode: 'adb-install-r',
      uninstallPerformed: false,
      dataCleared: false,
      signerEqual,
      installTimePreserved
    };
    hosted.status = 'passed';
    hosted.stage = 'completed';
  } else {
    hosted.status = 'failed';
    hosted.stage = candidateInstalled ? 'verification' : (baselineInstalled ? 'candidate-upgrade' : hosted.stage);
  }
  const errors = validateHostedNativeEvidence(hosted);
  if (errors.length) throw new Error(`Hosted native upgrade evidence is invalid:\n- ${errors.join('\n- ')}`);
  return hosted;
}

function writeEvidence(outputFile, evidence) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
}

/** Run the read-only plan or the explicitly authorized emulator upgrade rehearsal. */
export async function runNativeUpgradeRehearsal(config, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const environment = dependencies.environment ?? process.env;
  const hostedEvidenceOutput = environment.CALIBRATE_HOSTED_EVIDENCE_OUTPUT?.trim() || null;
  const root = dependencies.repositoryRoot ?? repositoryRoot;
  const tooling = dependencies.tooling ?? resolveNativeUpgradeTooling(environment);
  assertToolingExists(tooling);
  const [baselineCommit, candidateCommit, targets] = await Promise.all([
    resolveCommit(root, config.baselineRef, runner),
    resolveCommit(root, config.candidateRef, runner),
    verifyAdbUpgradeTargets(config, tooling, runner)
  ]);
  if (baselineCommit === candidateCommit) throw new Error('Baseline and candidate resolve to the same commit.');
  const context = { baselineCommit, candidateCommit, targets };
  const plan = createNativeUpgradePlan(config, context);
  if (config.dryRun) return { plan, status: 'dry-run', warnings: targets
    .filter((target) => target.installedPackagePath)
    .map((target) => `${target.role} already has ${APPLICATION_ID}; execute mode requires --allow-existing-package and a matching disposable keystore.`) };

  assertNoPermanentSigningEnvironment(environment);
  const occupied = targets.filter((target) => target.installedPackagePath);
  if (occupied.length > 0 && !config.allowExistingPackage) {
    throw new Error('Calibrate is already installed on an emulator. Use a fresh AVD or explicitly pass --allow-existing-package with its disposable keystore.');
  }
  if (occupied.length > 0 && !config.disposableKeystore) {
    throw new Error('An existing package can be preserved only with --disposable-keystore so signer continuity can be proven before installation.');
  }

  // Randomness keeps concurrent runs isolated while the short identifier protects native Windows build paths.
  const id = crypto.randomBytes(6).toString('hex');
  const outputFile = config.outputFile ?? path.join(root, '.codex-screenshots', `native-upgrade-${id}.json`);
  const evidence = {
    schemaVersion: 1,
    id,
    status: 'started',
    plan,
    startedAt: new Date().toISOString()
  };
  let tempRoot;
  try {
    tempRoot = createTempRoot(id);
    const key = await prepareDisposableKey(config, tempRoot, tooling, runner, environment);
    key.serverUrl = config.serverUrl;
    const buildEnvironment = signingEnvironment(environment, tooling, key);
    const baselineCheckout = await createCheckout(
      tempRoot, 'baseline', root, baselineCommit, config.baselineVersionCode, runner
    );
    const candidateCheckout = await createCheckout(
      tempRoot, 'candidate', root, candidateCommit, config.candidateVersionCode, runner
    );
    const phoneAbi = targets.find((target) => target.role === 'phone').primaryAbi;
    const baselineFiles = await buildCheckout(
      'baseline', baselineCheckout, tooling, buildEnvironment, runner, phoneAbi,
      { packageOnly: config.packageOnly }
    );
    const candidateFiles = await buildCheckout(
      'candidate', candidateCheckout, tooling, buildEnvironment, runner, phoneAbi,
      { packageOnly: config.packageOnly }
    );
    const inspected = {
      baseline: {
        phone: await inspectApk(baselineFiles.phone, tooling, runner, 'baseline phone'),
        wear: await inspectApk(baselineFiles.wear, tooling, runner, 'baseline Wear')
      },
      candidate: {
        phone: await inspectApk(candidateFiles.phone, tooling, runner, 'candidate phone'),
        wear: await inspectApk(candidateFiles.wear, tooling, runner, 'candidate Wear')
      }
    };
    assertArtifactSet(inspected, config);

    const installedSigners = {};
    for (const target of occupied) {
      const destination = path.join(tempRoot, `preexisting-${target.role}.apk`);
      installedSigners[target.role] = await installedSigner(target, destination, tooling, runner);
      if (installedSigners[target.role] !== inspected.baseline[target.role].signerSha256) {
        throw new Error(`${target.role} installed signer does not match the acknowledged disposable keystore.`);
      }
    }
    const installArtifacts = {
      baseline: {
        phone: { ...inspected.baseline.phone, file: baselineFiles.phone },
        wear: { ...inspected.baseline.wear, file: baselineFiles.wear }
      },
      candidate: {
        phone: { ...inspected.candidate.phone, file: candidateFiles.phone },
        wear: { ...inspected.candidate.wear, file: candidateFiles.wear }
      }
    };
    const installEvidence = await executeUpgradeInstallSequence({
      config,
      targets,
      artifacts: installArtifacts,
      tooling,
      runner,
      pauseForBaselineState: dependencies.pauseForBaselineState,
      verifyPostUpgradeState: dependencies.verifyPostUpgradeState,
      delay: dependencies.delay
    });
    evidence.status = config.packageOnly ? 'package-check-passed' : 'behavior-check-passed';
    evidence.completedAt = new Date().toISOString();
    evidence.signing = {
      source: key.generated ? 'generated disposable key' : 'operator-acknowledged disposable keystore copy',
      signerSha256: inspected.baseline.phone.signerSha256,
      installedSigners
    };
    evidence.artifacts = inspected;
    evidence.install = installEvidence;
  } catch (error) {
    evidence.status = 'failed';
    evidence.completedAt = new Date().toISOString();
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      writeEvidence(outputFile, evidence);
      if (hostedEvidenceOutput) {
        const hosted = createHostedUpgradeEvidence(evidence, environment.CALIBRATE_SOURCE_COMMIT?.trim());
        writeHostedNativeEvidence(hostedEvidenceOutput, hosted);
      }
    } finally {
      if (tempRoot) removeOwnedTempRoot(tempRoot, id);
    }
  }
  return { status: evidence.status, evidenceFile: outputFile, evidence };
}

/** Returns rehearsal usage text documenting the default dry-run and explicit emulator mutation options. */
export function nativeUpgradeHelp() {
  return `Usage: npm run test:native:upgrade -- --baseline <git-ref> --phone-serial <serial> --wear-serial <serial> [options]

Dry-run is the default. Add --execute to build and mutate only the two named emulators.

Options:
  --candidate <git-ref>               Candidate commit (default: HEAD)
  --baseline-version-code <number>    Temporary odd phone baseline code (default: 1); Wear uses code + 1
  --candidate-version-code <number>   Temporary odd phone candidate code (default: 3); Wear uses code + 1
  --server-url <https-origin>          Compiled server origin
  --output <json-path>                 Retained evidence file
  --disposable-keystore <path>         Copy an existing disposable key; never use a permanent release key
  --disposable-key-alias <alias>       Alias in that disposable keystore
  --allow-existing-package             Preserve and replace an existing emulator install after signer verification
  --package-only                       Explicitly skip the interactive state-preparation checkpoint

Existing disposable key passwords must be in ${REHEARSAL_STORE_PASSWORD_ENV} and ${REHEARSAL_KEY_PASSWORD_ENV}.
Build refs execute source from local Git history with an allowlisted environment; select only trusted commits.
Interactive evidence requires explicit post-upgrade confirmations and records behavior-check-passed.
Package-only evidence records package-check-passed and covers install, launch, live process, version, signer, firstInstallTime, and crash patterns; it does not claim login, pairing, cache, or outbox preservation.
The script refuses physical devices, permanent CALIBRATE_ANDROID_SIGNING_* environment, uninstall, pm clear, and downgrade installs.`;
}

async function main() {
  const config = parseNativeUpgradeArgs(process.argv.slice(2));
  if (config.help) {
    console.log(nativeUpgradeHelp());
    return;
  }
  const result = await runNativeUpgradeRehearsal(config);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
