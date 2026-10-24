import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readNativeReleaseBuildProvenance,
  resolveNativeReleaseEnvironment
} from './native-release-build.mjs';
import {
  NATIVE_RELEASE_ARTIFACT_CONTRACTS,
  NATIVE_RELEASE_OBSERVATION_SCHEMA_VERSION,
  parseKeytoolSignerFingerprint,
  validateNativeReleaseObservation
} from './native-release-evidence.mjs';

const APPLICATION_ID = 'net.darkmachines.healthtracker';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const MAX_COMMAND_ERROR_CHARACTERS = 12_000;

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseNativeReleaseDeviceArgs(argv) {
  const values = {
    skipBuild: false,
    phoneSerial: null,
    watchSerial: null,
    serverUrl: null,
    keystore: null,
    keyAlias: null,
    easProjectId: null,
    updatesChannel: null,
    candidateCommit: null,
    evidenceObservation: null,
    replaceIncompatible: false,
    launch: true,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--skip-build') values.skipBuild = true;
    else if (option === '--replace-incompatible') values.replaceIncompatible = true;
    else if (option === '--no-launch') values.launch = false;
    else if (option === '--help' || option === '-h') values.help = true;
    else if (option === '--phone-serial') values.phoneSerial = requiredValue(argv, index++, option);
    else if (option === '--watch-serial') values.watchSerial = requiredValue(argv, index++, option);
    else if (option === '--server-url') values.serverUrl = requiredValue(argv, index++, option);
    else if (option === '--keystore') values.keystore = requiredValue(argv, index++, option);
    else if (option === '--key-alias') values.keyAlias = requiredValue(argv, index++, option);
    else if (option === '--eas-project-id') values.easProjectId = requiredValue(argv, index++, option);
    else if (option === '--updates-channel') values.updatesChannel = requiredValue(argv, index++, option);
    else if (option === '--candidate') values.candidateCommit = requiredValue(argv, index++, option);
    else if (option === '--evidence-observation') values.evidenceObservation = requiredValue(argv, index++, option);
    else throw new Error(`Unknown native release device option: ${option}`);
  }
  return values;
}

function commandPath(root, windowsName, unixName = windowsName) {
  return process.platform === 'win32' ? path.join(root, windowsName) : path.join(root, unixName);
}

/** Locate Android/JDK tools from standard environment variables or Android Studio defaults. */
export function resolveNativeReleaseDeviceTooling(environment = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? fs.existsSync;
  const sdkRoot = environment.ANDROID_HOME
    ?? environment.ANDROID_SDK_ROOT
    ?? (environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Android', 'Sdk') : null);
  const javaHome = environment.JAVA_HOME
    ?? (platform === 'win32' ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : null);
  if (!sdkRoot) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required.');
  if (!javaHome) throw new Error('JAVA_HOME is required.');

  const buildToolsRoot = path.join(sdkRoot, 'build-tools');
  const configuredBuildToolsVersion = environment.ANDROID_BUILD_TOOLS_VERSION?.trim();
  let buildTools;
  if (configuredBuildToolsVersion) {
    buildTools = path.join(buildToolsRoot, configuredBuildToolsVersion);
    if (!fileExists(buildTools)) {
      throw new Error(
        `Configured Android build-tools ${configuredBuildToolsVersion} are missing: ${buildTools}.`
      );
    }
  } else {
    const versions = [...(options.buildToolVersions ?? (fileExists(buildToolsRoot)
      ? fs.readdirSync(buildToolsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      : []))].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    if (versions.length === 0) throw new Error(`Android build-tools are missing under ${buildToolsRoot}.`);
    buildTools = path.join(buildToolsRoot, versions[0]);
  }
  const configuredBundletool = environment.BUNDLETOOL_JAR?.trim();
  const tooling = {
    sdkRoot,
    javaHome,
    adb: environment.ADB ?? commandPath(path.join(sdkRoot, 'platform-tools'), 'adb.exe', 'adb'),
    aapt: commandPath(buildTools, 'aapt.exe', 'aapt'),
    apksignerJar: path.join(buildTools, 'lib', 'apksigner.jar'),
    java: commandPath(path.join(javaHome, 'bin'), 'java.exe', 'java'),
    keytool: commandPath(path.join(javaHome, 'bin'), 'keytool.exe', 'keytool'),
    bundletoolJar: configuredBundletool ? path.resolve(configuredBundletool) : null
  };
  for (const [name, candidate] of Object.entries(tooling)) {
    if (name === 'sdkRoot' || name === 'javaHome' || (name === 'bundletoolJar' && !candidate)) continue;
    if (!fileExists(candidate)) throw new Error(`Required ${name} tool is missing: ${candidate}`);
  }
  return tooling;
}

export function nativeReleaseToolEnvironment(environment, tooling) {
  return {
    ...environment,
    JAVA_HOME: environment.JAVA_HOME?.trim() || tooling.javaHome,
    ANDROID_HOME: environment.ANDROID_HOME?.trim() || tooling.sdkRoot,
    ANDROID_SDK_ROOT: environment.ANDROID_SDK_ROOT?.trim() || tooling.sdkRoot
  };
}

/** Execute a command while keeping signing secrets out of command arguments and failure output. */
export function createNativeReleaseDeviceRunner(options = {}) {
  const output = options.output ?? process.stdout;
  const spawn = options.spawnSync ?? spawnSync;
  return async function runCommand(request) {
    if (request.label) output.write(`[native-release] ${request.label}\n`);
    const result = spawn(request.command, request.args ?? [], {
      cwd: request.cwd,
      env: request.env,
      encoding: request.inherit ? undefined : 'utf8',
      stdio: request.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) throw result.error;
    const response = {
      status: result.status ?? 1,
      stdout: request.inherit ? '' : result.stdout ?? '',
      stderr: request.inherit ? '' : result.stderr ?? ''
    };
    if (response.status !== 0 && !request.allowFailure) {
      let detail = response.stderr.trim() || response.stdout.trim() || `exit ${response.status}`;
      for (const name of [
        'CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD',
        'CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD'
      ]) {
        const secret = request.env?.[name];
        if (secret) detail = detail.replaceAll(secret, '[REDACTED]');
      }
      for (const value of [...(options.redactValues ?? []), ...(request.redactValues ?? [])]) {
        if (value) detail = detail.replaceAll(value, '[REDACTED]');
      }
      if (detail.length > MAX_COMMAND_ERROR_CHARACTERS) {
        detail = `[earlier command output omitted]\n${detail.slice(-MAX_COMMAND_ERROR_CHARACTERS)}`;
      }
      throw new Error(`${request.label ?? request.command} failed: ${detail}`);
    }
    return response;
  };
}

function adbRequest(tooling, serial, args, label, allowFailure = false) {
  return {
    command: tooling.adb,
    args: serial ? ['-s', serial, ...args] : args,
    label,
    allowFailure,
    redactValues: serial ? [serial] : []
  };
}

/** Parse serials containing spaces, including duplicate Windows mDNS names such as "(2)". */
export function parseAdbDeviceRows(output) {
  return output.split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.*?)\s+(device|offline|unauthorized|no permissions)(?:\s+(.*))?$/);
      return match ? { serial: match[1], state: match[2], details: match[3] ?? '' } : null;
    })
    .filter(Boolean);
}

