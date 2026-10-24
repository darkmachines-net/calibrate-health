/** @file Local internal-track build, retained-artifact verification, install, and Play submission orchestration. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkRepository, prepareLocalInternalNativeRelease } from './release-config.mjs';
import { nativeReleaseCredentialFreeEnvironment, readNativeReleaseBuildSource } from './native-release-build.mjs';
import { nativeReleaseToolEnvironment, resolveNativeReleaseDeviceTooling } from './native-release-devices.mjs';
import { readNativeOtaBaseline } from './native-ota-contract.mjs';
import { assertNativeNodeVersion, inspectNativeToolchain, NATIVE_TOOLCHAIN } from './native-toolchain.mjs';
import { inspectNativeEasDependency, inspectNativeHostDependencies } from './native-setup.mjs';
import {
  createGooglePlayPublisher, createNativePlayReleasePlan, inspectLocalNativePlayInternal,
  resolveGooglePlayAccessToken, uploadLocalNativePlayInternal, verifyNativePlayArtifacts
} from './native-play-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INTERNAL_SERVER_URL = 'https://calibratehealth.darkmachines.net';
export const INTERNAL_CHANNEL = 'internal';
export const INTERNAL_PROJECT_ID = 'fda8f8c5-e646-47ac-82fb-35003c9cbec7';
export const LOCAL_RECORD_PATH = 'build/native-local-internal.json';
const RECORD_KIND = 'local-internal';
const WINDOWS_CMAKE_VERSION = NATIVE_TOOLCHAIN.cmake;
// Bound health checks and archive-tool output so failures remain actionable on the host.
const CONNECTION_TIMEOUT_MS = 15_000;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024 * 1024;
const COMMAND_OPTIONS = {
  doctor: [], prepare: ['--bump'], build: ['--credentials-file'],
  submit: ['--service-account-file', '--confirm-play-console-clean'], status: ['--service-account-file']
};

/** Parses local internal-release commands and enforces each command's supported options and required credentials. */
export function parseLocalInternalArgs(argv, { requireCredentials = true } = {}) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error(`Unknown internal release command: ${command}`);
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!COMMAND_OPTIONS[command].includes(option) || Object.hasOwn(values, option)) {
      throw new Error(`Unknown or duplicate ${command} option: ${option}`);
    }
    if (option === '--confirm-play-console-clean') { values[option] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    values[option] = value;
  }
  const required = COMMAND_OPTIONS[command].filter((option) => option !== '--confirm-play-console-clean' &&
    (requireCredentials || !['--credentials-file', '--service-account-file'].includes(option)));
  for (const option of required) if (!values[option]) throw new Error(`${command} requires ${option}.`);
  if (command === 'submit' && !values['--confirm-play-console-clean']) {
    throw new Error('Check Play Publishing overview for unrelated pending changes and pause other Console/API writers, then pass --confirm-play-console-clean.');
  }
  return { command, values };
}

/** Builds the private internal-release environment while stripping inherited Play authentication. */
export function localInternalEnvironment(environment = process.env) {
  const publicEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => {
    const key = name.toUpperCase();
    return !key.startsWith('GOOGLE_PLAY_') && key !== 'GOOGLE_APPLICATION_CREDENTIALS';
  }));
  return {
    ...publicEnvironment,
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: INTERNAL_SERVER_URL,
    EXPO_PUBLIC_EAS_PROJECT_ID: INTERNAL_PROJECT_ID,
    EXPO_UPDATES_CHANNEL: INTERNAL_CHANNEL,
    ANDROID_BUILD_TOOLS_VERSION: NATIVE_TOOLCHAIN.buildTools
  };
}

