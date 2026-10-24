/** @file Canonical image publication receipts and exact workflow/source attestation verification. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GHCR_IMAGE_PATTERN = /^ghcr\.io\/[a-z0-9._/-]+$/;
const RELEASE_TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS = Object.freeze([
  '.github/workflows/container.yml',
  'scripts/ghcr-release-policy.mjs',
  'scripts/ghcr-release-receipt.mjs',
  'scripts/native-tag-attestation.mjs',
  'scripts/release-config.mjs'
]);

const ATTEST_ACTION_PIN = 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d';

function requireText(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

/** Validates repository, image, release, workflow, and digest identity into canonical receipt fields. */
export function createGhcrReleaseReceipt(values) {
  const repository = requireText(values?.repository, REPOSITORY_PATTERN, 'GitHub repository');
  const ghcrImage = requireText(values?.ghcrImage, GHCR_IMAGE_PATTERN, 'GHCR image repository');
  if (ghcrImage.includes('..') || ghcrImage.endsWith('/')) {
    throw new Error('GHCR image repository is malformed.');
  }
  const releaseTag = requireText(values?.releaseTag, RELEASE_TAG_PATTERN, 'Release tag');
  const releaseCommit = requireText(values?.releaseCommit, COMMIT_PATTERN, 'Release commit');
  const imageConfigDigest = requireText(
    values?.imageConfigDigest,
    DIGEST_PATTERN,
    'Image configuration digest'
  );
  return Object.freeze({
    schema_version: 1,
    repository,
    ghcr_image: ghcrImage,
    release_tag: releaseTag,
    release_commit: releaseCommit,
    image_config_digest: imageConfigDigest
  });
}

/** Serializes the validated image receipt into stable canonical JSON bytes. */
export function serializeGhcrReleaseReceipt(values) {
  const receipt = createGhcrReleaseReceipt(values);
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/** Parses exact allow/revoke workflow SHA directives, rejecting malformed or duplicate trust entries. */
export function parseGhcrReleaseWorkflowTrustSet(contents) {
  if (typeof contents !== 'string') throw new Error('GHCR workflow trust set must be text.');
  const allowed = [];
  const revoked = [];
  const seen = new Set();
  for (const [index, rawLine] of contents.replaceAll('\r\n', '\n').split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(allow|revoke) ([0-9a-f]{40})$/);
    if (!match) {
      throw new Error(
        `GHCR workflow trust set line ${index + 1} must be "allow SHA" or "revoke SHA" with one full lowercase commit SHA.`
      );
    }
    const [, disposition, revision] = match;
    if (seen.has(revision)) throw new Error(`GHCR workflow trust set repeats ${revision}.`);
    seen.add(revision);
    (disposition === 'allow' ? allowed : revoked).push(revision);
  }
  return Object.freeze({
    allowed: Object.freeze(allowed),
    revoked: Object.freeze(revoked)
  });
}

/** Extracts bounded workflow candidates from verified GitHub attestation output for the expected repository. */
export function parseGhcrAttestationWorkflowCandidates(contents, repository) {
  requireText(repository, REPOSITORY_PATTERN, 'GitHub repository');
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
  const workflowUri = `${repositoryUri}/.github/workflows/container.yml@refs/heads/master`;
  // Fulcio identifies the reusable signer separately from its top-level caller.
  const callerUris = new Set([
    'cut-release-handler.yml',
    'publish-release-handler.yml',
    'container-handler.yml'
  ].map((name) => `${repositoryUri}/.github/workflows/${name}@refs/heads/master`));
  const revisions = [];
  const seen = new Set();
  for (const result of results) {
    const certificate = result?.verificationResult?.signature?.certificate;
    const revision = certificate?.buildSignerDigest;
    if (
      !COMMIT_PATTERN.test(revision ?? '')
      || certificate.sourceRepositoryDigest !== revision
      || certificate.buildConfigDigest !== revision
      || certificate.githubWorkflowSHA !== revision
      || certificate.buildSignerURI !== workflowUri
      || !callerUris.has(certificate.buildConfigURI)
      || certificate.buildTrigger !== 'workflow_run'
      || certificate.sourceRepositoryURI !== repositoryUri
      || certificate.sourceRepositoryRef !== 'refs/heads/master'
      || certificate.runnerEnvironment !== 'github-hosted'
    ) {
      throw new Error('GitHub attestation certificate does not match the exact protected release workflow identity.');
    }
    if (!seen.has(revision)) {
      seen.add(revision);
      revisions.push(revision);
    }
  }
  return Object.freeze(revisions);
}

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
    ) {
      continue;
    }
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

