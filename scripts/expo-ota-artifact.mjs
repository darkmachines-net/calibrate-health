/** Verify exported OTA bytes and construct isolated publishers with an explicit fingerprint runtime. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const ARTIFACT_SCHEMA_VERSION = 2;
const ENVIRONMENT_ARTIFACT_KIND = 'calibrate-expo-ota-environment';
const UPDATE_ARTIFACT_KIND = 'calibrate-expo-ota-update';
const EAS_CLI_VERSION = '22.4.0';
const PROJECT = Object.freeze({
  name: 'Calibrate',
  slug: 'calibrate-health-app',
  owner: 'calibrate-health',
  androidPackage: 'net.darkmachines.healthtracker'
});
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUNTIME_VERSION_PATTERN = /^[a-f0-9]{40,64}$/;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PUBLIC_ENVIRONMENT_NAMES = Object.freeze([
  'EXPO_PUBLIC_CALIBRATE_SERVER_URL',
  'EXPO_PUBLIC_EAS_PROJECT_ID',
  'EXPO_UPDATES_CHANNEL'
]);

/** Require a value for the preceding CLI option. */
function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

/** Parse source-bound OTA artifact operations without executing application code. */
export function parseExpoOtaArtifactArgs(argv) {
  const values = {
    command: null,
    input: null,
    inputDir: null,
    output: null,
    outputDir: null,
    artifactRoot: null,
    publicConfig: null,
    packageLock: null,
    environmentArtifact: null,
    sourceCommit: null,
    runtimeFile: null,
    channel: null,
    environment: null,
    projectId: null,
    githubEnv: null,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (index === 0 && !option.startsWith('--')) values.command = option;
    else if (option === '--help' || option === '-h') values.help = true;
    else if (option === '--input') values.input = requiredValue(argv, index++, option);
    else if (option === '--input-dir') values.inputDir = requiredValue(argv, index++, option);
    else if (option === '--output') values.output = requiredValue(argv, index++, option);
    else if (option === '--output-dir') values.outputDir = requiredValue(argv, index++, option);
    else if (option === '--artifact-root') values.artifactRoot = requiredValue(argv, index++, option);
    else if (option === '--public-config') values.publicConfig = requiredValue(argv, index++, option);
    else if (option === '--package-lock') values.packageLock = requiredValue(argv, index++, option);
    else if (option === '--environment-artifact') values.environmentArtifact = requiredValue(argv, index++, option);
    else if (option === '--source-commit') values.sourceCommit = requiredValue(argv, index++, option);
    else if (option === '--runtime-file') values.runtimeFile = requiredValue(argv, index++, option);
    else if (option === '--channel') values.channel = requiredValue(argv, index++, option);
    else if (option === '--environment') values.environment = requiredValue(argv, index++, option);
    else if (option === '--project-id') values.projectId = requiredValue(argv, index++, option);
    else if (option === '--github-env') values.githubEnv = requiredValue(argv, index++, option);
    else throw new Error(`Unknown Expo OTA artifact option: ${option}`);
  }
  return values;
}

/** Require an explicitly shaped identity at the artifact boundary. */
function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

/** Validate exact source, Expo project, channel, and environment targeting. */
function validateTarget(target) {
  requireString(target.sourceCommit, 'OTA source commit', FULL_COMMIT_SHA_PATTERN);
  requireString(target.channel, 'EAS Update channel', CHANNEL_PATTERN);
  requireString(target.environment, 'EAS environment', ENVIRONMENT_PATTERN);
  requireString(target.projectId, 'EAS project ID', PROJECT_ID_PATTERN);
  return target;
}

/** Read EAS dotenv output without evaluating shell expressions. */
export function parseEasEnvironmentFile(contents) {
  const values = {};
  for (const originalLine of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    values[match[1]] = value;
  }
  return values;
}