function preferredAdbRoute(left, right) {
  const leftDuplicate = /\(\d+\)/.test(left.serial);
  const rightDuplicate = /\(\d+\)/.test(right.serial);
  if (leftDuplicate !== rightDuplicate) return leftDuplicate ? right : left;
  return left.serial.length <= right.serial.length ? left : right;
}

/** Deduplicate mDNS routes by the device-reported hardware serial. */
export function deduplicateReleaseDevices(devices) {
  const unique = new Map();
  for (const device of devices) {
    const key = `${device.role}:${device.hardwareSerial || device.serial}`;
    const current = unique.get(key);
    unique.set(key, current ? preferredAdbRoute(current, device) : device);
  }
  return [...unique.values()];
}

export function classifyReleaseDevice(characteristics) {
  const values = characteristics.toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
  if (values.includes('watch')) {
    return values.some((value) => ['phone', 'handset', 'tablet', 'tv', 'automotive', 'embedded'].includes(value))
      ? 'unsupported'
      : 'watch';
  }
  if (values.some((value) => ['tv', 'automotive', 'embedded'].includes(value))) {
    return 'unsupported';
  }
  return values.some((value) => ['phone', 'handset', 'tablet', 'default'].includes(value))
    ? 'phone'
    : 'unsupported';
}

function hasHandsetCompatibleCharacteristics(characteristics) {
  const values = characteristics.toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
  return values.some((value) => ['phone', 'handset', 'default'].includes(value))
    && !values.some((value) => ['tablet', 'tv', 'automotive', 'embedded', 'watch'].includes(value));
}

async function discoverReleaseDevices(tooling, runner) {
  const listed = await runner(adbRequest(tooling, null, ['devices', '-l'], 'discover connected Android devices'));
  const connected = parseAdbDeviceRows(listed.stdout).filter(({ state }) => state === 'device');
  const devices = [];
  for (const row of connected) {
    const [hardwareSerial, model, manufacturer, osVersion, apiLevel, characteristics, qemu] = await Promise.all([
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.serialno'], null)),
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.product.model'], null)),
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.product.manufacturer'], null)),
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.build.version.release'], null)),
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.build.version.sdk'], null)),
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.build.characteristics'], null)),
      runner(adbRequest(tooling, row.serial, ['shell', 'getprop', 'ro.kernel.qemu'], null))
    ]);
    devices.push({
      serial: row.serial,
      hardwareSerial: hardwareSerial.stdout.trim(),
      model: model.stdout.trim() || 'unknown model',
      manufacturer: manufacturer.stdout.trim(),
      osVersion: osVersion.stdout.trim(),
      apiLevel: Number(apiLevel.stdout.trim()),
      characteristics: characteristics.stdout.trim(),
      role: classifyReleaseDevice(characteristics.stdout),
      isEmulator: row.serial.startsWith('emulator-') || qemu.stdout.trim() === '1'
    });
  }
  return deduplicateReleaseDevices(devices);
}

