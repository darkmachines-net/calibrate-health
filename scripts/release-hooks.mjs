/** @file Calibrate metadata transformations, paired Gradle builder and application artifact assertions. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, trackedIdentity } from '@mchartier/expo-release';
import { applicationIdentity } from './release-inputs.mjs';
import { checkRepository, createServerReleaseReplacements, createNativeReleaseReplacements, NATIVE_RELEASE_FILE_PATHS } from './release-metadata.mjs';
import { NATIVE_RELEASE_ARTIFACT_CONTRACTS } from './native-release-evidence.mjs';
import { readNativeReleaseBuildProvenance } from './native-release-build.mjs';
import { verifyNativeArtifacts } from './native-artifact-checks.mjs';
import { inspectBundleRuntime } from './native-runtime-checks.mjs';

const serverFiles = { manifest: 'shared/release.json', diagnostics: 'shared/client-diagnostic-versions.json', rootPackage: 'package.json',
  rootLock: 'package-lock.json', backendPackage: 'backend/package.json', backendLock: 'backend/package-lock.json',
  openApi: 'docs/openapi/v1.yaml', generatedApi: 'packages/api-client/src/generated/v1.ts' };

/** Transform only metadata mirrors using the shared planner's allocated versions. */
export function stamp(root, plan) {
  const transform = (files, update) => {
    const current = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), 'utf8')]));
    for (const [key, value] of Object.entries(update(current))) fs.writeFileSync(path.join(root, files[key]), value);
  };
  if (plan.server) transform(serverFiles, value => createServerReleaseReplacements(value, plan.versions.server));
  if (plan.native) transform(NATIVE_RELEASE_FILE_PATHS, value => createNativeReleaseReplacements(value, plan.versions.mobile,
    { mobileVersionCode: plan.pair[0], wearVersionCode: plan.pair[1] }));
  if (plan.bump) fs.writeFileSync(path.join(root, 'mobile/release-version.json'), JSON.stringify({ version: plan.versions.mobile }, null, 2) + '\n');
}

/** Run application tools with the already restricted job environment and logs on stderr. */
function run(root, script, args = [], env = process.env) {
  execFileSync(process.execPath, [path.join(root, script), ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 2, 2] });
}

/** Perform only application operations; selection, reservations and provider requests stay shared. */
export async function applicationHook({ root, action, source, plan, target, directory, baseUrl }) {
  if (action === 'inspect') return { server: applicationIdentity(root, source, 'server'),
    js: { android: applicationIdentity(root, source, 'ota') }, extraNative: hash({ wear: applicationIdentity(root, source, 'wear'),
      builder: trackedIdentity(root, source, { include: file => ['scripts/native-release-build.mjs', 'scripts/native-toolchain.mjs'].includes(file) }) }) };
  if (action === 'prepare') { stamp(root, plan); return {}; }
  if (action === 'validate') {
    const checked = await checkRepository(root);
    if (checked.errors.length) throw new Error(checked.errors.join('\n'));
    run(root, 'scripts/release-acceptance.mjs', ['verify']); return {};
  }
  if (action === 'buildPrepare') { run(root, 'scripts/native-release-build.mjs', ['prepare']); return {}; }
  if (action === 'build') {
    const env = { ...process.env, CALIBRATE_ANDROID_SIGNING_STORE_FILE: process.env.ANDROID_KEYSTORE,
      CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: process.env.ANDROID_STORE_PASSWORD,
      CALIBRATE_ANDROID_SIGNING_KEY_ALIAS: process.env.ANDROID_KEY_ALIAS, CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: process.env.ANDROID_KEY_PASSWORD };
    run(root, 'scripts/native-release-build.mjs', ['build-prepared'], env);
    readNativeReleaseBuildProvenance(root, { candidateCommit: plan.build });
    for (const id of ['phone', 'wear']) {
      const output = path.join(directory, id); fs.mkdirSync(output, { recursive: true });
      for (const artifact of NATIVE_RELEASE_ARTIFACT_CONTRACTS.filter(a => a.role === (id === 'phone' ? 'phone' : 'watch')))
        fs.copyFileSync(path.join(root, artifact.path), path.join(output, `native.${artifact.format}`));
    }
    return { targets: ['phone', 'wear'] };
  }
  if (action === 'verify' && target === 'server') { run(root, 'scripts/production-container-smoke.mjs', [baseUrl]); return {}; }
  if (action === 'verify') {
    verifyNativeArtifacts({ root, sourceCommit: plan.build, environment: process.env });
    inspectBundleRuntime(path.join(directory, 'native.aab'), {
      role: target === 'phone' ? 'phone' : 'watch', runtime: plan.runtime, projectId: plan.config.mobile.projectId,
      channel: plan.config.profiles[plan.profile].channel, serverUrl: plan.environments[plan.profile].EXPO_PUBLIC_CALIBRATE_SERVER_URL
    }, process.env);
    return {};
  }
  throw new Error(`Unsupported application hook: ${action}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await applicationHook(JSON.parse(fs.readFileSync(0, 'utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
}
