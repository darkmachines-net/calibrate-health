/** @file Hosted native evidence schema validation, checkpoint collection, and source/artifact identity binding. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HOSTED_NATIVE_EVIDENCE_SCHEMA_VERSION = 1;

const HOSTED_NATIVE_CHECKPOINTS = Object.freeze({
  android: Object.freeze([
    'emulatorValidated',
    'backendReady',
    'metroReady',
    'onlineLog',
    'offlineQueue',
    'processDeathReplay',
    'exactlyOnceReplay',
    'processAlive',
    'crashClean'
  ]),
  wear: Object.freeze([
    'emulatorValidated',
    'nonDebuggable',
    'unpairedShell',
    'connectionDetail',
    'tilePresent',
    'permissionsMinimal',
    'defaultScale',
    'largeTextScale',
    'touchTargets',
    'namedActions',
    'withinScreen',
    'fontScaleRestored',
    'crashClean'
  ]),
  upgrade: Object.freeze([
    'emulatorsValidated',
    'disposableSigning',
    'baselineInstalled',
    'candidateInstalledWithReplace',
    'noUninstall',
    'noDataClear',
    'signerContinuous',
    'installTimePreserved',
    'versionAdvanced',
    'processAlive',
    'crashClean'
  ])
});

const LANE_STAGES = Object.freeze({
  android: Object.freeze([
    'initialized', 'emulator', 'backend', 'metro', 'online-log', 'offline-queue',
    'process-death-replay', 'exactly-once', 'completed'
  ]),
  wear: Object.freeze([
    'initialized', 'emulator', 'install', 'default-scale', 'large-text-scale',
    'package-contract', 'completed'
  ]),
  upgrade: Object.freeze([
    'initialized', 'emulators', 'build', 'baseline-install', 'candidate-upgrade',
    'verification', 'completed'
  ])
});

const ARTIFACT_IDS = Object.freeze({
  android: Object.freeze(['android-debug']),
  wear: Object.freeze(['wear-release']),
  upgrade: Object.freeze(['baseline-phone', 'baseline-wear', 'candidate-phone', 'candidate-wear'])
});

const TOP_LEVEL_FIELDS = Object.freeze([
  'schemaVersion', 'lane', 'sourceCommit', 'status', 'stage', 'emulators',
  'artifacts', 'checkpoints', 'wearAccessibility', 'upgrade'
]);
const EMULATOR_FIELDS = Object.freeze(['role', 'apiLevel', 'model', 'abi', 'physical']);
const ARTIFACT_FIELDS = Object.freeze([
  'id', 'packageName', 'versionName', 'versionCode', 'sha256', 'buildType', 'disposableSigning'
]);
const WEAR_ACCESSIBILITY_FIELDS = Object.freeze(['fontScales']);
const WEAR_SCALE_FIELDS = Object.freeze([
  'fontScale', 'screenWidthPx', 'screenHeightPx', 'densityDpi', 'actionCount',
  'minimumWidthDp', 'minimumHeightDp'
]);
const UPGRADE_FIELDS = Object.freeze([
  'baselineCommit', 'candidateCommit', 'baselineVersionCode', 'candidateVersionCode',
  'installMode', 'uninstallPerformed', 'dataCleared', 'signerEqual', 'installTimePreserved'
]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9 ._()+-]{1,80}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const PROHIBITED_KEY_PATTERN = /(serial|absolute|path|process.?id|pid|token|password|secret|account|email|health|food|xml|raw)/i;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...fields].sort().join('\n');
}

function collectPrivacyErrors(value, errors, location = 'evidence') {
  if (typeof value === 'string' && ABSOLUTE_PATH_PATTERN.test(value)) {
    errors.push(`${location} must not contain an absolute path.`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (PROHIBITED_KEY_PATTERN.test(key)) errors.push(`${location} contains prohibited field ${key}.`);
    collectPrivacyErrors(nested, errors, `${location}.${key}`);
  }
}

function validateEmulators(lane, emulators, status, errors) {
  if (!Array.isArray(emulators)) {
    errors.push('Hosted native emulators must be an array.');
    return;
  }
  const expectedRoles = lane === 'upgrade' ? ['phone', 'wear'] : [lane === 'android' ? 'phone' : 'wear'];
  if (status === 'passed' && emulators.length !== expectedRoles.length) {
    errors.push(`Hosted native ${lane} passed evidence requires every reviewed emulator role.`);
  }
  const roles = [];
  for (const emulator of emulators) {
    if (!exactFields(emulator, EMULATOR_FIELDS)) {
      errors.push('Hosted native emulator fields are invalid.');
      continue;
    }
    roles.push(emulator.role);
    if (!expectedRoles.includes(emulator.role)) errors.push(`Unexpected ${emulator.role} emulator for ${lane}.`);
    if (!Number.isSafeInteger(emulator.apiLevel) || emulator.apiLevel < 1) {
      errors.push('Hosted native emulator apiLevel must be a positive integer.');
    }
    if (!SAFE_TEXT_PATTERN.test(emulator.model ?? '') || !SAFE_TEXT_PATTERN.test(emulator.abi ?? '')) {
      errors.push('Hosted native emulator model and ABI must use bounded safe text.');
    }
    if (emulator.physical !== false) errors.push('Hosted native evidence must describe emulators only.');
  }
  if (emulators.length > 0 && roles.sort().join('\n') !== [...expectedRoles].sort().join('\n')) {
    errors.push(`Hosted native ${lane} evidence must contain exactly ${expectedRoles.join(' and ')} emulator roles.`);
  }
}

function validateArtifacts(lane, artifacts, status, errors) {
  if (!Array.isArray(artifacts)) {
    errors.push('Hosted native artifacts must be an array.');
    return;
  }
  const expectedIds = ARTIFACT_IDS[lane];
  if (status === 'passed' && artifacts.length !== expectedIds.length) {
    errors.push(`Hosted native ${lane} passed evidence requires every reviewed artifact.`);
  }
  const ids = [];
  for (const artifact of artifacts) {
    if (!exactFields(artifact, ARTIFACT_FIELDS)) {
      errors.push('Hosted native artifact fields are invalid.');
      continue;
    }
    ids.push(artifact.id);
    if (!expectedIds.includes(artifact.id)) errors.push(`Unexpected ${artifact.id} artifact for ${lane}.`);
    if (artifact.packageName !== 'net.darkmachines.healthtracker') {
      errors.push('Hosted native artifact packageName is invalid.');
    }
    if (!VERSION_PATTERN.test(artifact.versionName ?? '') ||
        !Number.isSafeInteger(artifact.versionCode) || artifact.versionCode < 1 ||
        !SHA256_PATTERN.test(artifact.sha256 ?? '')) {
      errors.push(`Hosted native artifact ${artifact.id} identity is invalid.`);
    }
    if (!['debug', 'release'].includes(artifact.buildType)) {
      errors.push(`Hosted native artifact ${artifact.id} buildType is invalid.`);
    }
    if (artifact.disposableSigning !== true) {
      errors.push(`Hosted native artifact ${artifact.id} must use disposable signing.`);
    }
  }
  if (artifacts.length > 0 && ids.sort().join('\n') !== [...expectedIds].sort().join('\n')) {
    errors.push(`Hosted native ${lane} evidence must contain exactly the reviewed artifact IDs.`);
  }
}

function validateCheckpoints(lane, checkpoints, status, errors) {
  const expected = HOSTED_NATIVE_CHECKPOINTS[lane];
  if (!exactFields(checkpoints, expected)) {
    errors.push(`Hosted native ${lane} checkpoint fields are invalid.`);
    return;
  }
  for (const checkpoint of expected) {
    if (typeof checkpoints[checkpoint] !== 'boolean') {
      errors.push(`Hosted native ${lane} checkpoint ${checkpoint} must be boolean.`);
    }
  }
  if (status === 'passed' && expected.some((checkpoint) => checkpoints[checkpoint] !== true)) {
    errors.push(`Hosted native ${lane} passed evidence requires every checkpoint.`);
  }
}

function validateWearAccessibility(lane, value, status, errors) {
  if (lane !== 'wear') {
    if (value !== null) errors.push('wearAccessibility is available only for the Wear lane.');
    return;
  }
  if (status !== 'passed' && value === null) return;
  if (!exactFields(value, WEAR_ACCESSIBILITY_FIELDS) || !Array.isArray(value.fontScales)) {
    errors.push('Wear accessibility summary fields are invalid.');
    return;
  }
  const scales = [];
  for (const row of value.fontScales) {
    if (!exactFields(row, WEAR_SCALE_FIELDS)) {
      errors.push('Wear accessibility scale fields are invalid.');
      continue;
    }
    scales.push(row.fontScale);
    for (const field of ['screenWidthPx', 'screenHeightPx', 'densityDpi', 'actionCount']) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 1) {
        errors.push(`Wear accessibility ${field} must be a positive integer.`);
      }
    }
    for (const field of ['minimumWidthDp', 'minimumHeightDp']) {
      if (!Number.isFinite(row[field]) || row[field] < 48) {
        errors.push(`Wear accessibility ${field} must be at least 48 dp.`);
      }
    }
  }
  if (scales.join(',') !== '1,1.3') errors.push('Wear accessibility must cover font scales 1 and 1.3 in order.');
}

function validateUpgradeSummary(lane, value, sourceCommit, status, errors) {
  if (lane !== 'upgrade') {
    if (value !== null) errors.push('upgrade summary is available only for the upgrade lane.');
    return;
  }
  if (status !== 'passed' && value === null) return;
  if (!exactFields(value, UPGRADE_FIELDS)) {
    errors.push('Hosted native upgrade summary fields are invalid.');
    return;
  }
  if (!COMMIT_PATTERN.test(value.baselineCommit ?? '') ||
      !COMMIT_PATTERN.test(value.candidateCommit ?? '') ||
      value.baselineCommit === value.candidateCommit || value.candidateCommit !== sourceCommit) {
    errors.push('Hosted native upgrade commits are invalid.');
  }
  if (!Number.isSafeInteger(value.baselineVersionCode) ||
      !Number.isSafeInteger(value.candidateVersionCode) ||
      value.baselineVersionCode < 1 || value.candidateVersionCode <= value.baselineVersionCode) {
    errors.push('Hosted native upgrade version codes are invalid.');
  }
  if (value.installMode !== 'adb-install-r' || value.uninstallPerformed !== false || value.dataCleared !== false ||
      value.signerEqual !== true || value.installTimePreserved !== true) {
    errors.push('Hosted native upgrade continuity contract is invalid.');
  }
}

/** Collects schema, identity, checkpoint, and artifact errors for a hosted native evidence record. */
export function validateHostedNativeEvidence(evidence) {
  const errors = [];
  if (!exactFields(evidence, TOP_LEVEL_FIELDS)) errors.push('Hosted native evidence fields are invalid.');
  const lane = evidence?.lane;
  if (!Object.hasOwn(HOSTED_NATIVE_CHECKPOINTS, lane)) errors.push('Hosted native evidence lane is invalid.');
  if (evidence?.schemaVersion !== HOSTED_NATIVE_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`Hosted native evidence schemaVersion must be ${HOSTED_NATIVE_EVIDENCE_SCHEMA_VERSION}.`);
  }
  if (!COMMIT_PATTERN.test(evidence?.sourceCommit ?? '')) errors.push('Hosted native sourceCommit is invalid.');
  if (!['started', 'passed', 'failed'].includes(evidence?.status)) errors.push('Hosted native evidence status is invalid.');
  if (!LANE_STAGES[lane]?.includes(evidence?.stage)) errors.push('Hosted native evidence stage is invalid.');
  if (Object.hasOwn(HOSTED_NATIVE_CHECKPOINTS, lane)) {
    validateEmulators(lane, evidence.emulators, evidence.status, errors);
    validateArtifacts(lane, evidence.artifacts, evidence.status, errors);
    validateCheckpoints(lane, evidence.checkpoints, evidence.status, errors);
    validateWearAccessibility(lane, evidence.wearAccessibility, evidence.status, errors);
    validateUpgradeSummary(lane, evidence.upgrade, evidence.sourceCommit, evidence.status, errors);
  }
  if (evidence?.status === 'passed' && evidence?.stage !== 'completed') {
    errors.push('Passed hosted native evidence must be at the completed stage.');
  }
  collectPrivacyErrors(evidence, errors);
  return errors;
}