async function promptText(message, defaultValue = null) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${message} requires an interactive terminal or an explicit option/environment value.`);
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await terminal.question(`${message}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    terminal.close();
  }
}

/** Read a secret from a TTY without echoing it or placing it in shell history. */
async function promptHidden(message) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error(`${message} requires a TTY or an environment-provided secret.`);
  }
  process.stdout.write(`${message}: `);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled by operator.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

function stripWrappingQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function resolveInteractiveBuildEnvironment(config, environment, root, tooling) {
  const defaultKeystore = path.join(os.homedir(), 'Secure', 'Calibrate', 'calibrate-release.p12');
  const suggestedKeystore = fs.existsSync(defaultKeystore) ? defaultKeystore : null;
  const keystoreInput = config.keystore
    ?? environment.CALIBRATE_ANDROID_SIGNING_STORE_FILE
    ?? await promptText('Release keystore path', suggestedKeystore);
  const keyAlias = config.keyAlias
    ?? environment.CALIBRATE_ANDROID_SIGNING_KEY_ALIAS
    ?? await promptText('Release key alias', 'calibrate');
  const storePassword = environment.CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD
    ?? await promptHidden('Keystore password');
  const promptedKeyPassword = environment.CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD
    ?? await promptHidden('Key password (press Enter to reuse keystore password)');
  const serverUrl = config.serverUrl
    ?? environment.EXPO_PUBLIC_CALIBRATE_SERVER_URL
    ?? await promptText('Calibrate server origin', 'https://calibratehealth.app');
  const staticExpoConfig = JSON.parse(fs.readFileSync(path.join(root, 'mobile', 'app.json'), 'utf8'));
  const easProjectId = config.easProjectId
    ?? environment.EXPO_PUBLIC_EAS_PROJECT_ID
    ?? staticExpoConfig.expo?.extra?.eas?.projectId
    ?? await promptText('Expo/EAS project UUID for OTA and push (leave blank to disable)', null);
  const updatesChannel = easProjectId
    ? (config.updatesChannel
      ?? environment.EXPO_UPDATES_CHANNEL
      ?? await promptText('Expo update channel', 'internal'))
    : 'internal';
  return resolveNativeReleaseEnvironment({
    ...nativeReleaseToolEnvironment(environment, tooling),
    CALIBRATE_ANDROID_SIGNING_STORE_FILE: stripWrappingQuotes(keystoreInput),
    CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: storePassword,
    CALIBRATE_ANDROID_SIGNING_KEY_ALIAS: keyAlias,
    CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: promptedKeyPassword || storePassword,
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: serverUrl,
    EXPO_PUBLIC_EAS_PROJECT_ID: easProjectId,
    EXPO_UPDATES_CHANNEL: updatesChannel
  }, { repositoryRoot: root });
}

async function buildReleaseArtifacts(root, environment, runner) {
  await runner({
    command: process.execPath,
    args: [path.join(root, 'scripts', 'native-release-build.mjs')],
    cwd: root,
    env: environment,
    label: 'build signed phone and Wear release artifacts',
    inherit: true
  });
}

export function parseApkBadging(output) {
  const match = output.match(/package:\s+name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']+)'/);
  if (!match) throw new Error('Unable to parse APK package metadata.');
  return { applicationId: match[1], versionCode: Number(match[2]), versionName: match[3] };
}

export function parseSignerFingerprint(output) {
  const fingerprints = [...output.matchAll(/certificate SHA-256 digest:\s*([0-9a-f:]+)/gi)]
    .map((match) => match[1].replaceAll(':', '').toLowerCase())
    .filter((fingerprint) => /^[0-9a-f]{64}$/.test(fingerprint));
  const unique = [...new Set(fingerprints)];
  if (unique.length !== 1) {
    throw new Error('APK must contain exactly one unique signing certificate SHA-256 fingerprint.');
  }
  return unique[0];
}

export function parseAabManifestMetadata(output) {
  const manifestTag = output.match(/<manifest\b[^>]*>/i)?.[0];
  if (!manifestTag) throw new Error('Unable to parse AAB manifest metadata.');
  const attribute = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return manifestTag.match(new RegExp(`\\s${escaped}=(['"])(.*?)\\1`, 'i'))?.[2] ?? null;
  };
  const applicationId = attribute('package');
  const versionName = attribute('android:versionName');
  const versionCode = Number(attribute('android:versionCode'));
  if (!applicationId || !versionName || !Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error('Unable to parse AAB manifest application ID and version.');
  }
  return { applicationId, versionName, versionCode };
}

