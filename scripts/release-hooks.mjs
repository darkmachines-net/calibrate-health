/** @file Calibrate source-only release hooks: application inputs, metadata mirrors, validation and paired native artifact contracts. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { configuredComponents, sourceEnvironment } from '@mchartier/expo-release';
import { applicationIdentity } from './release-inputs.mjs';
import { resolveExpoRuntime, resolveExpoPublicConfig, verifyEmbeddedRuntime } from './expo-runtime.mjs';
import { checkRepository, createServerReleaseReplacements, createNativeReleaseReplacements, NATIVE_RELEASE_FILE_PATHS } from './release-metadata.mjs';
import { NATIVE_RELEASE_ARTIFACT_CONTRACTS } from './native-release-evidence.mjs';
import { readNativeReleaseBuildProvenance } from './native-release-build.mjs';
import { verifyNativeArtifacts } from './native-artifact-checks.mjs';
import { inspectBundleRuntime } from './native-runtime-checks.mjs';
import { readNativeUserEnvironment, NATIVE_ENVIRONMENT_KEYS } from './native-setup.mjs';

const serverFiles = { manifest: 'shared/release.json', diagnostics: 'shared/client-diagnostic-versions.json', rootPackage: 'package.json',
  rootLock: 'package-lock.json', backendPackage: 'backend/package.json', backendLock: 'backend/package-lock.json',
  openApi: 'docs/openapi/v1.yaml', generatedApi: 'packages/api-client/src/generated/v1.ts' };

/** Execute an application build/check without mixing tool logs into the JSON response. */
function run(root, file, args = [], environment = {}) {
  execFileSync(process.execPath, [path.join(root, file), ...args], { cwd: root,
    env: { ...sourceEnvironment(), ...environment }, windowsHide: true, stdio: ['ignore', 2, 2], maxBuffer: 32 * 1024 * 1024 });
}

/** Native tools saved by Windows setup apply to both build and binary inspection hooks. */
function nativeEnvironment(inputs) {
  const environment = { ...sourceEnvironment(), ...inputs };
  if (process.platform === 'win32') {
    const saved = readNativeUserEnvironment(process.env);
    for (const key of NATIVE_ENVIRONMENT_KEYS) if (!environment[key] && saved[key]) environment[key] = saved[key];
  }
  return environment;
}

/** Inspect actual Expo runtimes and app-specific source sets; no provider operations or state is maintained here. */
function inspect(request) {
  const { root, source, config, profile, componentEnvironments = {}, environment = {} } = request;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/release.json'), 'utf8'));
  const values = configuredComponents(config, profile);
  const runtimes = new Map();
  const observations = values.map(component => {
    const inputs = componentEnvironments[component.id]?.environment ?? environment;
    const publicInputs = { ...inputs, EXPO_UPDATES_CHANNEL: component.channel };
    const runtimeKey = JSON.stringify(publicInputs);
    if (component.kind !== 'server' && !runtimes.has(runtimeKey)) runtimes.set(runtimeKey, {
      runtime: resolveExpoRuntime(root, { environment: publicInputs }), config: resolveExpoPublicConfig(root, { environment: publicInputs }) });
    const resolved = runtimes.get(runtimeKey); const runtime = resolved?.runtime;
    const type = component.kind === 'server' ? 'server' : component.id === 'wear' ? 'wear' : 'ota';
    const identity = component.id === 'phone' ? runtime : applicationIdentity(root, source.commit, type);
    const environmentHash = componentEnvironments[component.id]?.hash ?? request.environmentHash;
    const observation = { id: component.id, identity,
      ...(runtime ? { runtime, fingerprint: runtime, version: manifest.android.mobile.version_name,
        environmentHash: environmentHash ?? null, environment: publicInputs,
        expoConfig: resolved.config } : { version: manifest.server.version }) };
    return observation;
  });
  return { schemaVersion: 1, observations };
}

/** Transform Calibrate diagnostic/API/Gradle mirrors using versions already reserved by the shared planner. */
async function prepare(request) {
  const { root, plan, originals = {} } = request;
  const read = files => Object.fromEntries(Object.entries(files).map(([key, file]) => [key, originals[file] ?? fs.readFileSync(path.join(root, file), 'utf8')]));
  const save = (files, replacements) => { for (const [key, content] of Object.entries(replacements)) fs.writeFileSync(path.join(root, files[key]), content); };
  const server = plan.components.find(component => component.kind === 'server' && component.next);
  if (server) save(serverFiles, createServerReleaseReplacements(read(serverFiles), server.next.version));
  const phone = plan.components.find(component => component.id === 'phone' && component.next);
  const wear = plan.components.find(component => component.id === 'wear' && component.next);
  if (phone && wear) {
    const current = Object.fromEntries(Object.entries(NATIVE_RELEASE_FILE_PATHS).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), 'utf8')]));
    // Use the original native fields while preserving server transformations made above.
    const original = JSON.parse(originals['shared/release.json']);
    const manifest = JSON.parse(current.manifest);
    manifest.android = original.android;
    current.manifest = JSON.stringify(manifest);
    save(NATIVE_RELEASE_FILE_PATHS, createNativeReleaseReplacements(current, phone.next.version,
      { mobileVersionCode: phone.next.versionCode, wearVersionCode: wear.next.versionCode }));
  }
  const checked = await checkRepository(root);
  if (checked.errors.length) throw new Error(checked.errors.join('\n'));
  return { schemaVersion: 1 };
}

