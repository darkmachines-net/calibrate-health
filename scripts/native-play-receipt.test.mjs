/** @file Regression coverage for native play receipt: native Play receipt has deterministic epoch-marked canonical bytes. */

/** Verify canonical Play receipt identity, binary hashes, and historical signer authorization. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  authorizeNativePlayReceiptWorkflow,
  createNativePlayReceipt,
  NATIVE_PLAY_RECEIPT_CRITICAL_PATHS,
  parseNativePlayAttestationWorkflowCandidates,
  parseNativePlayReceipt,
  parseNativePlayWorkflowTrustSet,
  serializeNativePlayReceipt,
  verifyNativePlayReceiptArtifacts,
  verifyNativePlayReceiptBytes
} from './native-play-receipt.mjs';

const SOURCE = 'a'.repeat(40);
const CURRENT = 'b'.repeat(40);
const REPOSITORY = 'calibratehealth/calibrate';
const PHONE_SHA = '1'.repeat(64);
const WATCH_SHA = '2'.repeat(64);

/** Provide canonical paired receipt inputs with focused invalid-field overrides. */
function values(overrides = {}) {
  return {
    repository: REPOSITORY,
    applicationId: 'net.darkmachines.healthtracker',
    sourceCommit: SOURCE,
    nativeTag: 'native-v1.2.3',
    nativeVersion: '1.2.3',
    releases: {
      phone: { track: 'internal', versionCode: 9, aabSha256: PHONE_SHA },
      watch: { track: 'wear:internal', versionCode: 10, aabSha256: WATCH_SHA }
    },
    ...overrides
  };
}

/** Model the exact hosted-workflow certificate identity used by verification. */
function certificate(overrides = {}) {
  const repositoryUri = `https://github.com/${REPOSITORY}`;
  const workflowUri = `${repositoryUri}/.github/workflows/native-release.yml@refs/heads/master`;
  return {
    verificationResult: {
      signature: {
        certificate: {
          buildSignerDigest: SOURCE,
          sourceRepositoryDigest: SOURCE,
          buildConfigDigest: SOURCE,
          githubWorkflowSHA: SOURCE,
          buildSignerURI: workflowUri,
          buildConfigURI: workflowUri,
          sourceRepositoryURI: repositoryUri,
          sourceRepositoryRef: 'refs/heads/master',
          runnerEnvironment: 'github-hosted',
          ...overrides
        }
      }
    }
  };
}

test('native Play receipt has deterministic epoch-marked canonical bytes', () => {
  const bytes = serializeNativePlayReceipt(values());
  assert.equal(bytes, `${JSON.stringify({
    schema_version: 1,
    attestation_epoch: 1,
    repository: REPOSITORY,
    application_id: 'net.darkmachines.healthtracker',
    source_commit: SOURCE,
    native_release_tag: 'native-v1.2.3',
    version_name: '1.2.3',
    releases: {
      phone: { track: 'internal', version_code: 9, aab_sha256: PHONE_SHA },
      watch: { track: 'wear:internal', version_code: 10, aab_sha256: WATCH_SHA }
    }
  }, null, 2)}\n`);
  assert.deepEqual(parseNativePlayReceipt(bytes), createNativePlayReceipt(values()));

  for (const mutate of [
    (receipt) => { delete receipt.attestation_epoch; },
    (receipt) => { receipt.attestation_epoch = 2; },
    (receipt) => { receipt.extra = true; }
  ]) {
    const receipt = JSON.parse(bytes);
    mutate(receipt);
    assert.throws(() => parseNativePlayReceipt(`${JSON.stringify(receipt, null, 2)}\n`), /canonical reviewed encoding/);
  }
  assert.throws(() => parseNativePlayReceipt(bytes.trim()), /canonical reviewed encoding/);
});