/** Reject unsafe or unintended public server origins. */
function validateServerUrl(value, environment) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`EAS environment ${environment} does not define a safe EXPO_PUBLIC_CALIBRATE_SERVER_URL.`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`EAS environment ${environment} has an invalid Calibrate server URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`EAS environment ${environment} must use a credential-free HTTPS Calibrate server URL.`);
  }
  return value.trim();
}

/** Allow only public build configuration to cross into credential-free export jobs. */
export function selectPublicEasEnvironment(values, expected) {
  validateTarget(expected);
  const projectId = values.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  if (projectId !== expected.projectId) {
    throw new Error(
      `EAS environment ${expected.environment} targets project ${projectId || '<missing>'}, ` +
      `but this workflow targets ${expected.projectId}.`
    );
  }
  const channel = values.EXPO_UPDATES_CHANNEL?.trim();
  if (channel !== expected.channel) {
    throw new Error(
      `EAS environment ${expected.environment} targets channel ${channel || '<missing>'}, ` +
      `but this workflow targets ${expected.channel}.`
    );
  }
  return Object.freeze({
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: validateServerUrl(
      values.EXPO_PUBLIC_CALIBRATE_SERVER_URL,
      expected.environment
    ),
    EXPO_PUBLIC_EAS_PROJECT_ID: projectId,
    EXPO_UPDATES_CHANNEL: channel
  });
}

/** Hash exact bytes for reproducible artifact identity. */
function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

/** Hash canonical serialized evidence so metadata changes are detectable. */
function integrityFor(value) {
  return sha256(JSON.stringify(value));
}

/** Write deterministic JSON fixture or artifact content. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

/** Read canonical JSON; malformed input must stop release preparation. */
function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

/** Capture only reviewed public EAS configuration for an exact source and channel. */
export function createEnvironmentArtifact({ environmentFile, outputFile, ...target }) {
  validateTarget(target);
  const values = selectPublicEasEnvironment(
    parseEasEnvironmentFile(fs.readFileSync(environmentFile, 'utf8')),
    target
  );
  const payload = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    kind: ENVIRONMENT_ARTIFACT_KIND,
    sourceCommit: target.sourceCommit,
    channel: target.channel,
    environment: target.environment,
    projectId: target.projectId,
    values
  };
  const artifact = { ...payload, integrity: integrityFor(payload) };
  writeJson(outputFile, artifact);
  return artifact;
}

/** Reject artifacts produced for another source, environment, channel, or project. */
function assertExactTarget(artifact, expected) {
  validateTarget(expected);
  for (const name of ['sourceCommit', 'channel', 'environment', 'projectId']) {
    if (artifact[name] !== expected[name]) {
      throw new Error(`OTA artifact ${name} ${artifact[name] ?? '<missing>'} does not match ${expected[name]}.`);
    }
  }
}

/** Validate the public configuration handoff before exporting application source. */
export function verifyEnvironmentArtifact({ artifactFile, githubEnv = null, ...expected }) {
  const artifact = readJson(artifactFile, 'Expo OTA environment artifact');
  if (artifact.schemaVersion !== ARTIFACT_SCHEMA_VERSION || artifact.kind !== ENVIRONMENT_ARTIFACT_KIND) {
    throw new Error('Expo OTA environment artifact has an unsupported schema or kind.');
  }
  const { integrity, ...payload } = artifact;
  if (!/^[0-9a-f]{64}$/.test(integrity ?? '') || integrityFor(payload) !== integrity) {
    throw new Error('Expo OTA environment artifact integrity verification failed.');
  }
  assertExactTarget(artifact, expected);
  const selected = selectPublicEasEnvironment(artifact.values ?? {}, expected);
  if (Object.keys(artifact.values ?? {}).sort().join('\n') !== [...PUBLIC_ENVIRONMENT_NAMES].sort().join('\n')) {
    throw new Error('Expo OTA environment artifact contains values outside the reviewed public allowlist.');
  }
  if (githubEnv) {
    const lines = PUBLIC_ENVIRONMENT_NAMES.map((name) => `${name}=${selected[name]}`);
    fs.appendFileSync(githubEnv, `${lines.join('\n')}\n`);
  }
  return Object.freeze({ ...artifact, values: selected });
}

/** Keep artifact paths inside their assigned export root. */
function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} is not a safe artifact-relative path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} is not a safe artifact-relative path.`);
  }
  return value;
}

/** Normalize Expo asset paths without accepting absolute or traversing paths. */
function normalizedExpoMetadataPath(value, label) {
  const platformPath = path.sep === '\\' && typeof value === 'string'
    ? value.replaceAll('\\', '/')
    : value;
  return safeRelativePath(platformPath, label);
}

/** Enumerate regular export files while rejecting symbolic links. */
function listFiles(root, relative = '') {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelativePath(childRelative, 'Exported OTA file');
    const child = path.join(directory, entry.name);
    const status = fs.lstatSync(child);
    if (status.isSymbolicLink()) throw new Error(`Exported OTA artifact may not contain symlink ${childRelative}.`);
    if (status.isDirectory()) files.push(...listFiles(root, childRelative));
    else if (status.isFile()) {
      const contents = fs.readFileSync(child);
      files.push({ path: childRelative, size: contents.length, sha256: sha256(contents) });
    } else {
      throw new Error(`Exported OTA artifact contains unsupported file type ${childRelative}.`);
    }
  }
  return files;
}