function formatFingerprint(value) {
  return value.toUpperCase().match(/.{1,2}/g)?.join(':') ?? value;
}

export async function inspectNativeReleaseArtifactSet(root, tooling, runner) {
  const manifestContent = fs.readFileSync(path.join(root, 'shared', 'release.json'));
  const manifest = JSON.parse(manifestContent.toString('utf8'));
  const expected = {
    phone: requiredNativeReleaseVersion(manifest, 'mobile'),
    watch: requiredNativeReleaseVersion(manifest, 'wear')
  };
  const artifacts = [];

  for (const contract of NATIVE_RELEASE_ARTIFACT_CONTRACTS) {
    const file = path.resolve(root, contract.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`${contract.id} release artifact is missing at ${contract.path}. Build the signed release pair first.`);
    }
    let signerSha256;
    let applicationId;
    let versionName;
    let versionCode;
    if (contract.format === 'apk') {
      const [badging, signing] = await Promise.all([
        runner({
          command: tooling.aapt,
          args: ['dump', 'badging', file],
          label: `inspect ${contract.role} APK metadata`,
          redactValues: [file]
        }),
        runner({
          command: tooling.java,
          args: ['-jar', tooling.apksignerJar, 'verify', '--print-certs', file],
          label: `inspect ${contract.role} APK signer`,
          redactValues: [file]
        })
      ]);
      const metadata = parseApkBadging(badging.stdout);
      applicationId = metadata.applicationId;
      versionName = metadata.versionName;
      versionCode = metadata.versionCode;
      signerSha256 = parseSignerFingerprint(signing.stdout);
    } else {
      if (!tooling.bundletoolJar) {
        throw new Error('BUNDLETOOL_JAR must point to the official bundletool all-in-one JAR for AAB metadata inspection.');
      }
      const [signing, dumpedManifest] = await Promise.all([
        runner({
          command: tooling.keytool,
          args: [
            '-J-Duser.language=en',
            '-J-Duser.country=US',
            '-printcert',
            '-jarfile',
            file
          ],
          label: `inspect ${contract.role} AAB signer`,
          redactValues: [file]
        }),
        runner({
          command: tooling.java,
          args: [
            '-jar',
            tooling.bundletoolJar,
            'dump',
            'manifest',
            `--bundle=${file}`
          ],
          label: `inspect ${contract.role} AAB manifest metadata`,
          redactValues: [file, tooling.bundletoolJar]
        })
      ]);
      const metadata = parseAabManifestMetadata(dumpedManifest.stdout);
      applicationId = metadata.applicationId;
      versionName = metadata.versionName;
      versionCode = metadata.versionCode;
      signerSha256 = parseKeytoolSignerFingerprint(signing.stdout);
    }
    if (applicationId !== APPLICATION_ID) {
      throw new Error(`${contract.id} application ID must be ${APPLICATION_ID}.`);
    }
    if (
      versionName !== expected[contract.role].versionName ||
      versionCode !== expected[contract.role].versionCode
    ) {
      throw new Error(`${contract.id} version does not match shared/release.json.`);
    }
    artifacts.push({
      ...contract,
      sizeBytes: fs.statSync(file).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      applicationId,
      versionName,
      versionCode,
      signerSha256
    });
  }

  const signers = new Set(artifacts.map((artifact) => artifact.signerSha256));
  if (signers.size !== 1) {
    throw new Error('Phone and Wear APK/AAB artifacts do not share one signing certificate.');
  }
  const installArtifact = (role) => {
    const artifact = artifacts.find((candidate) => candidate.role === role && candidate.format === 'apk');
    return { ...artifact, file: path.resolve(root, artifact.path) };
  };
  return {
    releaseManifest: {
      path: 'shared/release.json',
      sha256: crypto.createHash('sha256').update(manifestContent).digest('hex')
    },
    manifestContent,
    artifacts,
    phone: installArtifact('phone'),
    watch: installArtifact('watch')
  };
}

function requiredNativeReleaseVersion(manifest, client) {
  const version = manifest?.android?.[client];
  if (typeof version?.version_name !== 'string' || !version.version_name.trim() ||
      !Number.isSafeInteger(version?.version_code) || version.version_code < 1) {
    throw new Error(
      `shared/release.json must define android.${client}.version_name and a positive integer version_code.`
    );
  }
  return { versionName: version.version_name, versionCode: version.version_code };
}

/** Read the canonical versions that existing APK outputs must match before installation. */
export function readNativeReleaseArtifactVersions(root = repositoryRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'release.json'), 'utf8'));
  return {
    phone: requiredNativeReleaseVersion(manifest, 'mobile'),
    watch: requiredNativeReleaseVersion(manifest, 'wear')
  };
}

