/** @file Regression coverage for release request: release requests accept only exact operation-specific primitive inputs. */

/** Regression coverage for release request and its failure boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyReleaseRequest, verifyReleaseRequestArtifact } from './release-request.mjs';

const context = Object.freeze({
  operation: 'publish-prepared-release',
  repository: 'MChartier/calibrate-health',
  repositoryId: '123456',
  runId: '987654',
  runAttempt: '2',
  headBranch: 'master',
  headSha: 'a'.repeat(40)
});

/** Build an exact source-bound workflow request fixture. */
function request(overrides = {}) {
  return {
    schema_version: 1,
    operation: context.operation,
    repository: context.repository,
    repository_id: context.repositoryId,
    request_run_id: context.runId,
    request_run_attempt: context.runAttempt,
    head_branch: context.headBranch,
    head_sha: context.headSha,
    inputs: {
      release_branch: 'release/v0.35.0',
      release_commit: 'b'.repeat(40)
    },
    ...overrides
  };
}

/** Write a bounded request artifact into its isolated test directory. */
function artifact(t, value = request()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-release-request-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'request.json'), `${JSON.stringify(value)}\n`);
  return directory;
}

test('release requests accept only exact operation-specific primitive inputs', () => {
  assert.deepEqual(verifyReleaseRequest(request(), context), {
    release_branch: 'release/v0.35.0',
    release_commit: 'b'.repeat(40)
  });
  assert.deepEqual(verifyReleaseRequest(request({
    operation: 'cut-release',
    inputs: { bump: 'minor', confirm_play_console_clean: false }
  }), { ...context, operation: 'cut-release' }), { bump: 'minor', confirm_play_console_clean: false });
  assert.deepEqual(verifyReleaseRequest(request({
    operation: 'build-release-image',
    inputs: {
      publish_latest: false,
      release_commit: 'c'.repeat(40),
      release_tag: 'v0.35.0'
    }
  }), { ...context, operation: 'build-release-image' }), {
    publish_latest: false,
    release_commit: 'c'.repeat(40),
    release_tag: 'v0.35.0'
  });
});

test('release requests reject extra top-level or input fields and malformed values', () => {
  assert.throws(() => verifyReleaseRequest({ ...request(), extra: true }, context), /contain exactly/);
  assert.throws(() => verifyReleaseRequest(request({
    inputs: { ...request().inputs, extra: true }
  }), context), /inputs must contain exactly/);
  assert.throws(() => verifyReleaseRequest(request({
    inputs: { ...request().inputs, release_commit: 'HEAD' }
  }), context), /release_commit is malformed/);
  assert.throws(() => verifyReleaseRequest(request({
    operation: 'build-release-image',
    inputs: { publish_latest: 'false', release_commit: 'c'.repeat(40), release_tag: 'v0.35.0' }
  }), { ...context, operation: 'build-release-image' }), /JSON boolean/);
});

test('release requests bind repository, run, attempt, ref, SHA, and operation to the trigger', () => {
  for (const [name, value] of [
    ['repository', 'Other/repository'],
    ['repository_id', '999'],
    ['request_run_id', '1'],
    ['request_run_attempt', '1'],
    ['head_branch', 'feature'],
    ['head_sha', 'd'.repeat(40)],
    ['operation', 'cut-release']
  ]) {
    assert.throws(() => verifyReleaseRequest(request({ [name]: value }), context), /does not match/);
  }
});

test('release request artifacts reject missing, extra, nested, oversized, and malformed files', (t) => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-release-request-missing-'));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  assert.throws(() => verifyReleaseRequestArtifact({ artifactDirectory: missing, ...context }), /exactly one regular/);
  const directory = artifact(t);
  assert.deepEqual(verifyReleaseRequestArtifact({ artifactDirectory: directory, ...context }), request().inputs);
  fs.writeFileSync(path.join(directory, 'extra.json'), '{}');
  assert.throws(() => verifyReleaseRequestArtifact({ artifactDirectory: directory, ...context }), /exactly one regular/);
  fs.rmSync(path.join(directory, 'extra.json'));
  fs.writeFileSync(path.join(directory, 'request.json'), 'x'.repeat(4097));
  assert.throws(() => verifyReleaseRequestArtifact({ artifactDirectory: directory, ...context }), /at most 4096/);
  fs.writeFileSync(path.join(directory, 'request.json'), '{x');
  assert.throws(() => verifyReleaseRequestArtifact({ artifactDirectory: directory, ...context }), /not valid JSON/);
  fs.rmSync(path.join(directory, 'request.json'));
  fs.mkdirSync(path.join(directory, 'request.json'));
  assert.throws(() => verifyReleaseRequestArtifact({ artifactDirectory: directory, ...context }), /exactly one regular/);
});

test('release request artifacts reject symbolic links when supported', (t) => {
  const directory = artifact(t);
  const target = `${directory}-target.json`;
  t.after(() => fs.rmSync(target, { force: true }));
  fs.renameSync(path.join(directory, 'request.json'), target);
  try {
    fs.symlinkSync(target, path.join(directory, 'request.json'));
  } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  assert.throws(() => verifyReleaseRequestArtifact({ artifactDirectory: directory, ...context }), /exactly one regular/);
});