test('native Play receipt validates exact app, source, tag/version, role tracks, lanes, and hashes', () => {
  const invalid = [
    [values({ repository: 'not-a-repository' }), /repository is malformed/],
    [values({ applicationId: 'other.app' }), /application ID must be/],
    [values({ sourceCommit: SOURCE.toUpperCase() }), /source commit is malformed/],
    [values({ nativeTag: 'native-v1.2.4' }), /tag and version do not match/],
    [values({ releases: { ...values().releases, phone: { track: 'beta', versionCode: 9, aabSha256: PHONE_SHA } } }), /track must be internal/],
    [values({ releases: { ...values().releases, phone: { track: 'internal', versionCode: 10, aabSha256: PHONE_SHA } } }), /wrong parity lane/],
    [values({ releases: { ...values().releases, watch: { track: 'wear:internal', versionCode: 10, aabSha256: 'A'.repeat(64) } } }), /SHA-256 is malformed/]
  ];
  for (const [candidate, pattern] of invalid) assert.throws(() => createNativePlayReceipt(candidate), pattern);

  const swapped = values({
    releases: {
      phone: { track: 'internal', versionCode: 9, aabSha256: WATCH_SHA },
      watch: { track: 'wear:internal', versionCode: 10, aabSha256: PHONE_SHA }
    }
  });
  assert.throws(
    () => verifyNativePlayReceiptBytes(serializeNativePlayReceipt(swapped), values()),
    /do not match the exact expected source and Play artifacts/
  );
});

test('source-free receipt verification binds canonical receipt and both downloaded AAB files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-play-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const phone = path.join(root, 'phone.aab');
  const watch = path.join(root, 'watch.aab');
  fs.writeFileSync(phone, 'phone');
  fs.writeFileSync(watch, 'watch');
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const receiptValues = values({
    releases: {
      phone: { track: 'internal', versionCode: 9, aabSha256: digest(phone) },
      watch: { track: 'wear:internal', versionCode: 10, aabSha256: digest(watch) }
    }
  });
  const receipt = path.join(root, 'receipt.json');
  const bytes = serializeNativePlayReceipt(receiptValues);
  fs.writeFileSync(receipt, bytes);
  const expectedReceiptSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    verifyNativePlayReceiptArtifacts({ receiptFile: receipt, expectedReceiptSha256, phoneAab: phone, watchAab: watch }).sha256,
    expectedReceiptSha256
  );
  fs.writeFileSync(watch, 'mutated');
  assert.throws(
    () => verifyNativePlayReceiptArtifacts({ receiptFile: receipt, expectedReceiptSha256, phoneAab: phone, watchAab: watch }),
    /watch AAB SHA-256/
  );
});

test('attestation parser accepts legitimate rerun duplicates through 100 and rejects overflow or bad identity', () => {
  assert.deepEqual(
    parseNativePlayAttestationWorkflowCandidates(JSON.stringify(Array.from({ length: 100 }, () => certificate())), REPOSITORY, SOURCE),
    [SOURCE]
  );
  assert.throws(
    () => parseNativePlayAttestationWorkflowCandidates(JSON.stringify(Array.from({ length: 101 }, () => certificate())), REPOSITORY, SOURCE),
    /between 1 and 100/
  );
  assert.throws(() => parseNativePlayAttestationWorkflowCandidates('[]', REPOSITORY, SOURCE), /between 1 and 100/);
  for (const [field, wrong] of [
    ['buildSignerDigest', CURRENT],
    ['sourceRepositoryDigest', CURRENT],
    ['buildConfigDigest', CURRENT],
    ['githubWorkflowSHA', CURRENT],
    ['buildSignerURI', `https://github.com/${REPOSITORY}/.github/workflows/native-release.yml@main`],
    ['buildConfigURI', `https://github.com/${REPOSITORY}/.github/workflows/other.yml@refs/heads/master`],
    ['sourceRepositoryURI', 'https://github.com/other/repo'],
    ['sourceRepositoryRef', 'refs/tags/native-v1.2.3'],
    ['runnerEnvironment', 'self-hosted']
  ]) {
    assert.throws(
      () => parseNativePlayAttestationWorkflowCandidates(JSON.stringify([certificate({ [field]: wrong })]), REPOSITORY, SOURCE),
      /does not match the original protected native release workflow identity/
    );
  }
});

test('name-only source relabeling cannot reuse another source receipt or attestation', () => {
  const relabeledSource = 'b'.repeat(40);
  const sourceA = values();
  const sourceB = values({ sourceCommit: relabeledSource });
  const sourceBBytes = serializeNativePlayReceipt(sourceB);
  assert.throws(
    () => verifyNativePlayReceiptBytes(sourceBBytes, sourceA),
    /do not match the exact expected source and Play artifacts/
  );
  assert.throws(
    () => parseNativePlayAttestationWorkflowCandidates(
      JSON.stringify([certificate()]),
      REPOSITORY,
      relabeledSource
    ),
    /does not match the original protected native release workflow identity/
  );
});