function isWithin(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Requires an existing regular file whose resolved path lies outside the repository. */
export function requireExternalFile(root, file, label) {
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(file)); } catch { throw new Error(`${label} must name an existing external file.`); }
  if (isWithin(fs.realpathSync(root), resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} must be a file outside the repository.`);
  }
  return resolved;
}

/** Loads validated external Expo signing credentials into the build environment after credential-free preparation. */
export function loadLocalSigningEnvironment(root, file, environment) {
  const resolved = requireExternalFile(root, file, 'credentials.json');
  let signing;
  try { signing = JSON.parse(fs.readFileSync(resolved, 'utf8')).android?.keystore; }
  catch { throw new Error('Unable to read Android credentials.json.'); }
  for (const field of ['keystorePath', 'keystorePassword', 'keyAlias', 'keyPassword']) {
    if (typeof signing?.[field] !== 'string' || !signing[field].trim()) {
      throw new Error(`credentials.json android.keystore.${field} is required.`);
    }
  }
  if (!path.isAbsolute(signing.keystorePath)) throw new Error('Use an absolute keystorePath in external credentials.json.');
  const storeFile = requireExternalFile(root, signing.keystorePath, 'Upload keystore');
  return {
    ...environment,
    CALIBRATE_ANDROID_SIGNING_STORE_FILE: storeFile,
    CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: signing.keystorePassword,
    CALIBRATE_ANDROID_SIGNING_KEY_ALIAS: signing.keyAlias,
    CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: signing.keyPassword
  };
}

/** Creates a paired internal release plan with local provenance names for phone and watch. */
export function createLocalInternalPlan(root, sourceCommit) {
  const plan = createNativePlayReleasePlan({ root, sourceCommit });
  for (const [role, candidate] of Object.entries(plan.candidates)) {
    candidate.releaseName = `${role === 'phone' ? 'local-p' : 'local-w'}@${sourceCommit}`;
  }
  return plan;
}

async function assertReleaseConfiguration(root) {
  const result = await checkRepository(root);
  if (result.errors.length) throw new Error(`Release configuration is inconsistent:\n- ${result.errors.join('\n- ')}`);
  return result.manifest;
}

function runBuildStage(root, stage, environment) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/native-release-build.mjs'), stage], {
    cwd: root, env: environment, stdio: 'inherit', windowsHide: true
  });
  // Do not attach the child process/error object: it can contain its signing environment.
  if (result.error || result.status !== 0) throw new Error(`Native ${stage} failed. Review the build output above.`);
}

function inspectCommand(command, args, environment, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: environment,
      windowsHide: true, maxBuffer: MAX_TOOL_OUTPUT_BYTES, ...options
    }).toString();
  } catch { throw new Error(`Android inspection failed (${path.basename(command)}). Check the installed toolchain and bundle.`); }
}

/** Checks the required Windows CMake and Ninja installations before selecting their toolchain directory. */
export function inspectWindowsCmake(tooling, environment, execute = inspectCommand) {
  const directory = path.join(tooling.sdkRoot, 'cmake', WINDOWS_CMAKE_VERSION);
  const cmake = execute(path.join(directory, 'bin/cmake.exe'), ['--version'], environment);
  const ninja = execute(path.join(directory, 'bin/ninja.exe'), ['--version'], environment).trim();
  const version = ninja.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!cmake.includes(`cmake version ${WINDOWS_CMAKE_VERSION}`) || !version ||
      Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 12)) {
    throw new Error(`Install SDK CMake ${WINDOWS_CMAKE_VERSION} with Ninja 1.12 or newer for Windows.`);
  }
  return { directory, ninja };
}

/** Writes the validated Windows toolchain location into generated Android local properties. */
export function configureLocalInternalToolchain(root, environment, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return;
  const tooling = options.tooling ?? resolveNativeReleaseDeviceTooling(environment);
  const { directory } = inspectWindowsCmake(tooling, environment, options.execute);
  const file = path.join(root, 'mobile/android/local.properties');
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = previous.split(/\r?\n/).filter((line) => !/^\s*cmake\.dir\s*[=:]/.test(line));
  // Pin the generated host file after prebuild: CMake 3.22 can loop on Windows glob regeneration.
  const value = directory.replaceAll('\\', '/').replace(/[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  fs.writeFileSync(file, `${lines.join('\n').trimEnd()}\ncmake.dir=${value}\n`);
}

function metadataValue(xml, name) {
  const entries = xml.match(/<meta-data\b[^>]*>/g) ?? [];
  const entry = entries.find((value) => value.includes(`android:name="${name}"`));
  const value = entry?.match(/android:value="([^"]*)"/)?.[1];
  return value?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/** Rejects debuggable or cleartext-enabled bundles and verifies the role-specific release manifest contract. */
export function validateInternalBundleManifest(xml, role, versionName, resolveResource = () => null) {
  if (!/android:usesCleartextTraffic="false"/.test(xml) || /android:debuggable="true"/.test(xml)) {
    throw new Error(`${role} bundle must be a non-debuggable HTTPS-only release.`);
  }
  if (role === 'phone') {
    const expected = {
      'expo.modules.updates.EXPO_UPDATE_URL': `https://u.expo.dev/${INTERNAL_PROJECT_ID}`,
      'expo.modules.updates.EXPO_RUNTIME_VERSION': versionName
    };
    for (const [name, value] of Object.entries(expected)) {
      const raw = metadataValue(xml, name);
      const resource = raw?.startsWith('@') ? raw.slice(1) : raw;
      const isResource = raw?.startsWith('@') || /^0x[0-9a-f]+$/i.test(raw ?? '');
      const resolved = isResource ? resolveResource(resource) : raw;
      if (resolved !== value) throw new Error(`Phone bundle has an unexpected ${name}.`);
    }
    let headers;
    try { headers = JSON.parse(metadataValue(xml, 'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY')); }
    catch { throw new Error('Phone bundle has no valid Expo update request headers.'); }
    if (headers['expo-channel-name'] !== INTERNAL_CHANNEL) throw new Error('Phone bundle must use Expo internal channel.');
  }
}