/** Keep Calibrate's validated source gates and native binary assertions in the application repository. */
async function validate(request) {
  const checked = await checkRepository(request.root);
  if (checked.errors.length) throw new Error(checked.errors.join('\n'));
  run(request.root, 'scripts/release-acceptance.mjs', ['verify'], request.environment);
  if (request.plan) {
    run(request.root, 'scripts/dev-env.mjs', ['ci'], request.environment);
    run(request.root, 'scripts/postgres-populated-upgrade-smoke.mjs', [], request.environment);
  }
  return { schemaVersion: 1 };
}

/** Produce application artifacts once per paired build group, or export an already resolved OTA runtime. */
function build(request) {
  const { root, plan, target, phase, outputDirectory, environment = {} } = request;
  const component = plan.components.find(value => value.id === target);
  if (!component) throw new Error('Unknown Calibrate artifact target.');
  if (component.kind === 'native' && process.platform === 'win32') {
    Object.assign(environment, nativeEnvironment(environment));
  }
  if (component.kind === 'ota') {
    const require = createRequire(path.join(root, 'mobile/package.json'));
    const executable = path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli');
    const inputs = { ...environment, EXPO_NO_DOTENV: '1', NODE_ENV: 'production', EXPO_NO_METRO_WORKSPACE_ROOT: '1', EXPO_UPDATES_CHANNEL: component.channel };
    execFileSync(process.execPath, [executable, 'export', '--platform', component.platform, '--output-dir', outputDirectory], {
      cwd: path.join(root, 'mobile'), env: { ...sourceEnvironment(), ...inputs }, windowsHide: true, stdio: ['ignore', 2, 2] });
    return { schemaVersion: 1, artifact: { directory: outputDirectory, runtime: resolveExpoRuntime(root, { environment: inputs }), kind: 'ota' } };
  }
  if (phase === 'prepare') {
    run(root, 'scripts/native-release-build.mjs', ['prepare'], environment);
    const runtime = resolveExpoRuntime(root, { environment });
    if (runtime !== component.observation.runtime) throw new Error('Prebuild changed the reserved phone runtime.');
    return { schemaVersion: 1 };
  }
  run(root, 'scripts/native-release-build.mjs', ['build-prepared'], environment);
  const provenance = readNativeReleaseBuildProvenance(root, { candidateCommit: plan.source.commit });
  const artifacts = [];
  for (const native of plan.components.filter(value => value.kind === 'native' && value.selected)) {
    const directory = path.join(path.dirname(path.dirname(outputDirectory)), native.id, 'files');
    fs.mkdirSync(directory, { recursive: true });
    const role = native.id === 'wear' ? 'watch' : 'phone';
    const contracts = NATIVE_RELEASE_ARTIFACT_CONTRACTS.filter(value => value.role === role);
    for (const contract of contracts) fs.copyFileSync(path.join(root, contract.path), path.join(directory, `native.${contract.format}`));
    artifacts.push({ target: native.id, directory, kind: 'native', provenance, runtime: native.observation.runtime,
      version: native.observation.version, versionCode: native.observation.versionCode });
  }
  return { schemaVersion: 1, artifacts, artifact: artifacts.find(value => value.target === target) };
}

/** Assert Calibrate's embedded phone runtime and original paired build provenance without publishing it. */
function verify(request) {
  const { artifact, plan, target } = request;
  const component = plan.components.find(value => value.id === target);
  if (!artifact || !component) throw new Error('Missing application artifact evidence.');
  if (component.kind === 'server') {
    if (!artifact.baseUrl) throw new Error('Production image verification requires its running smoke instance.');
    run(request.root, 'scripts/production-container-smoke.mjs', [artifact.baseUrl], request.environment);
  }
  if (target === 'phone') {
    verifyEmbeddedRuntime(path.join(artifact.directory, 'native.apk'), 'assets/fingerprint', component.observation.runtime);
    verifyEmbeddedRuntime(path.join(artifact.directory, 'native.aab'), 'base/assets/fingerprint', component.observation.runtime);
  }
  if (component.kind === 'native' && artifact.provenance.sourceCommit !== plan.source.commit) throw new Error('Native build provenance differs from the selected source.');
  if (component.kind === 'native') verifyNativeArtifacts({ root: request.root, sourceCommit: plan.source.commit, environment: nativeEnvironment(request.environment) });
  if (component.kind === 'native') inspectBundleRuntime(path.join(artifact.directory, 'native.aab'), {
    role: target === 'phone' ? 'phone' : 'watch', runtime: component.observation.runtime,
    projectId: plan.providerConfiguration.expo.projectId, channel: component.channel,
    serverUrl: plan.providerConfiguration.expo.serverUrl
  }, nativeEnvironment(request.environment));
  return { schemaVersion: 1, verified: true };
}

const request = JSON.parse(fs.readFileSync(0, 'utf8'));
if (request.schemaVersion !== 1) throw new Error('Unsupported application hook protocol.');
const hooks = { inspect, prepare, validate, build, verify };
if (!Object.hasOwn(hooks, request.action)) throw new Error('Unsupported application hook.');
Promise.resolve(hooks[request.action](request)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
