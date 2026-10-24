/** @file Regression coverage for ghcr release receipt: protected-master trust set accepts only unique exact allow and revoke directives. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS,
  authorizeGhcrReleaseWorkflow,
  createGhcrReleaseReceipt,
  parseGhcrAttestationWorkflowCandidates,
  parseGhcrReleaseWorkflowTrustSet,
  runGhcrReleaseReceiptCli,
  serializeGhcrReleaseReceipt
} from './ghcr-release-receipt.mjs';

const values = Object.freeze({
  repository: 'MChartier/calibrate-health',
  ghcrImage: 'ghcr.io/mchartier/calibratehealth',
  releaseTag: 'v0.35.0',
  releaseCommit: 'a'.repeat(40),
  imageConfigDigest: `sha256:${'b'.repeat(64)}`
});

test('protected-master trust set accepts only unique exact allow and revoke directives', () => {
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);
  assert.deepEqual(parseGhcrReleaseWorkflowTrustSet(
    `# retained\nallow ${first}\n\nrevoke ${second}\n`
  ), { allowed: [first], revoked: [second] });
  assert.throws(
    () => parseGhcrReleaseWorkflowTrustSet(`allow ${first}\nrevoke ${first}\n`),
    /repeats/
  );
  assert.throws(() => parseGhcrReleaseWorkflowTrustSet('allow HEAD\n'), /full lowercase commit SHA/);
  assert.throws(
    () => parseGhcrReleaseWorkflowTrustSet(`allow ${'A'.repeat(40)}\n`),
    /full lowercase commit SHA/
  );
});

test('repository GHCR workflow trust root is comment-only or parses as exact directives', () => {
  const contents = fs.readFileSync(
    new URL('../.github/release-image-attestation-trusted-workflow-shas', import.meta.url),
    'utf8'
  );
  assert.doesNotThrow(() => parseGhcrReleaseWorkflowTrustSet(contents));
});

test('trusted-workflows CLI emits current first and retained historical revisions exactly once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-trust-'));
  const trustFile = path.join(directory, 'trusted-workflows');
  const current = '3'.repeat(40);
  const historical = '4'.repeat(40);
  try {
    fs.writeFileSync(
      trustFile,
      `# current may also be retained harmlessly\nallow ${historical}\nallow ${current}\n`
    );
    let output = '';
    const result = runGhcrReleaseReceiptCli([
      'trusted-workflows',
      '--trust-file', trustFile,
      '--current-workflow-revision', current
    ], { write: (chunk) => { output += chunk; } });
    assert.equal(output, `${current}\n${historical}\n`);
    assert.deepEqual(result, {
      current,
      trustSet: { allowed: [historical, current], revoked: [] }
    });

    fs.writeFileSync(trustFile, `revoke ${current}\n`);
    assert.throws(
      () => runGhcrReleaseReceiptCli([
        'trusted-workflows',
        '--trust-file', trustFile,
        '--current-workflow-revision', current
      ]),
      /explicitly revoked/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function attestationResult(revision, overrides = {}) {
  const repositoryUri = 'https://github.com/MChartier/calibrate-health';
  const workflowUri = `${repositoryUri}/.github/workflows/container.yml@refs/heads/master`;
  return {
    verificationResult: {
      signature: {
        certificate: {
          buildConfigDigest: revision,
          buildConfigURI: `${repositoryUri}/.github/workflows/cut-release-handler.yml@refs/heads/master`,
          buildTrigger: 'workflow_run',
          buildSignerDigest: revision,
          buildSignerURI: workflowUri,
          githubWorkflowSHA: revision,
          runnerEnvironment: 'github-hosted',
          sourceRepositoryDigest: revision,
          sourceRepositoryRef: 'refs/heads/master',
          sourceRepositoryURI: repositoryUri,
          ...overrides
        }
      }
    }
  };
}

test('discovers only exact protected-master signer revisions from cryptographically verified output', () => {
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);
  const contents = JSON.stringify([
    attestationResult(first),
    attestationResult(second),
    attestationResult(first)
  ]);
  assert.deepEqual(
    parseGhcrAttestationWorkflowCandidates(contents, 'MChartier/calibrate-health'),
    [first, second]
  );

  for (const override of [
    { sourceRepositoryDigest: second },
    { buildConfigDigest: second },
    { buildTrigger: 'workflow_dispatch' },
    { buildConfigURI: 'https://github.com/MChartier/calibrate-health/.github/workflows/container.yml@refs/heads/master' },
    { buildConfigURI: 'https://github.com/MChartier/calibrate-health/.github/workflows/evil.yml@refs/heads/master' },
    { buildConfigURI: 'https://github.com/MChartier/calibrate-health/.github/workflows/cut-release-handler.yml@refs/heads/feature' },
    { buildConfigURI: 'https://github.com/other/calibrate-health/.github/workflows/cut-release-handler.yml@refs/heads/master' },
    { sourceRepositoryRef: 'refs/heads/feature' },
    { runnerEnvironment: 'self-hosted' },
    { buildSignerURI: 'https://github.com/MChartier/calibrate-health/.github/workflows/evil.yml@refs/heads/master' }
  ]) {
    assert.throws(
      () => parseGhcrAttestationWorkflowCandidates(
        JSON.stringify([attestationResult(first, override)]),
        'MChartier/calibrate-health'
      ),
      /exact protected release workflow identity/
    );
  }
  assert.throws(
    () => parseGhcrAttestationWorkflowCandidates('[]', 'MChartier/calibrate-health'),
    /between 1 and 100/
  );
  assert.deepEqual(
    parseGhcrAttestationWorkflowCandidates(
      JSON.stringify(Array.from({ length: 100 }, () => attestationResult(first))),
      'MChartier/calibrate-health'
    ),
    [first],
    'the explicit verification cap must accept all 100 bounded results before de-duplicating signers'
  );
  assert.throws(
    () => parseGhcrAttestationWorkflowCandidates(
      JSON.stringify(Array.from({ length: 101 }, () => attestationResult(first))),
      'MChartier/calibrate-health'
    ),
    /between 1 and 100/,
    'the bounded discovery policy must reject a 101st attestation result'
  );
});

test('real Cut release certificate distinguishes the reusable signer from the request handler', () => {
  // Public output of gh attestation verify for release run 34701986195.
  const contents = fs.readFileSync(
    new URL('./fixtures/ghcr-cut-release-attestation-verification.json', import.meta.url),
    'utf8'
  );
  const revision = '9aad13afd54e2d1b0931a444dbdb200b92179ccc';
  const certificate = JSON.parse(contents)[0].verificationResult.signature.certificate;
  assert.notEqual(certificate.buildConfigURI, certificate.buildSignerURI);
  assert.deepEqual(parseGhcrAttestationWorkflowCandidates(contents, values.repository), [revision]);

  for (const caller of ['cut-release-handler.yml', 'publish-release-handler.yml', 'container-handler.yml']) {
    const result = attestationResult(revision, {
      buildConfigURI: `https://github.com/${values.repository}/.github/workflows/${caller}@refs/heads/master`
    });
    assert.deepEqual(
      parseGhcrAttestationWorkflowCandidates(JSON.stringify([result]), values.repository),
      [revision]
    );
  }
});

function createAuthorizationGit({
  candidate,
  current,
  master,
  release,
  releaseParent = candidate,
  sameCriticalBlobs = false,
  postHardeningMarker = true,
  ancestor = true
}) {
  const commits = new Set([candidate, current, master, release, releaseParent]);
  return (_root, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const expression = args[2];
      const commitMatch = expression.match(/^([0-9a-f]{40})\^\{commit\}$/);
      if (commitMatch && commits.has(commitMatch[1])) return commitMatch[1];
      const blobMatch = expression.match(/^([0-9a-f]{40}):(.+)$/);
      if (blobMatch && GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS.includes(blobMatch[2])) {
        if (sameCriticalBlobs) return 'b'.repeat(40);
        return blobMatch[1] === candidate ? 'a'.repeat(40) : 'b'.repeat(40);
      }
      throw new Error(`unknown revision ${expression}`);
    }
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      if (!ancestor) throw new Error('not ancestor');
      return '';
    }
    if (args[0] === 'rev-list') return `${release} ${releaseParent}`;
    if (args[0] === 'show') {
      const [, relativePath] = args[1].split(':', 2);
      if (!postHardeningMarker) throw new Error('missing marker');
      if (relativePath === '.github/workflows/container.yml') {
        return [
          'attest_image_receipt:',
          'verify_receipt_attestation',
          'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d'
        ].join('\n');
      }
      if (relativePath === 'scripts/ghcr-release-receipt.mjs') return 'image_config_digest';
      if (relativePath === 'scripts/ghcr-release-policy.mjs') return 'validate-manifest';
      if (relativePath === '.github/release-image-attestation-trusted-workflow-shas') return '# policy';
      throw new Error(`unknown marker ${relativePath}`);
    }
    throw new Error(`unknown git command ${args.join(' ')}`);
  };
}

function authorizationOptions(overrides = {}) {
  const candidate = overrides.candidate ?? '1'.repeat(40);
  const current = overrides.current ?? '2'.repeat(40);
  const master = overrides.master ?? '3'.repeat(40);
  const release = overrides.release ?? '4'.repeat(40);
  const gitOptions = { candidate, current, master, release, ...overrides.gitOptions };
  return {
    repositoryRoot: '.',
    trustSet: overrides.trustSet ?? '',
    candidateWorkflowRevision: candidate,
    currentWorkflowRevision: current,
    trustedMasterCommit: master,
    releaseCommit: release,
    git: createAuthorizationGit(gitOptions)
  };
}

test('authorizes current and byte-identical historical workflow revisions across unrelated master advances', () => {
  const current = '2'.repeat(40);
  assert.deepEqual(authorizeGhcrReleaseWorkflow(authorizationOptions({ candidate: current, current })), {
    candidate: current,
    mode: 'current-workflow'
  });

  const candidate = '1'.repeat(40);
  assert.deepEqual(authorizeGhcrReleaseWorkflow(authorizationOptions({
    candidate,
    gitOptions: { sameCriticalBlobs: true }
  })), {
    candidate,
    mode: 'unchanged-critical-tooling'
  });
});

test('normal Cut P receipt remains recoverable after canonical release C while current revocation wins', () => {
  const parent = '5'.repeat(40);
  const release = '6'.repeat(40);
  const current = '7'.repeat(40);
  assert.deepEqual(authorizeGhcrReleaseWorkflow(authorizationOptions({
    candidate: parent,
    current,
    release,
    gitOptions: { releaseParent: parent, sameCriticalBlobs: true }
  })), {
    candidate: parent,
    mode: 'unchanged-critical-tooling'
  });
  assert.throws(
    () => authorizeGhcrReleaseWorkflow(authorizationOptions({
      candidate: parent,
      current,
      release,
      trustSet: `revoke ${parent}\n`,
      gitOptions: { releaseParent: parent, sameCriticalBlobs: true }
    })),
    /explicitly revoked/
  );
});

test('changed historical signers require explicit retention except the exact post-hardening Cut parent', () => {
  const candidate = '8'.repeat(40);
  const otherParent = '9'.repeat(40);
  assert.throws(
    () => authorizeGhcrReleaseWorkflow(authorizationOptions({
      candidate,
      gitOptions: { releaseParent: otherParent }
    })),
    /neither the post-hardening Cut parent nor explicitly retained/
  );
  assert.equal(authorizeGhcrReleaseWorkflow(authorizationOptions({
    candidate,
    trustSet: `allow ${candidate}\n`,
    gitOptions: { releaseParent: otherParent }
  })).mode, 'explicit-retained');
  assert.equal(authorizeGhcrReleaseWorkflow(authorizationOptions({ candidate })).mode, 'canonical-cut-parent');
  assert.throws(
    () => authorizeGhcrReleaseWorkflow(authorizationOptions({
      candidate,
      gitOptions: { postHardeningMarker: false }
    })),
    /neither the post-hardening Cut parent nor explicitly retained/
  );
  assert.throws(
    () => authorizeGhcrReleaseWorkflow(authorizationOptions({
      candidate,
      gitOptions: { ancestor: false }
    })),
    /not on protected master history/
  );
});

function cliOptions(overrides = {}) {
  const merged = { ...values, ...overrides };
  return [
    '--repository', merged.repository,
    '--ghcr-image', merged.ghcrImage,
    '--release-tag', merged.releaseTag,
    '--release-commit', merged.releaseCommit,
    '--image-config-digest', merged.imageConfigDigest
  ];
}

test('serializes one deterministic exact GHCR release receipt', () => {
  const receipt = createGhcrReleaseReceipt(values);
  assert.deepEqual(receipt, {
    schema_version: 1,
    repository: values.repository,
    ghcr_image: values.ghcrImage,
    release_tag: values.releaseTag,
    release_commit: values.releaseCommit,
    image_config_digest: values.imageConfigDigest
  });
  assert.equal(
    serializeGhcrReleaseReceipt(values),
    '{\n' +
      '  "schema_version": 1,\n' +
      `  "repository": "${values.repository}",\n` +
      `  "ghcr_image": "${values.ghcrImage}",\n` +
      `  "release_tag": "${values.releaseTag}",\n` +
      `  "release_commit": "${values.releaseCommit}",\n` +
      `  "image_config_digest": "${values.imageConfigDigest}"\n` +
      '}\n'
  );
});

test('rejects malformed or ambiguously scoped receipt identities', () => {
  for (const [field, value] of [
    ['repository', 'owner'],
    ['ghcrImage', 'ghcr.io/Owner/calibratehealth'],
    ['ghcrImage', 'ghcr.io/owner/../other'],
    ['releaseTag', 'latest'],
    ['releaseCommit', 'a'.repeat(39)],
    ['imageConfigDigest', `sha512:${'b'.repeat(64)}`]
  ]) {
    assert.throws(() => createGhcrReleaseReceipt({ ...values, [field]: value }), /malformed/);
  }
});

test('CLI verification requires exact canonical bytes and every bound field', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-receipt-'));
  const receiptFile = path.join(directory, 'release-image-receipt.json');
  try {
    let output = '';
    runGhcrReleaseReceiptCli(['create', ...cliOptions()], { write: (chunk) => { output += chunk; } });
    fs.writeFileSync(receiptFile, output);
    assert.deepEqual(
      runGhcrReleaseReceiptCli(['verify', ...cliOptions(), '--receipt-file', receiptFile]),
      { verified: true }
    );

    assert.throws(
      () => runGhcrReleaseReceiptCli([
        'verify',
        ...cliOptions({ imageConfigDigest: `sha256:${'d'.repeat(64)}` }),
        '--receipt-file', receiptFile
      ]),
      /exact expected release identity/
    );
    fs.writeFileSync(receiptFile, `${output.trim()} \n`);
    assert.throws(
      () => runGhcrReleaseReceiptCli(['verify', ...cliOptions(), '--receipt-file', receiptFile]),
      /exact expected release identity/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
