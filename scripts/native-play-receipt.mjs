/** @file Canonical phone/watch Play publication receipts and exact protected workflow attestation verification. */

/** Canonical historical Play receipts and protected-workflow trust checks for retained releases. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const APPLICATION_ID_PATTERN = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const TAG_PATTERN = /^native-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLAY_APPLICATION_ID = 'net.darkmachines.healthtracker';
const PLAY_TRACKS = Object.freeze({ phone: 'internal', watch: 'wear:internal' });
const ATTEST_ACTION_PIN = 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d';

export const NATIVE_PLAY_RECEIPT_PATH = 'build/native-play-receipt.json';
export const NATIVE_PLAY_RECEIPT_CRITICAL_PATHS = Object.freeze([
  '.github/workflows/native-release.yml',
  'scripts/native-play-receipt.mjs',
  'scripts/native-play-release.mjs',
  'scripts/native-release-build.mjs',
  'scripts/native-release-devices.mjs',
  'scripts/native-release-evidence.mjs',
  'scripts/native-ota-contract.mjs',
  'scripts/native-tag-attestation.mjs',
  'scripts/release-config.mjs',
  'mobile/plugins/nativeReleaseGradleWrapper.js',
  'mobile/plugins/withPinnedGradleWrapper.js'
]);

/** Reject missing or noncanonical receipt identifiers before serialization. */
function requireText(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

/** Admit only positive version codes within Play's supported range. */
function requireVersionCode(value, role) {
  const code = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error(`${role} Play version code is malformed.`);
  }
  return code;
}

/** Bind each binary hash to its exact track and odd/even code lane. */
function releaseValues(values, role) {
  const input = values?.releases?.[role] ?? {};
  const track = requireText(input.track, /^[a-z][a-z0-9:.-]*$/, `${role} Play track`);
  if (track !== PLAY_TRACKS[role]) {
    throw new Error(`${role} Play receipt track must be ${PLAY_TRACKS[role]}.`);
  }
  const versionCode = requireVersionCode(input.version_code ?? input.versionCode, role);
  if (role === 'phone' ? versionCode % 2 !== 1 : versionCode % 2 !== 0) {
    throw new Error(`${role} Play receipt version code is in the wrong parity lane.`);
  }
  return Object.freeze({
    track,
    version_code: versionCode,
    aab_sha256: requireText(
      input.aab_sha256 ?? input.aabSha256 ?? input.sha256,
      SHA256_PATTERN,
      `${role} AAB SHA-256`
    )
  });
}

/** Normalize historical release evidence into the single accepted receipt schema. */
export function createNativePlayReceipt(values) {
  const repository = requireText(values?.repository, REPOSITORY_PATTERN, 'GitHub repository');
  const applicationId = requireText(
    values?.application_id ?? values?.applicationId,
    APPLICATION_ID_PATTERN,
    'Native Play application ID'
  );
  if (applicationId !== PLAY_APPLICATION_ID) {
    throw new Error(`Native Play receipt application ID must be ${PLAY_APPLICATION_ID}.`);
  }
  const sourceCommit = requireText(
    values?.source_commit ?? values?.sourceCommit,
    COMMIT_PATTERN,
    'Native Play source commit'
  );
  const nativeTag = requireText(
    values?.native_release_tag ?? values?.nativeTag,
    TAG_PATTERN,
    'Native release tag'
  );
  const nativeVersion = requireText(
    values?.version_name ?? values?.nativeVersion,
    VERSION_PATTERN,
    'Native release version'
  );
  if (nativeTag !== `native-v${nativeVersion}`) {
    throw new Error('Native Play receipt tag and version do not match.');
  }
  const phone = releaseValues(values, 'phone');
  const watch = releaseValues(values, 'watch');
  if (phone.version_code === watch.version_code) {
    throw new Error('Native Play receipt phone and watch version codes must be distinct.');
  }
  return Object.freeze({
    schema_version: 1,
    attestation_epoch: 1,
    repository,
    application_id: applicationId,
    source_commit: sourceCommit,
    native_release_tag: nativeTag,
    version_name: nativeVersion,
    releases: Object.freeze({ phone, watch })
  });
}