/** Verify the Android bundle and every declared asset before retention. */
function validateExpoExport(inputDir) {
  const metadata = readJson(path.join(inputDir, 'metadata.json'), 'Expo export metadata');
  if (metadata.version !== 0 || metadata.bundler !== 'metro') {
    throw new Error('Expo export metadata must be Metro schema version 0.');
  }
  const platforms = Object.keys(metadata.fileMetadata ?? {});
  if (platforms.length !== 1 || platforms[0] !== 'android') {
    throw new Error('Expo OTA export must contain exactly the Android platform.');
  }
  const android = metadata.fileMetadata.android;
  const referenced = [android?.bundle, ...(android?.assets ?? []).map((asset) => asset?.path)];
  for (const [index, relative] of referenced.entries()) {
    const normalizedRelative = normalizedExpoMetadataPath(relative, `Expo export metadata path ${index}`);
    const absolute = path.resolve(inputDir, ...normalizedRelative.split('/'));
    const relativeToRoot = path.relative(path.resolve(inputDir), absolute);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Expo export metadata references missing or external file ${normalizedRelative}.`);
    }
  }
  for (const asset of android?.assets ?? []) {
    if (typeof asset?.ext !== 'string' || !/^\.?[A-Za-z0-9]+$/.test(asset.ext)) {
      throw new Error('Expo export metadata contains an invalid asset extension.');
    }
  }
  return metadata;
}

/** Read the exact installed package version from the producing lockfile. */
function resolvedPackageVersion(packageLock, packageName) {
  const entry = packageLock.packages?.[`node_modules/${packageName}`];
  if (!entry || !SEMVER_PATTERN.test(entry.version ?? '')) {
    throw new Error(`Root lockfile does not contain an exact ${packageName} package version.`);
  }
  return entry.version;
}

/** Validate public Expo identity and runtime policy without evaluating source. */
function readReviewedPublicConfig(file, target) {
  const raw = readJson(file, 'Expo public config');
  const config = raw.expo && typeof raw.expo === 'object' ? raw.expo : raw;
  const failures = [
    ['name', config.name, PROJECT.name],
    ['slug', config.slug, PROJECT.slug],
    ['owner', config.owner, PROJECT.owner],
    ['android.package', config.android?.package, PROJECT.androidPackage],
    ['extra.eas.projectId', config.extra?.eas?.projectId, target.projectId],
    ['updates.url', config.updates?.url, `https://u.expo.dev/${target.projectId}`],
    ['updates.requestHeaders.expo-channel-name', config.updates?.requestHeaders?.['expo-channel-name'], target.channel]
  ].filter(([, actual, expected]) => actual !== expected);
  if (failures.length) {
    throw new Error(`Expo public config target mismatch: ${failures.map(([name]) => name).join(', ')}.`);
  }
  if (!SEMVER_PATTERN.test(config.version ?? '') || !SEMVER_PATTERN.test(config.sdkVersion ?? '')) {
    throw new Error('Expo public config must contain exact app and SDK versions.');
  }
  if (config.runtimeVersion?.policy !== 'fingerprint') {
    throw new Error('Expo public config must use the fingerprint runtime policy.');
  }
  return Object.freeze({
    appVersion: config.version,
    sdkVersion: config.sdkVersion
  });
}