/** Extracts one consistent string resource from bundletool output and rejects absent or conflicting values. */
export function parseBundleResourceValue(dump) {
  const values = [...dump.matchAll(/ - \[STR\] "([^"\r\n]*)"/g)].map((match) => match[1]);
  if (!values.length || values.some((value) => value !== values[0])) {
    throw new Error('Bundle runtime resource must resolve to one consistent string value.');
  }
  return values[0];
}

/** Read final AABs, including compiled JS/DEX, rather than trusting build-time environment alone. */
function inspectInternalBundleConfiguration({ root, plan, tooling, environment }) {
  const jar = path.join(tooling.javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  const observations = {};
  for (const role of ['phone', 'watch']) {
    const candidate = plan.candidates[role];
    const file = path.resolve(root, candidate.artifactPath);
    const xml = inspectCommand(tooling.java, ['-jar', tooling.bundletoolJar, 'dump', 'manifest', `--bundle=${file}`], environment);
    validateInternalBundleManifest(xml, role, candidate.versionName, (resource) => {
      const dump = inspectCommand(tooling.java, ['-jar', tooling.bundletoolJar, 'dump', 'resources',
        `--bundle=${file}`, `--resource=${resource}`, '--values'], environment);
      return parseBundleResourceValue(dump);
    });
    const listing = inspectCommand(jar, ['tf', file], environment).split(/\r?\n/);
    const entries = listing.filter((entry) => role === 'phone'
      ? entry === 'base/assets/index.android.bundle'
      : /^base\/dex\/classes\d*\.dex$/.test(entry));
    if (!entries.length) throw new Error(`${role} bundle has no compiled application content to inspect.`);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-bundle-inspection-'));
    try {
      inspectCommand(jar, ['xf', file, ...entries], environment, { cwd: temporary });
      const hasOrigin = entries.some((entry) => fs.readFileSync(path.join(temporary, entry)).includes(Buffer.from(INTERNAL_SERVER_URL)));
      if (!hasOrigin) throw new Error(`${role} compiled bundle does not contain the private backend origin.`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    observations[role] = { serverUrl: INTERNAL_SERVER_URL, cleartext: false };
  }
  return observations;
}

/** Requires the local baseline to match the planned source, Android runtime, private server, channel, and project. */
export function validateLocalInternalBaseline(baseline, plan) {
  if (baseline.commit !== plan.sourceCommit || baseline.platform !== 'android' ||
      baseline.server_url !== INTERNAL_SERVER_URL || baseline.channel !== INTERNAL_CHANNEL ||
      baseline.project_id !== INTERNAL_PROJECT_ID || baseline.runtime_version !== plan.versionName) {
    throw new Error('Local build baseline must match this source, private backend, Expo project, runtime, and internal channel. Rebuild the candidate.');
  }
}

function verifyCandidate(root, plan, environment, dependencies = {}) {
  const verify = dependencies.verifyArtifacts ?? verifyNativePlayArtifacts;
  const verification = verify({ root, plan, environment });
  const { baseline } = (dependencies.readBaseline ?? readNativeOtaBaseline)(root);
  validateLocalInternalBaseline(baseline, plan);
  const inspect = dependencies.inspectConfiguration ?? inspectInternalBundleConfiguration;
  const tooling = dependencies.tooling ?? resolveNativeReleaseDeviceTooling(environment);
  const configuration = inspect({ root, plan, tooling, environment });
  return { schemaVersion: 1, provenance: RECORD_KIND, plan, verification, configuration, baseline };
}

function writeLocalRecord(root, record) {
  const file = path.join(root, LOCAL_RECORD_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Requires retained local provenance to equal the freshly verified artifact/configuration record. */
export function verifyLocalRecord(root, current) {
  let recorded;
  try { recorded = JSON.parse(fs.readFileSync(path.join(root, LOCAL_RECORD_PATH), 'utf8')); }
  catch { throw new Error('Local internal release record is missing. Run npm run native:build first.'); }
  if (!isDeepStrictEqual(recorded, current)) {
    throw new Error('Local internal artifacts or build configuration changed. Rebuild before installing or submitting.');
  }
}

/** Revalidates configuration, source identity, and retained local build artifacts before reuse. */
export async function verifyLocalInternalArtifacts({ root = ROOT, environment = process.env }, dependencies = {}) {
  await (dependencies.checkConfiguration ?? assertReleaseConfiguration)(root);
  const sourceCommit = (dependencies.readSource ?? readNativeReleaseBuildSource)(root);
  const env = nativeReleaseCredentialFreeEnvironment(localInternalEnvironment(environment));
  const plan = createLocalInternalPlan(root, sourceCommit);
  const record = verifyCandidate(root, plan, env, dependencies);
  verifyLocalRecord(root, record);
  return record;
}

/** Builds the local signed phone/watch artifact set through credential-free preparation and records verified provenance. */
export async function buildLocalInternalRelease({ root = ROOT, credentialsFile, environment = process.env }, dependencies = {}) {
  const sourceCommit = (dependencies.readSource ?? readNativeReleaseBuildSource)(root);
  const env = nativeReleaseCredentialFreeEnvironment(localInternalEnvironment(environment));
  fs.rmSync(path.join(root, LOCAL_RECORD_PATH), { force: true });
  const run = dependencies.runStage ?? runBuildStage;
  run(root, 'prepare', env);
  (dependencies.configureToolchain ?? configureLocalInternalToolchain)(root, env);
  // Preparation executes Expo config/plugins; admit the external keystore only after it finishes.
  const signedEnvironment = (dependencies.loadSigning ?? loadLocalSigningEnvironment)(root, credentialsFile, env);
  run(root, 'build-prepared', signedEnvironment);
  const finalSource = (dependencies.readSource ?? readNativeReleaseBuildSource)(root);
  if (sourceCommit !== finalSource) throw new Error('Source commit changed during the build.');
  const plan = createLocalInternalPlan(root, sourceCommit);
  const record = verifyCandidate(root, plan, env, dependencies);
  writeLocalRecord(root, record);
  return { provenance: RECORD_KIND, sourceCommit, serverUrl: INTERNAL_SERVER_URL, candidates: plan.candidates, record: LOCAL_RECORD_PATH };
}

async function internalReleaseDoctor(root = ROOT, environment = process.env, dependencies = {}) {
  const checks = [];
  const check = async (name, action) => {
    try { checks.push({ name, ok: true, detail: await action() }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  };
  const env = localInternalEnvironment(Object.fromEntries(Object.entries(environment).filter(([name]) => !name.toUpperCase().startsWith('CALIBRATE_ANDROID_'))));
  await check('node', () => assertNativeNodeVersion());
  await check('release configuration', () => assertReleaseConfiguration(root).then((manifest) => manifest.android));
  checks.push(inspectNativeHostDependencies(root), inspectNativeEasDependency(root));
  checks.push(...(dependencies.inspectToolchain ?? inspectNativeToolchain)(env));
  await check('private backend compatibility', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/release.json'), 'utf8'));
    const response = await (dependencies.fetchImpl ?? fetch)(`${INTERNAL_SERVER_URL}/api/v1/client-config`, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}. Check WireGuard and the backend.`);
    const config = await response.json();
    const { compareClientServerCompatibility } = await import(pathToFileURL(path.join(root, 'shared/dist/cjs/releaseCompatibility.js')).href);
    if (config.api_versions?.current !== manifest.server.api.current ||
        compareClientServerCompatibility(manifest.server.version, config.server_version) !== 'compatible') {
      throw new Error(`Backend ${config.server_version ?? 'unknown'} is incompatible with client contract ${manifest.server.version}.`);
    }
    return { serverUrl: INTERNAL_SERVER_URL, serverVersion: config.server_version, capabilities: config.capabilities };
  });
  return { ok: checks.every((check) => check.ok), checks };
}

const HELP = `Local phone + Wear internal releases (never production or signed native tags).
  npm run native:configure -- --service-account-file ABSOLUTE_EXTERNAL_FILE
  npm run native:setup
  npm run native:build
  npm run native:submit
Maintainer helpers (not additional build/submit stages):
  node scripts/native-internal-release.mjs doctor
  node scripts/native-internal-release.mjs prepare --bump patch|minor|major
  node scripts/native-internal-release.mjs status --service-account-file ABSOLUTE_EXTERNAL_FILE
Backend: ${INTERNAL_SERVER_URL}; Expo channel: ${INTERNAL_CHANNEL}.
Commit all source/version changes before build. Keep credentials outside the repository.`;

/** Dispatches local internal build, install, submit, preparation, and diagnostics with command-specific validation. */
export async function runLocalInternalCli(argv, options = {}) {
  const { command, values } = parseLocalInternalArgs(argv);
  const root = options.root ?? ROOT;
  const environment = options.environment ?? process.env;
  if (command === 'help') return HELP;
  if (command === 'doctor') return internalReleaseDoctor(root, environment);
  if (command === 'prepare') return prepareLocalInternalNativeRelease({ root, bump: values['--bump'] });
  await assertReleaseConfiguration(root);
  if (command === 'build') {
    requireExternalFile(root, values['--credentials-file'], 'credentials.json');
    const clean = nativeReleaseCredentialFreeEnvironment(localInternalEnvironment(environment));
    const tooling = resolveNativeReleaseDeviceTooling(clean);
    if (!tooling.bundletoolJar) throw new Error('Set BUNDLETOOL_JAR before building.');
    return buildLocalInternalRelease({ root, credentialsFile: values['--credentials-file'], environment: nativeReleaseToolEnvironment(clean, tooling) });
  }
  const record = await verifyLocalInternalArtifacts({ root, environment });
  const { plan } = record;
  const serviceAccountFile = requireExternalFile(root, values['--service-account-file'], 'Play testing service account');
  const accessToken = await resolveGooglePlayAccessToken({ serviceAccountFile, environment: {} });
  const publisher = createGooglePlayPublisher({ applicationId: plan.applicationId, accessToken });
  const args = { root, plan, verification: record.verification, publisher };
  if (command === 'status') return inspectLocalNativePlayInternal(args);
  const result = await uploadLocalNativePlayInternal(args);
  const verified = await inspectLocalNativePlayInternal(args);
  return { ...result, ...verified };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runLocalInternalCli(process.argv.slice(2)).then((result) => {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (result?.ok === false) process.exitCode = 1;
  }).catch((error) => {
    console.error(`[native-internal] ${error.message}`);
    process.exitCode = 1;
  });
}
