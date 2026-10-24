/** Validate source-bound, read-only release requests before privileged default-branch handlers execute. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateReconciliation } from './release-reconcile.mjs';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 4096;
const REQUEST_FILE = 'request.json';
const TOP_LEVEL_KEYS = Object.freeze([
  'head_branch',
  'head_sha',
  'inputs',
  'operation',
  'repository',
  'repository_id',
  'request_run_attempt',
  'request_run_id',
  'schema_version'
]);
const OPERATION_INPUT_KEYS = Object.freeze({
  'cut-release': ['bump', 'confirm_play_console_clean'],
  'publish-prepared-release': ['release_branch', 'release_commit'],
  'build-release-image': ['publish_latest', 'release_commit', 'release_tag']
});

/** Reject extra request fields before forwarding privileged workflow inputs. */
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(', ')}.`);
  }
}

/** Require an explicitly shaped identity at the artifact boundary. */
function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

/** Bind each request identity to its triggering Actions run. */
function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the triggering workflow run.`);
  }
}

/** Validate only the exact input shape permitted for this release operation. */
function validateInputs(operation, inputs) {
  const recordedRecovery = operation === 'publish-prepared-release' && Object.hasOwn(inputs ?? {}, 'release_id');
  const keys = recordedRecovery ? ['release_id', 'recovery_operation', 'confirm_play_console_clean', 'reconciliation'] : OPERATION_INPUT_KEYS[operation];
  if (!keys) throw new Error(`Unsupported release request operation: ${operation}.`);
  exactKeys(inputs, keys, 'release request inputs');
  if (operation === 'cut-release') {
    if (typeof inputs.confirm_play_console_clean !== 'boolean') throw new Error('Play Console coordination must be a boolean.');
    if (!['patch', 'minor', 'major'].includes(inputs.bump)) {
      throw new Error('Cut release bump must be patch, minor, or major.');
    }
  } else if (recordedRecovery) {
    requireString(inputs.release_id, 'release_id', /^[1-9]\d*$/);
    if (!['resume', 'reconcile', 'abandon'].includes(inputs.recovery_operation) || typeof inputs.confirm_play_console_clean !== 'boolean') throw new Error('Invalid recorded recovery operation or Console acknowledgement.');
    if (typeof inputs.reconciliation !== 'string') throw new Error('Reconciliation must be a string.');
    if (inputs.recovery_operation === 'reconcile') inputs.reconciliation = JSON.stringify(validateReconciliation(inputs.reconciliation));
    else if (inputs.reconciliation) throw new Error('Evidence is only accepted by reconcile.');
  } else if (operation === 'publish-prepared-release') {
    requireString(inputs.release_commit, 'release_commit', /^[0-9a-f]{40}$/);
    requireString(inputs.release_branch, 'release_branch', /^release\/v[0-9]+\.[0-9]+\.[0-9]+$/);
  } else {
    requireString(inputs.release_commit, 'release_commit', /^[0-9a-f]{40}$/);
    requireString(inputs.release_tag, 'release_tag', /^v[0-9]+\.[0-9]+\.[0-9]+$/);
    if (typeof inputs.publish_latest !== 'boolean') {
      throw new Error('publish_latest must be a JSON boolean.');
    }
  }
  return inputs;
}

/** Bind a read-only request to the exact protected source and originating run. */
export function verifyReleaseRequest(request, expected) {
  exactKeys(request, TOP_LEVEL_KEYS, 'release request');
  if (request.schema_version !== 1) throw new Error('Unsupported release request schema version.');
  requireString(request.operation, 'release request operation', /^[a-z-]+$/);
  requireString(request.repository, 'release request repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  requireString(request.repository_id, 'release request repository ID', /^[0-9]+$/);
  requireString(request.request_run_id, 'release request run ID', /^[0-9]+$/);
  requireString(request.request_run_attempt, 'release request run attempt', /^[1-9][0-9]*$/);
  requireString(request.head_branch, 'release request head branch', /^[A-Za-z0-9._/-]+$/);
  requireString(request.head_sha, 'release request head SHA', /^[0-9a-f]{40}$/);

  requireEqual(request.operation, expected.operation, 'release request operation');
  requireEqual(request.repository, expected.repository, 'release request repository');
  requireEqual(request.repository_id, expected.repositoryId, 'release request repository ID');
  requireEqual(request.request_run_id, expected.runId, 'release request run ID');
  requireEqual(request.request_run_attempt, expected.runAttempt, 'release request run attempt');
  requireEqual(request.head_branch, expected.headBranch, 'release request head branch');
  requireEqual(request.head_sha, expected.headSha, 'release request head SHA');
  return validateInputs(request.operation, request.inputs);
}

/** Require one bounded regular request file before parsing untrusted artifact content. */
export function verifyReleaseRequestArtifact({ artifactDirectory, ...expected }) {
  const directory = path.resolve(artifactDirectory);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== REQUEST_FILE || !entries[0].isFile()) {
    throw new Error(`Release request artifact must contain exactly one regular ${REQUEST_FILE} file.`);
  }
  const requestFile = path.join(directory, REQUEST_FILE);
  const stat = fs.lstatSync(requestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_REQUEST_BYTES) {
    throw new Error(`Release request ${REQUEST_FILE} must be a nonempty regular file of at most ${MAX_REQUEST_BYTES} bytes.`);
  }
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  } catch (error) {
    throw new Error(`Release request ${REQUEST_FILE} is not valid JSON: ${error.message}`, { cause: error });
  }
  return verifyReleaseRequest(request, expected);
}

/** Reject unknown or incomplete release CLI options before performing work. */
function parseArguments(argv) {
  if (argv[0] !== 'verify') throw new Error('Usage: release-request.mjs verify [options].');
  const allowed = new Set([
    '--artifact-directory', '--operation', '--repository', '--repository-id', '--run-id',
    '--run-attempt', '--head-branch', '--head-sha', '--github-output'
  ]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || !value || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete release request option: ${name ?? '(missing)'}.`);
    }
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate release request option: ${name}.`);
    values[name] = value;
  }
  for (const name of allowed) {
    if (!values[name]) throw new Error(`${name} is required.`);
  }
  return values;
}

/** Write validated scalar inputs for dependent workflow jobs. */
function appendOutputs(file, inputs) {
  for (const [name, value] of Object.entries(inputs)) {
    fs.appendFileSync(file, `${name}=${String(value)}\n`);
  }
}

/** Verify the request artifact before exposing any privileged workflow outputs. */
export function runReleaseRequestCli(argv = process.argv.slice(2)) {
  const values = parseArguments(argv);
  const inputs = verifyReleaseRequestArtifact({
    artifactDirectory: values['--artifact-directory'],
    operation: values['--operation'],
    repository: values['--repository'],
    repositoryId: values['--repository-id'],
    runId: values['--run-id'],
    runAttempt: values['--run-attempt'],
    headBranch: values['--head-branch'],
    headSha: values['--head-sha']
  });
  appendOutputs(values['--github-output'], inputs);
  return inputs;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runReleaseRequestCli();
  } catch (error) {
    console.error(`[release-request] ${error.message}`);
    process.exitCode = 1;
  }
}