/** Package exact exported files with runtime and source provenance. */
export function createUpdateArtifact({
  inputDir,
  outputDir,
  publicConfigFile,
  packageLockFile,
  environmentArtifactFile,
  runtimeFile,
  ...target
}) {
  validateTarget(target);
  verifyEnvironmentArtifact({ artifactFile: environmentArtifactFile, ...target });
  const environmentArtifact = readJson(environmentArtifactFile, 'Expo OTA environment artifact');
  const publicConfig = readReviewedPublicConfig(publicConfigFile, target);
  const packageLock = readJson(packageLockFile, 'root package lock');
  const sourceDirectory = path.resolve(inputDir);
  if (!fs.statSync(sourceDirectory).isDirectory()) throw new Error('Expo export input must be a directory.');
  validateExpoExport(sourceDirectory);
  const files = listFiles(sourceDirectory);
  if (!files.length) throw new Error('Expo OTA export is empty.');
  const payload = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    kind: UPDATE_ARTIFACT_KIND,
    sourceCommit: target.sourceCommit,
    runtimeVersion: requireString(readJson(runtimeFile, 'resolved Expo runtime').runtimeVersion, 'Expo runtime', RUNTIME_VERSION_PATTERN),
    channel: target.channel,
    environment: target.environment,
    projectId: target.projectId,
    serverUrl: environmentArtifact.values.EXPO_PUBLIC_CALIBRATE_SERVER_URL,
    appVersion: publicConfig.appVersion,
    sdkVersion: publicConfig.sdkVersion,
    expoVersion: resolvedPackageVersion(packageLock, 'expo'),
    expoUpdatesVersion: resolvedPackageVersion(packageLock, 'expo-updates'),
    project: PROJECT,
    environmentIntegrity: environmentArtifact.integrity,
    bundleIntegrity: integrityFor(files),
    files
  };
  const provenance = { ...payload, integrity: integrityFor(payload) };
  const destination = path.resolve(outputDir);
  if (fs.existsSync(destination)) throw new Error('Expo OTA artifact output directory already exists.');
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(sourceDirectory, path.join(destination, 'bundle'), {
    recursive: true,
    dereference: false,
    errorOnExist: true
  });
  writeJson(path.join(destination, 'provenance.json'), provenance);
  return provenance;
}

/** Recompute export hashes and require the caller’s exact publication target. */
export function verifyUpdateArtifact({ artifactRoot, ...expected }) {
  validateTarget(expected);
  const root = path.resolve(artifactRoot);
  const rootEntries = fs.readdirSync(root).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(['bundle', 'provenance.json'])) {
    throw new Error('Expo OTA artifact root must contain exactly bundle and provenance.json.');
  }
  const bundleStatus = fs.lstatSync(path.join(root, 'bundle'));
  const provenanceStatus = fs.lstatSync(path.join(root, 'provenance.json'));
  if (bundleStatus.isSymbolicLink() || !bundleStatus.isDirectory() ||
      provenanceStatus.isSymbolicLink() || !provenanceStatus.isFile()) {
    throw new Error('Expo OTA artifact root contains an unsupported file type or symlink.');
  }
  const provenance = readJson(path.join(root, 'provenance.json'), 'Expo OTA provenance');
  if (provenance.schemaVersion !== ARTIFACT_SCHEMA_VERSION || provenance.kind !== UPDATE_ARTIFACT_KIND) {
    throw new Error('Expo OTA provenance has an unsupported schema or kind.');
  }
  const { integrity, ...payload } = provenance;
  if (!/^[0-9a-f]{64}$/.test(integrity ?? '') || integrityFor(payload) !== integrity) {
    throw new Error('Expo OTA provenance integrity verification failed.');
  }
  assertExactTarget(provenance, expected);
  if (JSON.stringify(provenance.project) !== JSON.stringify(PROJECT)) {
    throw new Error('Expo OTA provenance has an unexpected project identity.');
  }
  for (const [label, value] of [
    ['app version', provenance.appVersion],
    ['SDK version', provenance.sdkVersion],
    ['Expo version', provenance.expoVersion],
    ['Expo Updates version', provenance.expoUpdatesVersion]
  ]) {
    requireString(value, label, SEMVER_PATTERN);
  }
  requireString(provenance.runtimeVersion, 'Expo runtime', RUNTIME_VERSION_PATTERN);
  validateServerUrl(provenance.serverUrl, provenance.environment);
  const bundleRoot = path.join(root, 'bundle');
  validateExpoExport(bundleRoot);
  const actualFiles = listFiles(bundleRoot);
  if (integrityFor(actualFiles) !== provenance.bundleIntegrity ||
      JSON.stringify(actualFiles) !== JSON.stringify(provenance.files)) {
    throw new Error('Expo OTA bundle file integrity verification failed.');
  }
  return provenance;
}

