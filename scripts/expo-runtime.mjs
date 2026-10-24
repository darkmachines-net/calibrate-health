/** @file Resolve and verify the explicit major runtime used by native application build checks. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { resolveNativeReleaseDeviceTooling } from './native-release-devices.mjs';

/** Validate Calibrate's public Expo build inputs before Android generation or compilation. */
export function resolveExpoUpdateBuildConfig(environment, fallbackProjectId = null) {
  const projectId = environment.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || fallbackProjectId || null;
  const channel = environment.EXPO_UPDATES_CHANNEL?.trim() || 'internal';
  if (projectId !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId)) throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID must be an Expo project UUID.');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(channel)) throw new Error('Invalid EXPO_UPDATES_CHANNEL.');
  return { projectId, channel };
}

/** Require the current explicit major-only runtime policy. */
export function validateRuntimeResolution(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value.runtimeVersion ?? '')) throw new Error('Expo must resolve a major-only runtime.');
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

/** Check the actual compiled runtime resource in a debug APK produced by application CI. */
export function verifyEmbeddedRuntime(file, _member, runtime, environment = process.env) {
  const tools = resolveNativeReleaseDeviceTooling(environment);
  const resources = execFileSync(tools.aapt, ['dump', '--values', 'resources', file], { encoding: 'utf8', windowsHide: true });
  const value = resources.split('string/expo_runtime_version')[1]?.split('resource ')[0];
  if (!value || !value.includes('"' + runtime + '"')) throw new Error('Built APK runtime differs from the source major.');
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