/** Creates an initialized evidence record with every required lane checkpoint unset. */
export function createStartedHostedNativeEvidence(lane, sourceCommit) {
  const checkpoints = Object.fromEntries(HOSTED_NATIVE_CHECKPOINTS[lane]?.map((key) => [key, false]) ?? []);
  const evidence = {
    schemaVersion: HOSTED_NATIVE_EVIDENCE_SCHEMA_VERSION,
    lane,
    sourceCommit,
    status: 'started',
    stage: 'initialized',
    emulators: [],
    artifacts: [],
    checkpoints,
    wearAccessibility: null,
    upgrade: null
  };
  const errors = validateHostedNativeEvidence(evidence);
  if (errors.length) throw new Error(`Hosted native evidence is invalid:\n- ${errors.join('\n- ')}`);
  return evidence;
}

/** Validates and atomically writes hosted evidence through a temporary file. */
export function writeHostedNativeEvidence(file, evidence) {
  const errors = validateHostedNativeEvidence(evidence);
  if (errors.length) throw new Error(`Hosted native evidence is invalid:\n- ${errors.join('\n- ')}`);
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

/** Returns the SHA-256 digest of a local artifact's bytes. */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requiredOption(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

/** Parses the evidence initialization command and its lane, source, and destination options. */
export function parseHostedNativeEvidenceArgs(argv) {
  const [command, ...options] = argv;
  if (command !== 'init') throw new Error('Hosted native evidence command must be init.');
  const values = { command, lane: null, sourceCommit: null, output: null };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--lane') values.lane = requiredOption(options, index++, option);
    else if (option === '--source-commit') values.sourceCommit = requiredOption(options, index++, option);
    else if (option === '--output') values.output = requiredOption(options, index++, option);
    else throw new Error(`Unknown hosted native evidence option: ${option}`);
  }
  if (!values.lane || !values.sourceCommit || !values.output) {
    throw new Error('Hosted native evidence init requires --lane, --source-commit, and --output.');
  }
  return values;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseHostedNativeEvidenceArgs(process.argv.slice(2));
    const evidence = createStartedHostedNativeEvidence(args.lane, args.sourceCommit);
    writeHostedNativeEvidence(args.output, evidence);
    console.log(`Initialized ${args.lane} hosted native evidence: ${path.basename(args.output)}`);
  } catch (error) {
    console.error(`[hosted-native-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}