function runGit(root, args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: sanitizedGitEnvironment(process.env),
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function requireGitCommit(git, root, revision, label) {
  const resolved = git(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (resolved !== revision || !COMMIT_PATTERN.test(resolved)) {
    throw new Error(`${label} is not one exact commit.`);
  }
}

function requireAncestor(git, root, ancestor, descendant) {
  try {
    git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
  } catch (error) {
    throw new Error(`GHCR attestation signer ${ancestor} is not on protected master history.`, { cause: error });
  }
}

function readCriticalBlobIds(git, root, revision) {
  return GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS.map((relativePath) => {
    const blob = git(root, ['rev-parse', '--verify', `${revision}:${relativePath}`]);
    if (!COMMIT_PATTERN.test(blob)) {
      throw new Error(`GHCR attestation signer ${revision} has malformed critical blob ${relativePath}.`);
    }
    return blob;
  });
}

function hasPostHardeningAttestationMarker(git, root, revision) {
  try {
    const workflow = git(root, ['show', `${revision}:.github/workflows/container.yml`]);
    const receipt = git(root, ['show', `${revision}:scripts/ghcr-release-receipt.mjs`]);
    git(root, ['show', `${revision}:scripts/ghcr-release-policy.mjs`]);
    git(root, ['show', `${revision}:.github/release-image-attestation-trusted-workflow-shas`]);
    return workflow.includes(ATTEST_ACTION_PIN)
      && workflow.includes('attest_image_receipt:')
      && workflow.includes('verify_receipt_attestation')
      && receipt.includes('image_config_digest');
  } catch {
    return false;
  }
}

/** Authorizes an image signer against current protected-master trust policy, with explicit revocation taking precedence. */
export function authorizeGhcrReleaseWorkflow({
  repositoryRoot,
  trustSet,
  candidateWorkflowRevision,
  currentWorkflowRevision,
  trustedMasterCommit,
  releaseCommit,
  git = runGit
}) {
  const candidate = requireText(
    candidateWorkflowRevision,
    COMMIT_PATTERN,
    'Candidate attestation workflow revision'
  );
  const current = requireText(currentWorkflowRevision, COMMIT_PATTERN, 'Current workflow revision');
  const master = requireText(trustedMasterCommit, COMMIT_PATTERN, 'Trusted master commit');
  const release = requireText(releaseCommit, COMMIT_PATTERN, 'Release commit');
  const parsedTrust = typeof trustSet === 'string'
    ? parseGhcrReleaseWorkflowTrustSet(trustSet)
    : trustSet;
  if (!parsedTrust || !Array.isArray(parsedTrust.allowed) || !Array.isArray(parsedTrust.revoked)) {
    throw new Error('GHCR workflow trust set is malformed.');
  }
  if (parsedTrust.revoked.includes(candidate)) {
    throw new Error(`GHCR attestation signer ${candidate} is explicitly revoked by current protected master.`);
  }

  for (const [revision, label] of [
    [candidate, 'Candidate attestation workflow revision'],
    [current, 'Current workflow revision'],
    [master, 'Trusted master commit'],
    [release, 'Release commit']
  ]) {
    requireGitCommit(git, repositoryRoot, revision, label);
  }
  requireAncestor(git, repositoryRoot, candidate, master);

  if (candidate === current) {
    return Object.freeze({ candidate, mode: 'current-workflow' });
  }
  if (parsedTrust.allowed.includes(candidate)) {
    return Object.freeze({ candidate, mode: 'explicit-retained' });
  }

  let candidateBlobs;
  let currentBlobs;
  try {
    candidateBlobs = readCriticalBlobIds(git, repositoryRoot, candidate);
    currentBlobs = readCriticalBlobIds(git, repositoryRoot, current);
  } catch (error) {
    throw new Error(`GHCR attestation signer ${candidate} lacks the reviewed critical tooling set.`, { cause: error });
  }
  if (candidateBlobs.every((blob, index) => blob === currentBlobs[index])) {
    return Object.freeze({ candidate, mode: 'unchanged-critical-tooling' });
  }

  const releaseParents = git(repositoryRoot, ['rev-list', '--parents', '-n', '1', release]).split(/\s+/);
  if (
    releaseParents.length === 2
    && releaseParents[0] === release
    && releaseParents[1] === candidate
    && hasPostHardeningAttestationMarker(git, repositoryRoot, candidate)
  ) {
    return Object.freeze({ candidate, mode: 'canonical-cut-parent' });
  }

  throw new Error(
    `GHCR attestation signer ${candidate} changed critical tooling and is neither the post-hardening Cut parent nor explicitly retained.`
  );
}

function parseArguments(args) {
  const command = args[0];
  if (!['authorize-workflow', 'create', 'discover-workflows', 'trusted-workflows', 'verify'].includes(command)) {
    throw new Error('Expected command: authorize-workflow, create, discover-workflows, trusted-workflows, or verify.');
  }
  let allowed;
  if (command === 'trusted-workflows') {
    allowed = new Set(['--trust-file', '--current-workflow-revision']);
  } else if (command === 'discover-workflows') {
    allowed = new Set(['--repository', '--verification-file']);
  } else if (command === 'authorize-workflow') {
    allowed = new Set([
      '--repository-root',
      '--trust-file',
      '--candidate-workflow-revision',
      '--current-workflow-revision',
      '--trusted-master-commit',
      '--release-commit'
    ]);
  } else {
    allowed = new Set([
      '--repository',
      '--ghcr-image',
      '--release-tag',
      '--release-commit',
      '--image-config-digest',
      ...(command === 'verify' ? ['--receipt-file'] : [])
    ]);
  }
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || !value || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete GHCR receipt option: ${option ?? '(missing)'}.`);
    }
    if (Object.hasOwn(values, option)) throw new Error(`Duplicate GHCR receipt option: ${option}.`);
    values[option] = value;
  }
  for (const option of allowed) {
    if (!values[option]) throw new Error(`${option} is required.`);
  }
  return { command, values };
}

function expectedReceiptFromOptions(values) {
  return serializeGhcrReleaseReceipt({
    repository: values['--repository'],
    ghcrImage: values['--ghcr-image'],
    releaseTag: values['--release-tag'],
    releaseCommit: values['--release-commit'],
    imageConfigDigest: values['--image-config-digest']
  });
}

function readRegularFile(file, maximumBytes, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`${label} must be a regular file of at most ${maximumBytes} bytes.`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/** Dispatches canonical receipt and signer-trust operations using explicit files and source identities. */
export function runGhcrReleaseReceiptCli(args = process.argv.slice(2), output = process.stdout) {
  const { command, values } = parseArguments(args);
  if (command === 'trusted-workflows') {
    const current = requireText(
      values['--current-workflow-revision'],
      COMMIT_PATTERN,
      'Current workflow revision'
    );
    const trustSet = parseGhcrReleaseWorkflowTrustSet(
      readRegularFile(values['--trust-file'], 64 * 1024, 'GHCR workflow trust set')
    );
    if (trustSet.revoked.includes(current)) {
      throw new Error(`Current workflow revision ${current} is explicitly revoked.`);
    }
    const revisions = [current, ...trustSet.allowed.filter((revision) => revision !== current)];
    output.write(`${revisions.join('\n')}\n`);
    return Object.freeze({ current, trustSet });
  }
  if (command === 'discover-workflows') {
    const revisions = parseGhcrAttestationWorkflowCandidates(
      readRegularFile(values['--verification-file'], 1024 * 1024, 'GitHub attestation verification'),
      values['--repository']
    );
    output.write(`${revisions.join('\n')}\n`);
    return Object.freeze({ revisions });
  }
  if (command === 'authorize-workflow') {
    const trustSet = readRegularFile(values['--trust-file'], 64 * 1024, 'GHCR workflow trust set');
    const authorization = authorizeGhcrReleaseWorkflow({
      repositoryRoot: path.resolve(values['--repository-root']),
      trustSet,
      candidateWorkflowRevision: values['--candidate-workflow-revision'],
      currentWorkflowRevision: values['--current-workflow-revision'],
      trustedMasterCommit: values['--trusted-master-commit'],
      releaseCommit: values['--release-commit']
    });
    output.write(`${JSON.stringify(authorization)}\n`);
    return authorization;
  }
  const expected = expectedReceiptFromOptions(values);
  if (command === 'verify') {
    const actual = readRegularFile(values['--receipt-file'], 16 * 1024, 'GHCR receipt');
    if (actual !== expected) {
      throw new Error('GHCR receipt bytes do not match the exact expected release identity.');
    }
    return Object.freeze({ verified: true });
  }
  output.write(expected);
  return Object.freeze({ created: true });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runGhcrReleaseReceiptCli();
  } catch (error) {
    console.error(`[ghcr-release-receipt] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