/** Prevent --skip-build from silently installing APKs left over from an earlier release. */
export function assertNativeReleaseArtifactVersions(artifacts, expected) {
  for (const role of ['phone', 'watch']) {
    const artifact = artifacts[role];
    const release = expected[role];
    if (artifact.versionName !== release.versionName || artifact.versionCode !== release.versionCode) {
      throw new Error(
        `${role} release APK is stale: found ${artifact.versionName} (${artifact.versionCode}), ` +
        `expected ${release.versionName} (${release.versionCode}) from shared/release.json. ` +
        'Run without --skip-build to rebuild current artifacts.'
      );
    }
  }
}

export function displayNativeReleaseTarget(device, evidenceMode = false) {
  if (evidenceMode) return `${device.model} (physical ${device.role})`;
  const kind = device.isEmulator ? 'emulator' : 'physical';
  return `${device.model} (${device.hardwareSerial || device.serial}, ${kind})`;
}

function displayDevice(device) {
  return displayNativeReleaseTarget(device, false);
}

export function releaseDeviceCandidates(role, devices) {
  const allCandidates = devices.filter((device) => device.role === role);
  const physicalCandidates = allCandidates.filter((device) => !device.isEmulator);
  return physicalCandidates.length > 0 ? physicalCandidates : allCandidates;
}

async function selectReleaseDevice(role, configuredSerial, devices) {
  if (configuredSerial) {
    const match = devices.find((device) =>
      device.serial === configuredSerial || device.hardwareSerial === configuredSerial
    );
    if (!match) throw new Error(`Configured ${role} target is not connected.`);
    if (match.role !== role) throw new Error(`Configured ${role} target has the wrong device role.`);
    return match;
  }
  const candidates = releaseDeviceCandidates(role, devices);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  process.stdout.write(`\nConnected ${role} targets:\n`);
  candidates.forEach((device, index) => process.stdout.write(`  ${index + 1}. ${displayDevice(device)}\n`));
  const selection = Number(await promptText(`Choose ${role} target`));
  if (!Number.isSafeInteger(selection) || selection < 1 || selection > candidates.length) {
    throw new Error(`Invalid ${role} selection.`);
  }
  return candidates[selection - 1];
}