/** Convert the historical paired build plan into canonical receipt fields. */
export function createNativePlayReceiptFromPlan({ repository, plan, releases }) {
  return createNativePlayReceipt({
    repository,
    applicationId: plan?.applicationId,
    sourceCommit: plan?.sourceCommit,
    nativeTag: `native-v${plan?.versionName ?? ''}`,
    nativeVersion: plan?.versionName,
    releases: {
      phone: {
        track: plan?.candidates?.phone?.internalTrack,
        versionCode: plan?.candidates?.phone?.versionCode,
        aabSha256: releases?.phone?.aab_sha256 ?? releases?.phone?.aabSha256 ?? releases?.phone?.sha256
      },
      watch: {
        track: plan?.candidates?.watch?.internalTrack,
        versionCode: plan?.candidates?.watch?.versionCode,
        aabSha256: releases?.watch?.aab_sha256 ?? releases?.watch?.aabSha256 ?? releases?.watch?.sha256
      }
    }
  });
}

/** Preserve byte-identical JSON for hashing and attestation verification. */
export function serializeNativePlayReceipt(values) {
  return `${JSON.stringify(createNativePlayReceipt(values), null, 2)}\n`;
}

/** Hash canonical values or already serialized receipt bytes without rewriting them. */
export function nativePlayReceiptSha256(values) {
  const bytes = typeof values === 'string' || Buffer.isBuffer(values)
    ? values
    : serializeNativePlayReceipt(values);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Bound receipt reads and reject symlinks or non-file inputs. */
function readRegularFile(file, maximumBytes, label) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a non-empty regular file of at most ${maximumBytes} bytes.`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/** Reject valid JSON that does not use the canonical attested encoding. */
export function parseNativePlayReceipt(contents) {
  if (typeof contents !== 'string') throw new Error('Native Play receipt must be UTF-8 text.');
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error('Native Play receipt is not valid JSON.', { cause: error });
  }
  const receipt = createNativePlayReceipt(parsed);
  if (contents !== serializeNativePlayReceipt(receipt)) {
    throw new Error('Native Play receipt bytes are not the canonical reviewed encoding.');
  }
  return receipt;
}

/** Require exact expected source, versions, tracks, and artifact hashes. */
export function verifyNativePlayReceiptBytes(contents, expectedValues) {
  const expected = serializeNativePlayReceipt(expectedValues);
  if (contents !== expected) {
    throw new Error('Native Play receipt bytes do not match the exact expected source and Play artifacts.');
  }
  return Object.freeze({ receipt: parseNativePlayReceipt(contents), sha256: nativePlayReceiptSha256(contents) });
}

/** Read a bounded canonical receipt from disk. */
export function readNativePlayReceipt(file) {
  return parseNativePlayReceipt(readRegularFile(file, 16 * 1024, 'Native Play receipt'));
}

/** Compare a retained receipt file with independently reconstructed evidence. */
export function verifyNativePlayReceiptFile(file, expectedValues) {
  const actual = readRegularFile(file, 16 * 1024, 'Native Play receipt');
  return verifyNativePlayReceiptBytes(actual, expectedValues);
}

/** Hash a nonempty regular binary while rejecting symlink inputs. */
function sha256RegularFile(file, label) {
  const resolved = path.resolve(file);
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(resolved);
    bytes = fs.readFileSync(resolved);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`${label} must be a non-empty regular file.`);
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Check both AABs against the exact receipt digest admitted by the attester. */
export function verifyNativePlayReceiptArtifacts({ receiptFile, expectedReceiptSha256, phoneAab, watchAab }) {
  const receiptBytes = readRegularFile(receiptFile, 16 * 1024, 'Native Play receipt');
  const receipt = parseNativePlayReceipt(receiptBytes);
  const receiptSha256 = nativePlayReceiptSha256(receiptBytes);
  if (receiptSha256 !== requireText(expectedReceiptSha256, SHA256_PATTERN, 'Native Play receipt SHA-256')) {
    throw new Error('Native Play receipt SHA-256 does not match the build output admitted by the attester.');
  }
  for (const [role, file] of [['phone', phoneAab], ['watch', watchAab]]) {
    const actual = sha256RegularFile(file, `${role} AAB`);
    if (actual !== receipt.releases[role].aab_sha256) {
      throw new Error(`${role} AAB SHA-256 does not match the canonical Native Play receipt.`);
    }
  }
  return Object.freeze({ receipt, sha256: receiptSha256 });
}

/** Parse explicit protected-master signer retention and revocation directives. */
export function parseNativePlayWorkflowTrustSet(contents) {
  if (typeof contents !== 'string') throw new Error('Native Play workflow trust set must be text.');
  const allowed = [];
  const revoked = [];
  const seen = new Set();
  for (const [index, rawLine] of contents.replaceAll('\r\n', '\n').split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(allow|revoke) ([0-9a-f]{40})$/);
    if (!match) {
      throw new Error(
        `Native Play workflow trust set line ${index + 1} must be "allow SHA" or "revoke SHA" with one full lowercase commit SHA.`
      );
    }
    const [, disposition, revision] = match;
    if (seen.has(revision)) throw new Error(`Native Play workflow trust set repeats ${revision}.`);
    seen.add(revision);
    (disposition === 'allow' ? allowed : revoked).push(revision);
  }
  return Object.freeze({ allowed: Object.freeze(allowed), revoked: Object.freeze(revoked) });
}

/** Extract signer revisions only from matching protected GitHub attestation certificates. */
export function parseNativePlayAttestationWorkflowCandidates(contents, repository, expectedSourceCommit) {
  requireText(repository, REPOSITORY_PATTERN, 'GitHub repository');
  const source = requireText(expectedSourceCommit, COMMIT_PATTERN, 'Native Play source commit');
  let results;
  try {
    results = JSON.parse(contents);
  } catch (error) {
    throw new Error('GitHub attestation verification output is not valid JSON.', { cause: error });
  }
  if (!Array.isArray(results) || results.length < 1 || results.length > 100) {
    throw new Error('GitHub attestation verification must return between 1 and 100 results.');
  }
  const repositoryUri = `https://github.com/${repository}`;
  const workflowUri = `${repositoryUri}/.github/workflows/native-release.yml@refs/heads/master`;
  const revisions = [];
  const seen = new Set();
  for (const result of results) {
    const certificate = result?.verificationResult?.signature?.certificate;
    const revision = certificate?.buildSignerDigest;
    if (
      revision !== source
      || certificate?.sourceRepositoryDigest !== source
      || certificate?.buildConfigDigest !== source
      || certificate?.githubWorkflowSHA !== source
      || certificate?.buildSignerURI !== workflowUri
      || certificate?.buildConfigURI !== workflowUri
      || certificate?.sourceRepositoryURI !== repositoryUri
      || certificate?.sourceRepositoryRef !== 'refs/heads/master'
      || certificate?.runnerEnvironment !== 'github-hosted'
    ) {
      throw new Error('GitHub attestation certificate does not match the original protected native release workflow identity.');
    }
    if (!seen.has(revision)) {
      seen.add(revision);
      revisions.push(revision);
    }
  }
  return Object.freeze(revisions);
}