test('current-master trust policy is strict and revocation wins', () => {
  const repositoryTrust = fs.readFileSync(
    new URL('../.github/native-play-attestation-trusted-workflow-shas', import.meta.url),
    'utf8'
  );
  assert.ok(parseNativePlayWorkflowTrustSet(repositoryTrust));
  assert.deepEqual(parseNativePlayWorkflowTrustSet(`# comment\nrevoke ${SOURCE}\n`), {
    allowed: [],
    revoked: [SOURCE]
  });
  assert.throws(() => parseNativePlayWorkflowTrustSet(`revoke ${SOURCE}\nrevoke ${SOURCE}\n`), /repeats/);
  assert.throws(() => parseNativePlayWorkflowTrustSet(`revoke ${SOURCE.toUpperCase()}\n`), /must be/);
  assert.throws(() => parseNativePlayWorkflowTrustSet('anything\n'), /must be/);
});

/** Exercise trust decisions with controlled ancestry and critical-blob drift. */
function fakeGit(options = {}) {
  const driftPath = options.driftPath;
  return (_root, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const spec = args[2];
      if (spec.endsWith('^{commit}')) return spec.slice(0, -9);
      const [revision, relativePath] = spec.split(':');
      if (relativePath) return driftPath === relativePath && revision === SOURCE ? 'd'.repeat(40) : 'e'.repeat(40);
    }
    if (args[0] === 'merge-base') {
      if (options.nonAncestor) throw new Error('not ancestor');
      return '';
    }
    if (args[0] === 'show') {
      const relativePath = args[1].slice(args[1].indexOf(':') + 1);
      if (options.preEpoch && relativePath === '.github/workflows/native-release.yml') return 'old workflow';
      if (relativePath === '.github/workflows/native-release.yml') {
        return 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d\nattest-play-receipt:\nVerify exact native Play receipt attestation';
      }
      if (relativePath === 'scripts/native-play-receipt.mjs') return 'version_name aab_sha256';
      return 'present';
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

test('historical signer authorization enforces source, fresh master, ancestry, marker, revocation, and full critical closure', () => {
  const base = {
    repositoryRoot: '.',
    trustSet: '',
    candidateWorkflowRevision: SOURCE,
    currentWorkflowRevision: CURRENT,
    trustedMasterCommit: CURRENT,
    sourceCommit: SOURCE
  };
  assert.equal(authorizeNativePlayReceiptWorkflow({ ...base, git: fakeGit() }).mode, 'unchanged-critical-tooling');
  assert.throws(
    () => authorizeNativePlayReceiptWorkflow({ ...base, sourceCommit: 'c'.repeat(40), git: fakeGit() }),
    /signer must equal the original source commit/
  );
  assert.throws(
    () => authorizeNativePlayReceiptWorkflow({ ...base, trustedMasterCommit: 'c'.repeat(40), git: fakeGit() }),
    /must equal freshly resolved protected master/
  );
  assert.throws(() => authorizeNativePlayReceiptWorkflow({ ...base, git: fakeGit({ nonAncestor: true }) }), /not on protected master history/);
  assert.throws(() => authorizeNativePlayReceiptWorkflow({ ...base, git: fakeGit({ preEpoch: true }) }), /predates/);
  assert.throws(
    () => authorizeNativePlayReceiptWorkflow({ ...base, trustSet: `allow ${SOURCE}\nrevoke ${SOURCE}\n`, git: fakeGit() }),
    /repeats/
  );
  assert.throws(
    () => authorizeNativePlayReceiptWorkflow({ ...base, trustSet: `revoke ${SOURCE}\n`, git: fakeGit() }),
    /explicitly revoked/
  );
  assert.ok(NATIVE_PLAY_RECEIPT_CRITICAL_PATHS.includes('mobile/plugins/nativeReleaseGradleWrapper.js'));
  assert.ok(NATIVE_PLAY_RECEIPT_CRITICAL_PATHS.includes('mobile/plugins/withPinnedGradleWrapper.js'));
  for (const criticalPath of NATIVE_PLAY_RECEIPT_CRITICAL_PATHS) {
    assert.throws(
      () => authorizeNativePlayReceiptWorkflow({ ...base, git: fakeGit({ driftPath: criticalPath }) }),
      /changed critical tooling/
    );
    assert.equal(
      authorizeNativePlayReceiptWorkflow({ ...base, trustSet: `allow ${SOURCE}\n`, git: fakeGit({ driftPath: criticalPath }) }).mode,
      'explicit-retained'
    );
  }
  assert.ok(!NATIVE_PLAY_RECEIPT_CRITICAL_PATHS.includes('.github/native-play-attestation-trusted-workflow-shas'));
});