/** Refuse to merge publisher files into an existing workspace. */
function requireAbsentDirectory(directory) {
  const destination = path.resolve(directory);
  if (fs.existsSync(destination)) throw new Error(`Publisher project directory already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: true });
  return destination;
}

/** Create an inert publishing project that never imports application source. */
function writePublisherFiles(destination, config, packageJson = { private: true }) {
  writeJson(path.join(destination, 'app.json'), { expo: config });
  writeJson(path.join(destination, 'package.json'), {
    name: '@calibrate/expo-ota-publisher',
    version: '0.0.0',
    ...packageJson
  });
  writeJson(path.join(destination, 'eas.json'), {
    cli: { version: EAS_CLI_VERSION }
  });
}

/** Prepare a minimal project for isolated EAS environment resolution. */
export function createEnvironmentPublisherProject({ outputDir, projectId }) {
  requireString(projectId, 'EAS project ID', PROJECT_ID_PATTERN);
  const destination = requireAbsentDirectory(outputDir);
  writePublisherFiles(destination, {
    name: PROJECT.name,
    slug: PROJECT.slug,
    owner: PROJECT.owner,
    extra: { eas: { projectId } }
  });
  return destination;
}

/** Prepare an isolated publisher with the exact recorded runtime string. */
export function createUpdatePublisherProject({ outputDir, artifactRoot, ...expected }) {
  const provenance = verifyUpdateArtifact({ artifactRoot, ...expected });
  const destination = requireAbsentDirectory(outputDir);
  writePublisherFiles(destination, {
    name: PROJECT.name,
    slug: PROJECT.slug,
    owner: PROJECT.owner,
    version: provenance.appVersion,
    sdkVersion: provenance.sdkVersion,
    runtimeVersion: provenance.runtimeVersion,
    updates: {
      url: `https://u.expo.dev/${provenance.projectId}`,
      requestHeaders: { 'expo-channel-name': provenance.channel }
    },
    android: { package: PROJECT.androidPackage },
    extra: { eas: { projectId: provenance.projectId } }
  }, {
    private: true,
    dependencies: { 'expo-updates': provenance.expoUpdatesVersion }
  });
  return { destination, provenance };
}

/** Show supported commands without reading credentials or performing release work. */
function printHelp() {
  process.stdout.write(`Usage: node scripts/expo-ota-artifact.mjs <command> [options]\n\n` +
    'Commands:\n' +
    '  prepare-environment-project  Create a fixed source-free project for eas env:pull\n' +
    '  sanitize-environment         Keep only validated public EAS build variables\n' +
    '  verify-environment           Verify environment provenance and optionally write GITHUB_ENV\n' +
    '  package-update               Package a pre-exported Android OTA bundle with SHA-256 provenance\n' +
    '  verify-update                Verify the exact inert update artifact\n' +
    '  prepare-publisher            Create a fixed source-free EAS publisher project\n');
}

/** Require all inputs for the selected artifact operation. */
function requiredOptions(config, names) {
  for (const name of names) {
    if (!config[name]) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  }
}

/** Dispatch artifact validation and packaging through explicit CLI inputs. */
export function runExpoOtaArtifactCli(config = parseExpoOtaArtifactArgs(process.argv.slice(2))) {
  if (config.help) {
    printHelp();
    return { help: true };
  }
  const targetNames = ['sourceCommit', 'channel', 'environment', 'projectId'];
  if (config.command === 'prepare-environment-project') {
    requiredOptions(config, ['outputDir', 'projectId']);
    return createEnvironmentPublisherProject(config);
  }
  if (config.command === 'sanitize-environment') {
    requiredOptions(config, ['input', 'output', ...targetNames]);
    return createEnvironmentArtifact({ environmentFile: config.input, outputFile: config.output, ...config });
  }
  if (config.command === 'verify-environment') {
    requiredOptions(config, ['environmentArtifact', ...targetNames]);
    return verifyEnvironmentArtifact({
      artifactFile: config.environmentArtifact,
      githubEnv: config.githubEnv,
      ...config
    });
  }
  if (config.command === 'package-update') {
    requiredOptions(config, [
      'inputDir', 'outputDir', 'publicConfig', 'packageLock', 'environmentArtifact',
      ...targetNames, 'runtimeFile'
    ]);
    return createUpdateArtifact({
      inputDir: config.inputDir,
      outputDir: config.outputDir,
      publicConfigFile: config.publicConfig,
      packageLockFile: config.packageLock,
      environmentArtifactFile: config.environmentArtifact,
      runtimeFile: config.runtimeFile,
      ...config
    });
  }
  if (config.command === 'verify-update') {
    requiredOptions(config, ['artifactRoot', ...targetNames]);
    return verifyUpdateArtifact(config);
  }
  if (config.command === 'prepare-publisher') {
    requiredOptions(config, ['artifactRoot', 'outputDir', ...targetNames]);
    return createUpdatePublisherProject(config);
  }
  throw new Error(`Unknown Expo OTA artifact command: ${config.command ?? '<missing>'}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runExpoOtaArtifactCli();
  } catch (error) {
    console.error(`[expo-ota-artifact] ${error.message}`);
    process.exitCode = 1;
  }
}

export { repositoryRoot };
