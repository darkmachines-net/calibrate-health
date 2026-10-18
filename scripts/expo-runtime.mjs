/** @file Resolve managed Expo runtimes for native builds and credential-free OTA exports, rejecting incomplete SDK discovery. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readZipEntry } from './zip-entry.mjs';

/** Validate Calibrate's public Expo build inputs before Android generation or compilation. */
export function resolveExpoUpdateBuildConfig(environment, fallbackProjectId = null) {
  const projectId = environment.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || fallbackProjectId || null;
  const channel = environment.EXPO_UPDATES_CHANNEL?.trim() || 'internal';
  if (projectId !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId)) throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID must be an Expo project UUID.');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(channel)) throw new Error('Invalid EXPO_UPDATES_CHANNEL.');
  return { projectId, channel };
}

/** Autolinking errors can produce a hash of an empty graph; such a hash is not a usable runtime. */
export function validateRuntimeResolution(value) {
  if (!/^[a-f0-9]{40,64}$/.test(value.runtimeVersion ?? '')) throw new Error('Expo must resolve a fingerprint runtime.');
  const sources = value.fingerprintSources ?? [];
  const expo = JSON.parse(sources.find((source) => source.id === 'expoAutolinkingConfig:android')?.contents ?? '{}');
  const native = JSON.parse(sources.find((source) => source.id === 'rncoreAutolinkingConfig:android')?.contents ?? '{}');
  for (const name of ['expo-updates', '@calibrate/wear-pairing']) {
    if (!expo.modules?.some((module) => module.packageName === name)) throw new Error(`Incomplete Expo native discovery: ${name}.`);
  }
  // SDK 58 normalizes React Native dependency maps into arrays of named modules.
  const healthConnect = Array.isArray(native)
    ? native.find((module) => module?.name === 'react-native-health-connect')
    : undefined;
  if (!healthConnect?.platforms?.android) throw new Error('Incomplete React Native module discovery.');
  return value.runtimeVersion;
}

/** Use the installed SDK resolver; generated CNG directories must not change the runtime. */
export function resolveExpoRuntime(root, { environment = process.env, execute = spawnSync } = {}) {
  const require = createRequire(path.join(root, 'mobile', 'package.json'));
  const resolver = path.join(path.dirname(require.resolve('expo-updates/package.json')), 'bin', 'cli');
  const env = { ...environment, NODE_ENV: 'production', EXPO_NO_DOTENV: '1', EXPO_NO_METRO_WORKSPACE_ROOT: '1',
    EXPO_UPDATES_WORKFLOW_OVERRIDE: 'managed', EXPO_UPDATES_FINGERPRINT_OVERRIDE: '' };
  for (const key of Object.keys(env)) {
    if (/^(EXPO_TOKEN|GITHUB_TOKEN|GH_TOKEN|DEPLOY_|CALIBRATE_ANDROID_|GOOGLE_|PLAY_)/.test(key)) delete env[key];
  }
  const result = execute(process.execPath, [resolver, 'runtimeversion:resolve', '--platform', 'android', '--workflow', 'managed'], {
    cwd: path.join(root, 'mobile'), env,
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error(`Expo runtime resolution failed: ${result.stderr || result.error}`);
  const value = JSON.parse(result.stdout);
  return validateRuntimeResolution(value);
}

/** Capture the public configuration evaluated with the exact same inputs as runtime resolution. */
export function resolveExpoPublicConfig(root, { environment = process.env, execute = spawnSync } = {}) {
  const require = createRequire(path.join(root, 'mobile/package.json'));
  const env = { ...environment, NODE_ENV: 'production', EXPO_NO_DOTENV: '1', EXPO_NO_METRO_WORKSPACE_ROOT: '1' };
  for (const key of Object.keys(env)) if (/^(EXPO_TOKEN|GITHUB_TOKEN|GH_TOKEN|DEPLOY_|CALIBRATE_ANDROID_|GOOGLE_|PLAY_)/.test(key)) delete env[key];
  const cli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli');
  const result = execute(process.execPath, [cli, 'config', '--type', 'public', '--json'], {
    cwd: path.join(root, 'mobile'), env, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Public Expo configuration could not be resolved.');
  return JSON.parse(result.stdout);
}

/** Compare embedded runtime bytes against the independently resolved source runtime. */
export function verifyEmbeddedRuntime(file, member, runtime) {
  const embedded = readZipEntry(file, member).toString('utf8').trim();
  if (embedded !== runtime) {
    throw new Error(`${path.basename(file)} runtime ${embedded} differs from source fingerprint ${runtime}. Refusing native publication.`);
  }
}

/** Capture a clean runtime or verify a built APK and post-build source against that capture. */
function main() {
  const [root, output, apk] = process.argv.slice(2);
  if (!root || !output) throw new Error('Usage: expo-runtime.mjs <repository-root> <output.json> [built.apk]');
  const runtimeVersion = resolveExpoRuntime(path.resolve(root));
  if (apk) {
    const expected = JSON.parse(readFileSync(output, 'utf8')).runtimeVersion;
    if (runtimeVersion !== expected) throw new Error(`Gradle changed source fingerprint from ${expected} to ${runtimeVersion}.`);
    verifyEmbeddedRuntime(apk, 'assets/fingerprint', expected);
    console.log(`Clean source, built APK, and post-build source use runtime ${expected}.`);
  } else writeFileSync(output, `${JSON.stringify({ runtimeVersion })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