/** Prevent inherited Git configuration from redirecting trust-history inspection. */
function sanitizedGitEnvironment(environment) {
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      key === 'GIT_DIR'
      || key === 'GIT_WORK_TREE'
      || key === 'GIT_COMMON_DIR'
      || key === 'GIT_OBJECT_DIRECTORY'
      || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
      || key === 'GIT_CONFIG'
      || key === 'GIT_CONFIG_COUNT'
      || key === 'GIT_CONFIG_PARAMETERS'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) continue;
    sanitized[key] = value;
  }
  return {
    ...sanitized,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C'
  };
}

/** Inspect literal repository objects with replacement objects and prompting disabled. */
function runGit(root, args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: sanitizedGitEnvironment(process.env),
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/** Require a full commit object rather than an alias or other object type. */
function requireGitCommit(git, root, revision, label) {
  const resolved = git(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (resolved !== revision || !COMMIT_PATTERN.test(resolved)) throw new Error(`${label} is not one exact commit.`);
}

/** Keep historical attesters on the current protected master history. */
function requireAncestor(git, root, ancestor, descendant) {
  try {
    git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
  } catch (error) {
    throw new Error(`Native Play attestation signer ${ancestor} is not on protected master history.`, { cause: error });
  }
}

/** Resolve the reviewed files that define historical receipt verification behavior. */
function readCriticalBlobIds(git, root, revision) {
  return NATIVE_PLAY_RECEIPT_CRITICAL_PATHS.map((relativePath) => {
    const blob = git(root, ['rev-parse', '--verify', `${revision}:${relativePath}`]);
    if (!COMMIT_PATTERN.test(blob)) {
      throw new Error(`Native Play attestation signer ${revision} has malformed critical blob ${relativePath}.`);
    }
    return blob;
  });
}

/** Refuse historical signers that predate canonical receipt attestation. */
function hasPostHardeningMarker(git, root, revision) {
  try {
    const workflow = git(root, ['show', `${revision}:.github/workflows/native-release.yml`]);
    const receipt = git(root, ['show', `${revision}:scripts/native-play-receipt.mjs`]);
    git(root, ['show', `${revision}:.github/native-play-attestation-trusted-workflow-shas`]);
    return workflow.includes(ATTEST_ACTION_PIN)
      && workflow.includes('attest-play-receipt:')
      && workflow.includes('Verify exact native Play receipt attestation')
      && receipt.includes('version_name')
      && receipt.includes('aab_sha256');
  } catch {
    return false;
  }
}

/** Apply current-master revocations before admitting an unchanged or explicitly retained signer. */
export function authorizeNativePlayReceiptWorkflow({
  repositoryRoot,
  trustSet,
  candidateWorkflowRevision,
  currentWorkflowRevision,
  trustedMasterCommit,
  sourceCommit,
  git = runGit
}) {
  const candidate = requireText(candidateWorkflowRevision, COMMIT_PATTERN, 'Candidate native Play workflow revision');
  const current = requireText(currentWorkflowRevision, COMMIT_PATTERN, 'Current native Play workflow revision');
  const master = requireText(trustedMasterCommit, COMMIT_PATTERN, 'Trusted master commit');
  const source = requireText(sourceCommit, COMMIT_PATTERN, 'Native Play source commit');
  if (candidate !== source) {
    throw new Error('Native Play attestation signer must equal the original source commit.');
  }
  const parsedTrust = typeof trustSet === 'string' ? parseNativePlayWorkflowTrustSet(trustSet) : trustSet;
  if (!parsedTrust || !Array.isArray(parsedTrust.allowed) || !Array.isArray(parsedTrust.revoked)) {
    throw new Error('Native Play workflow trust set is malformed.');
  }
  if (parsedTrust.revoked.includes(candidate)) {
    throw new Error(`Native Play attestation signer ${candidate} is explicitly revoked by current protected master.`);
  }
  for (const [revision, label] of [
    [candidate, 'Candidate native Play workflow revision'],
    [current, 'Current native Play workflow revision'],
    [master, 'Trusted master commit'],
    [source, 'Native Play source commit']
  ]) requireGitCommit(git, repositoryRoot, revision, label);
  if (current !== master) {
    throw new Error('Current native Play workflow revision must equal freshly resolved protected master.');
  }
  requireAncestor(git, repositoryRoot, candidate, master);
  if (!hasPostHardeningMarker(git, repositoryRoot, candidate)) {
    throw new Error(`Native Play attestation signer ${candidate} predates the reviewed receipt hardening marker.`);
  }
  if (candidate === current) return Object.freeze({ candidate, mode: 'current-workflow' });
  if (parsedTrust.allowed.includes(candidate)) return Object.freeze({ candidate, mode: 'explicit-retained' });
  let candidateBlobs;
  let currentBlobs;
  try {
    candidateBlobs = readCriticalBlobIds(git, repositoryRoot, candidate);
    currentBlobs = readCriticalBlobIds(git, repositoryRoot, current);
  } catch (error) {
    throw new Error(`Native Play attestation signer ${candidate} lacks the reviewed critical tooling set.`, { cause: error });
  }
  if (candidateBlobs.every((blob, index) => blob === currentBlobs[index])) {
    return Object.freeze({ candidate, mode: 'unchanged-critical-tooling' });
  }
  throw new Error(
    `Native Play attestation signer ${candidate} changed critical tooling and is not explicitly retained.`
  );
}

/** Validate the historical CLI's command-specific, nonduplicated options. */
function parseArguments(args) {
  const command = args[0];
  if (![
    'authorize-workflow', 'create', 'discover-workflows', 'trusted-workflows', 'verify', 'verify-files'
  ].includes(command)) {
    throw new Error(
      'Expected command: authorize-workflow, create, discover-workflows, trusted-workflows, verify, or verify-files.'
    );
  }
  let allowed;
  if (command === 'verify-files') {
    allowed = new Set(['--receipt-file', '--expected-receipt-sha256', '--phone-aab', '--watch-aab']);
  } else if (command === 'trusted-workflows') {
    allowed = new Set(['--trust-file', '--current-workflow-revision']);
  } else if (command === 'discover-workflows') {
    allowed = new Set(['--repository', '--source-commit', '--verification-file']);
  } else if (command === 'authorize-workflow') {
    allowed = new Set([
      '--repository-root', '--trust-file', '--candidate-workflow-revision', '--current-workflow-revision',
      '--trusted-master-commit', '--source-commit'
    ]);
  } else {
    allowed = new Set([
      '--repository', '--application-id', '--source-commit', '--native-tag', '--native-version',
      '--phone-track', '--phone-version-code', '--phone-aab-sha256',
      '--watch-track', '--watch-version-code', '--watch-aab-sha256',
      ...(command === 'verify' ? ['--receipt-file'] : [])
    ]);
  }
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || !value || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete native Play receipt option: ${option ?? '(missing)'}.`);
    }
    if (Object.hasOwn(values, option)) throw new Error(`Duplicate native Play receipt option: ${option}.`);
    values[option] = value;
  }
  for (const option of allowed) if (!values[option]) throw new Error(`${option} is required.`);
  return { command, values };
}

/** Map validated CLI options to the canonical receipt input shape. */
function receiptValuesFromOptions(values) {
  return {
    repository: values['--repository'],
    applicationId: values['--application-id'],
    sourceCommit: values['--source-commit'],
    nativeTag: values['--native-tag'],
    nativeVersion: values['--native-version'],
    releases: {
      phone: {
        track: values['--phone-track'],
        versionCode: values['--phone-version-code'],
        aabSha256: values['--phone-aab-sha256']
      },
      watch: {
        track: values['--watch-track'],
        versionCode: values['--watch-version-code'],
        aabSha256: values['--watch-aab-sha256']
      }
    }
  };
}

/** Dispatch read-only verification or canonical receipt generation for recovery callers. */
function runNativePlayReceiptCli(args = process.argv.slice(2), output = process.stdout) {
  const { command, values } = parseArguments(args);
  if (command === 'verify-files') {
    return verifyNativePlayReceiptArtifacts({
      receiptFile: values['--receipt-file'],
      expectedReceiptSha256: values['--expected-receipt-sha256'],
      phoneAab: values['--phone-aab'],
      watchAab: values['--watch-aab']
    });
  }
  if (command === 'trusted-workflows') {
    const current = requireText(values['--current-workflow-revision'], COMMIT_PATTERN, 'Current workflow revision');
    const trustSet = parseNativePlayWorkflowTrustSet(
      readRegularFile(values['--trust-file'], 64 * 1024, 'Native Play workflow trust set')
    );
    if (trustSet.revoked.includes(current)) throw new Error(`Current workflow revision ${current} is explicitly revoked.`);
    const revisions = [current, ...trustSet.allowed.filter((revision) => revision !== current)];
    output.write(`${revisions.join('\n')}\n`);
    return Object.freeze({ current, trustSet });
  }
  if (command === 'discover-workflows') {
    const revisions = parseNativePlayAttestationWorkflowCandidates(
      readRegularFile(values['--verification-file'], 1024 * 1024, 'GitHub attestation verification'),
      values['--repository'],
      values['--source-commit']
    );
    output.write(`${revisions.join('\n')}\n`);
    return Object.freeze({ revisions });
  }
  if (command === 'authorize-workflow') {
    const authorization = authorizeNativePlayReceiptWorkflow({
      repositoryRoot: path.resolve(values['--repository-root']),
      trustSet: readRegularFile(values['--trust-file'], 64 * 1024, 'Native Play workflow trust set'),
      candidateWorkflowRevision: values['--candidate-workflow-revision'],
      currentWorkflowRevision: values['--current-workflow-revision'],
      trustedMasterCommit: values['--trusted-master-commit'],
      sourceCommit: values['--source-commit']
    });
    output.write(`${JSON.stringify(authorization)}\n`);
    return authorization;
  }
  const receiptValues = receiptValuesFromOptions(values);
  if (command === 'verify') return verifyNativePlayReceiptFile(values['--receipt-file'], receiptValues);
  output.write(serializeNativePlayReceipt(receiptValues));
  return Object.freeze({ created: true });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runNativePlayReceiptCli();
  } catch (error) {
    console.error(`[native-play-receipt] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