async function offerWatchPairing(tooling, runner) {
  const answer = (await promptText('No connected Wear OS watch found. Pair one now?', 'Y')).toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return;
  const endpoint = await promptText('Watch pairing IP:port');
  const code = await promptHidden('Six-digit watch pairing code');
  await runner(adbRequest(tooling, null, ['pair', endpoint, code], 'pair Wear OS watch'));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function resolveTargets(config, tooling, runner) {
  let devices = await discoverReleaseDevices(tooling, runner);
  let phone = await selectReleaseDevice('phone', config.phoneSerial, devices);
  if (!phone) throw new Error('No connected Android phone or tablet found. Connect USB debugging and authorize this computer.');
  let watch = await selectReleaseDevice('watch', config.watchSerial, devices);
  if (!watch && !config.watchSerial) {
    await offerWatchPairing(tooling, runner);
    devices = await discoverReleaseDevices(tooling, runner);
    phone = await selectReleaseDevice('phone', config.phoneSerial, devices);
    watch = await selectReleaseDevice('watch', null, devices);
  }
  if (!watch) {
    const endpoint = await promptText('Watch wireless-debugging IP:port (leave blank to stop)', null);
    if (endpoint) {
      await runner(adbRequest(tooling, null, ['connect', endpoint], 'connect Wear OS watch'));
      devices = await discoverReleaseDevices(tooling, runner);
      watch = await selectReleaseDevice('watch', config.watchSerial, devices);
    }
  }
  if (!watch) throw new Error('No connected Wear OS watch found.');
  return { phone, watch };
}

function packagePathFromPm(output) {
  return output.match(/^package:(.+)$/m)?.[1]?.trim() ?? null;
}

export function parseInstalledPackageState(output) {
  const versionCode = Number(output.match(/\bversionCode=(\d+)/)?.[1]);
  const versionName = output.match(/\bversionName=([^\r\n\s]+)/)?.[1]?.trim() ?? null;
  const firstInstallTime = output.match(/\bfirstInstallTime=([^\r\n]+)/)?.[1]?.trim() ?? null;
  return {
    versionCode: Number.isSafeInteger(versionCode) && versionCode > 0 ? versionCode : null,
    versionName,
    firstInstallTime
  };
}

export function assertNativeReleaseEvidenceMode(config, checkout) {
  if (!config.evidenceObservation) return false;
  if (!config.skipBuild) throw new Error('Evidence observation requires --skip-build against frozen candidate outputs.');
  if (!config.phoneSerial || !config.watchSerial) {
    throw new Error('Evidence observation requires explicit --phone-serial and --watch-serial targets.');
  }
  if (!/^[0-9a-f]{40}$/.test(config.candidateCommit ?? '')) {
    throw new Error('Evidence observation requires --candidate with a lowercase 40-character Git SHA.');
  }
  if (config.replaceIncompatible) {
    throw new Error('Evidence observation forbids --replace-incompatible and any uninstall.');
  }
  if (!config.launch) throw new Error('Evidence observation must launch and verify both upgraded apps.');
  if (!checkout || checkout.headCommit !== config.candidateCommit) {
    throw new Error('Evidence observation requires checked-out HEAD to equal candidate C.');
  }
  if (typeof checkout?.worktreeStatus !== 'string' || checkout.worktreeStatus.trim()) {
    throw new Error('Evidence observation requires a clean worktree and index before capture.');
  }
  return true;
}

export function assertNativeReleaseEvidenceTargets(targets) {
  for (const role of ['phone', 'watch']) {
    const target = targets?.[role];
    if (!target || target.role !== role) throw new Error(`Evidence observation is missing the ${role} target.`);
    const hasExpectedCharacteristics = role === 'phone'
      ? hasHandsetCompatibleCharacteristics(target.characteristics ?? '')
      : classifyReleaseDevice(target.characteristics ?? '') === role;
    if (!hasExpectedCharacteristics) {
      throw new Error(`Evidence observation requires handset-compatible phone or watch-only build characteristics for ${role}.`);
    }
    if (target.isEmulator !== false) throw new Error(`Evidence observation requires a physical non-emulator ${role}.`);
    if (!/^samsung(?: electronics)?$/i.test(target.manufacturer?.trim() ?? '')) {
      throw new Error(`Evidence observation requires a Samsung ${role}.`);
    }
    if (!target.model?.trim() || !target.osVersion?.trim() || !Number.isSafeInteger(target.apiLevel) || target.apiLevel < 1) {
      throw new Error(`Evidence observation requires ${role} model, OS version, and API level metadata.`);
    }
  }
}

export function retainedNativeReleaseDevices(targets) {
  return ['phone', 'watch'].map((role) => {
    const target = targets[role];
    return {
      role,
      deviceClass: role === 'phone' ? 'handset' : 'watch',
      manufacturer: target.manufacturer,
      model: target.model,
      osVersion: target.osVersion,
      apiLevel: target.apiLevel,
      isPhysical: true,
      isEmulator: false
    };
  });
}

export function assertNativeReleaseEvidenceUpgradePlans(plans) {
  for (const plan of plans) {
    if (plan.state !== 'upgrade') {
      throw new Error(`Evidence observation requires an existing same-signer ${plan.target.role} install.`);
    }
    if (!Number.isSafeInteger(plan.installedVersionCode) || plan.installedVersionCode >= plan.artifact.versionCode) {
      throw new Error(`Evidence observation requires a strictly lower ${plan.target.role} pre-version.`);
    }
    if (!plan.installedVersionName || !plan.installedFirstInstallTime) {
      throw new Error(`Evidence observation requires ${plan.target.role} pre-version and firstInstallTime.`);
    }
    if (plan.installedSignerSha256 !== plan.artifact.signerSha256) {
      throw new Error(`Evidence observation requires the same ${plan.target.role} pre/candidate signer.`);
    }
  }
}

export function createNativeReleaseUpgradeEvidence(prePlans, postPlans) {
  const result = {};
  for (const role of ['phone', 'watch']) {
    const pre = prePlans.find((plan) => plan.target.role === role);
    const post = postPlans.find((plan) => plan.target.role === role);
    if (!pre || !post) throw new Error(`Missing ${role} pre/post upgrade state.`);
    if (
      post.installedVersionCode !== pre.artifact.versionCode ||
      post.installedVersionName !== pre.artifact.versionName
    ) {
      throw new Error(`${role} post-version does not match the candidate APK.`);
    }
    if (post.installedSignerSha256 !== pre.artifact.signerSha256) {
      throw new Error(`${role} signer changed after upgrade.`);
    }
    if (post.installedFirstInstallTime !== pre.installedFirstInstallTime) {
      throw new Error(`${role} firstInstallTime changed; install was not an in-place upgrade.`);
    }
    const state = (plan) => ({
      versionName: plan.installedVersionName,
      versionCode: plan.installedVersionCode,
      firstInstallTime: plan.installedFirstInstallTime,
      signerSha256: plan.installedSignerSha256
    });
    result[role] = {
      explicitAdbTarget: true,
      installMode: 'adb-install-r',
      uninstallPerformed: false,
      dataCleared: false,
      pre: state(pre),
      post: state(post)
    };
  }
  return result;
}

function readNativeReleaseCandidateCheckout(root) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed while preparing evidence observation.`);
    return result.stdout;
  };
  return {
    headCommit: run(['rev-parse', 'HEAD']).trim(),
    worktreeStatus: run(['status', '--porcelain=v1', '--untracked-files=all'])
  };
}

async function inspectInstalledApp(target, artifact, tempRoot, tooling, runner) {
  const packageResult = await runner(adbRequest(
    tooling,
    target.serial,
    ['shell', 'pm', 'path', APPLICATION_ID],
    `inspect installed ${target.role} package`,
    true
  ));
  const installedPackagePath = packagePathFromPm(packageResult.stdout);
  if (!installedPackagePath) {
    return {
      target,
      artifact,
      state: 'fresh',
      installedVersionCode: null,
      installedVersionName: null,
      installedFirstInstallTime: null,
      installedSignerSha256: null
    };
  }

  const dump = await runner(adbRequest(
    tooling,
    target.serial,
    ['shell', 'dumpsys', 'package', APPLICATION_ID],
    `inspect installed ${target.role} version`
  ));
  const localCopy = path.join(tempRoot, `${target.role}-installed.apk`);
  await runner(adbRequest(
    tooling,
    target.serial,
    ['pull', installedPackagePath, localCopy],
    `copy installed ${target.role} APK for signer verification`
  ));
  const signing = await runner({
    command: tooling.java,
    args: ['-jar', tooling.apksignerJar, 'verify', '--print-certs', localCopy],
    label: `inspect installed ${target.role} signer`
  });
  const signerSha256 = parseSignerFingerprint(signing.stdout);
  const installed = parseInstalledPackageState(dump.stdout);
  if (installed.versionCode !== null && installed.versionCode > artifact.versionCode) {
    throw new Error(
      `${target.role} has version code ${installed.versionCode}, newer than candidate ${artifact.versionCode}; build a higher version.`
    );
  }
  return {
    target,
    artifact,
    state: signerSha256 === artifact.signerSha256 ? 'upgrade' : 'replace',
    installedVersionCode: installed.versionCode,
    installedVersionName: installed.versionName,
    installedFirstInstallTime: installed.firstInstallTime,
    installedSignerSha256: signerSha256
  };
}

async function authorizeIncompatibleReplacement(plans, config) {
  const replacements = plans.filter(({ state }) => state === 'replace');
  if (replacements.length === 0 || config.replaceIncompatible) return;
  process.stdout.write('\nSigning identity transition required:\n');
  for (const plan of replacements) {
    process.stdout.write(
      `  ${plan.target.role}: ${displayDevice(plan.target)}\n` +
      `    installed ${formatFingerprint(plan.installedSignerSha256)}\n` +
      `    release   ${formatFingerprint(plan.artifact.signerSha256)}\n`
    );
  }
  process.stdout.write(
    'Replacing an incompatible install deletes only that device app\'s local login, settings, cache, and pending writes.\n'
  );
  const confirmation = await promptText('Type REPLACE to uninstall incompatible builds');
  if (confirmation !== 'REPLACE') throw new Error('Incompatible signer replacement was not authorized.');
}

async function installReleasePlan(plan, tooling, runner, evidenceMode = false) {
  if (plan.state === 'replace') {
    await runner(adbRequest(
      tooling,
      plan.target.serial,
      ['uninstall', APPLICATION_ID],
      `uninstall incompatible ${plan.target.role} build`
    ));
  }
  const installArgs = evidenceMode || plan.state === 'upgrade'
    ? ['install', '-r', plan.artifact.file]
    : ['install', plan.artifact.file];
  await runner(adbRequest(tooling, plan.target.serial, installArgs, `install ${plan.target.role} release APK`));
}

async function launchAndVerify(target, tooling, runner) {
  const activity = target.role === 'phone'
    ? `${APPLICATION_ID}/.MainActivity`
    : `${APPLICATION_ID}/app.calibratehealth.wear.MainActivity`;
  await runner(adbRequest(
    tooling,
    target.serial,
    ['shell', 'am', 'start', '-W', '-n', activity],
    `launch ${target.role} release app`
  ));
  const processResult = await runner(adbRequest(
    tooling,
    target.serial,
    ['shell', 'pidof', APPLICATION_ID],
    `verify ${target.role} process`
  ));
  if (!processResult.stdout.trim()) throw new Error(`${target.role} process did not remain alive after launch.`);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/native-release-devices.mjs [options]

Build, verify, install, and launch the shared-signer mobile and Wear release artifacts.

Options:
  --skip-build                  Install the existing release APK outputs
  --phone-serial <serial>       Select an explicit phone/tablet ADB or hardware serial
  --watch-serial <serial>       Select an explicit watch ADB or hardware serial
  --server-url <https-origin>   Compile a credential-free self-hosted origin
  --keystore <path>             Shared phone/Wear PKCS12 keystore
  --key-alias <alias>           Keystore alias (default: calibrate)
  --eas-project-id <uuid>       Enable Expo OTA and push for this project
  --updates-channel <channel>   OTA channel embedded in the phone build (default: internal)
  --candidate <git-sha>         Frozen source candidate C for strict evidence capture
  --evidence-observation <json> Write a serial-free strict-upgrade observation
  --replace-incompatible        Permit debug-to-release uninstall without an interactive REPLACE prompt
  --no-launch                   Install without launching either app
  --help                        Show this help

Signing passwords are accepted only through hidden prompts or CALIBRATE_ANDROID_SIGNING_* environment variables.
`);
}

export async function runNativeReleaseDevices(options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const config = options.config ?? parseNativeReleaseDeviceArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return { help: true };
  }
  const evidenceMode = Boolean(config.evidenceObservation);
  const checkout = options.candidateCheckout ?? (
    evidenceMode ? readNativeReleaseCandidateCheckout(root) : null
  );
  assertNativeReleaseEvidenceMode(config, checkout);
  const observationOutput = evidenceMode ? path.resolve(root, config.evidenceObservation) : null;
  if (observationOutput && fs.existsSync(observationOutput)) {
    throw new Error(`Evidence observation output already exists: ${path.basename(observationOutput)}`);
  }

  const runner = options.runner ?? createNativeReleaseDeviceRunner();
  const tooling = options.tooling ?? resolveNativeReleaseDeviceTooling(environment);
  if (!config.skipBuild) {
    const buildEnvironment = await resolveInteractiveBuildEnvironment(config, environment, root, tooling);
    await buildReleaseArtifacts(root, buildEnvironment, runner);
  }

  const artifactSet = await inspectNativeReleaseArtifactSet(root, tooling, runner);
  const buildProvenance = evidenceMode
    ? readNativeReleaseBuildProvenance(root, {
      candidateCommit: config.candidateCommit,
      manifestContent: artifactSet.manifestContent,
      artifacts: artifactSet.artifacts
    })
    : null;
  const phoneArtifact = artifactSet.phone;
  const watchArtifact = artifactSet.watch;
  if (config.skipBuild) {
    assertNativeReleaseArtifactVersions(
      { phone: phoneArtifact, watch: watchArtifact },
      readNativeReleaseArtifactVersions(root)
    );
  }
  process.stdout.write(
    `\nRelease signer: ${formatFingerprint(phoneArtifact.signerSha256)}\n` +
    `Phone ${phoneArtifact.versionName} (${phoneArtifact.versionCode}) SHA-256 ${phoneArtifact.sha256}\n` +
    `Wear ${watchArtifact.versionName} (${watchArtifact.versionCode}) SHA-256 ${watchArtifact.sha256}\n`
  );

  const targets = await resolveTargets(config, tooling, runner);
  if (evidenceMode) assertNativeReleaseEvidenceTargets(targets);
  const displayedPhone = displayNativeReleaseTarget(targets.phone, evidenceMode);
  const displayedWatch = displayNativeReleaseTarget(targets.watch, evidenceMode);
  process.stdout.write(
    `\nPhone target: ${displayedPhone}\n` +
    `Watch target: ${displayedWatch}\n`
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-install-'));
  try {
    const plans = await Promise.all([
      inspectInstalledApp(targets.phone, phoneArtifact, tempRoot, tooling, runner),
      inspectInstalledApp(targets.watch, watchArtifact, tempRoot, tooling, runner)
    ]);
    if (evidenceMode) {
      assertNativeReleaseEvidenceUpgradePlans(plans);
    } else {
      await authorizeIncompatibleReplacement(plans, config);
    }
    for (const plan of plans) await installReleasePlan(plan, tooling, runner, evidenceMode);
    if (config.launch) {
      for (const target of [targets.phone, targets.watch]) await launchAndVerify(target, tooling, runner);
    }

    let observation = null;
    if (evidenceMode) {
      const postPlans = await Promise.all([
        inspectInstalledApp(targets.phone, phoneArtifact, tempRoot, tooling, runner),
        inspectInstalledApp(targets.watch, watchArtifact, tempRoot, tooling, runner)
      ]);
      const upgrades = createNativeReleaseUpgradeEvidence(plans, postPlans);
      observation = {
        schemaVersion: NATIVE_RELEASE_OBSERVATION_SCHEMA_VERSION,
        sourceCommit: config.candidateCommit,
        buildProvenance,
        releaseManifest: artifactSet.releaseManifest,
        artifacts: artifactSet.artifacts,
        devices: retainedNativeReleaseDevices(targets),
        upgrades
      };
      const validation = validateNativeReleaseObservation(observation, {
        candidateCommit: config.candidateCommit,
        manifestContent: artifactSet.manifestContent
      });
      if (validation.errors.length) {
        throw new Error(`Evidence observation is invalid:\n- ${validation.errors.join('\n- ')}`);
      }
      fs.mkdirSync(path.dirname(observationOutput), { recursive: true });
      fs.writeFileSync(observationOutput, `${JSON.stringify(observation, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write(
        `Native release evidence observation written without device serials: ${path.basename(observationOutput)}\n`
      );
    }

    process.stdout.write('\nPhone and Wear release installation completed successfully.\n');
    return {
      artifacts: {
        phone: phoneArtifact,
        watch: watchArtifact,
        provenance: artifactSet.artifacts,
        buildProvenance
      },
      targets: evidenceMode ? Object.fromEntries(
        retainedNativeReleaseDevices(targets).map((device) => [device.role, device])
      ) : targets,
      plans: evidenceMode ? null : plans,
      observation
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runNativeReleaseDevices().catch((error) => {
    console.error(`[native-release] ${error.message}`);
    process.exitCode = 1;
  });
}
