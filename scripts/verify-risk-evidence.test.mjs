/** @file Regression coverage for verify risk evidence: repository manifest covers every required capability and reports the optional physical gap. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  NATIVE_RELEASE_ARTIFACT_CONTRACTS,
  NATIVE_RELEASE_CHECKPOINT_DEFINITIONS,
  NATIVE_RELEASE_CHECKPOINT_GROUPS,
  NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
  NATIVE_RELEASE_PROTOCOL
} from './native-release-evidence.mjs';
import {
  loadRepositoryRiskEvidence,
  parseRiskEvidenceArgs,
  validateRiskEvidence
} from './verify-risk-evidence.mjs';

function repositoryFixture() {
  const loaded = loadRepositoryRiskEvidence();
  return {
    ...loaded,
    manifest: structuredClone(loaded.manifest),
    now: new Date('2026-07-13T12:00:00.000Z'),
  };
}

function attachPhysicalEvidence(fixture, options = {}) {
  const sourceCommit = options.sourceCommit ?? 'a'.repeat(40);
  const resultArtifact = 'quality/physical-results/test-fixture.json';
  const manifestContent = fs.readFileSync(path.join(fixture.repoRoot, 'shared', 'release.json'));
  const releaseManifest = JSON.parse(manifestContent.toString('utf8'));
  const signerSha256 = 'c'.repeat(64);
  const capabilities = Object.keys(NATIVE_RELEASE_CHECKPOINT_GROUPS).sort();
  const checkpoints = Object.fromEntries(
    Object.entries(NATIVE_RELEASE_CHECKPOINT_DEFINITIONS).map(
      ([checkpoint, definition]) => [checkpoint, { ...definition, outcome: true }]
    )
  );
  const artifacts = NATIVE_RELEASE_ARTIFACT_CONTRACTS.map((contract, index) => {
    const client = contract.role === 'phone' ? 'mobile' : 'wear';
    return {
      ...contract,
      sizeBytes: 1_000 + index,
      sha256: `${index + 1}`.repeat(64),
      applicationId: releaseManifest.android.application_id,
      versionName: releaseManifest.android[client].version_name,
      versionCode: releaseManifest.android[client].version_code,
      signerSha256
    };
  });
  const installState = (versionName, versionCode) => ({
    versionName,
    versionCode,
    firstInstallTime: '2026-07-01 10:00:00',
    signerSha256
  });
  const versionFor = (role) => artifacts.find(
    (artifact) => artifact.role === role && artifact.format === 'apk'
  );
  const phoneVersion = versionFor('phone');
  const watchVersion = versionFor('watch');
  const releaseManifestRecord = {
    path: 'shared/release.json',
    sha256: crypto.createHash('sha256').update(manifestContent).digest('hex')
  };
  const buildProvenance = {
    schemaVersion: 1,
    sourceCommit,
    releaseManifest: releaseManifestRecord,
    artifacts: artifacts.map((artifact) => Object.fromEntries(
      Object.entries(artifact).filter(([field]) => field !== 'signerSha256')
    ))
  };
  const resultArtifactContents = {
    schemaVersion: NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
    status: 'passed',
    owner: 'MChartier',
    executedOn: '2026-07-13',
    sourceCommit,
    protocol: NATIVE_RELEASE_PROTOCOL,
    syntheticAccount: true,
    buildProvenance,
    releaseManifest: releaseManifestRecord,
    artifacts,
    devices: [
      {
        role: 'phone',
        deviceClass: 'handset',
        manufacturer: 'Samsung',
        model: 'Galaxy phone fixture',
        osVersion: 'Android fixture',
        apiLevel: 36,
        isPhysical: true,
        isEmulator: false
      },
      {
        role: 'watch',
        deviceClass: 'watch',
        manufacturer: 'Samsung Electronics',
        model: 'Galaxy Watch Ultra fixture',
        osVersion: 'Wear OS fixture',
        apiLevel: 35,
        isPhysical: true,
        isEmulator: false
      }
    ],
    upgrades: {
      phone: {
        explicitAdbTarget: true,
        installMode: 'adb-install-r',
        uninstallPerformed: false,
        dataCleared: false,
        pre: installState('previous-phone', phoneVersion.versionCode - 1),
        post: installState(phoneVersion.versionName, phoneVersion.versionCode)
      },
      watch: {
        explicitAdbTarget: true,
        installMode: 'adb-install-r',
        uninstallPerformed: false,
        dataCleared: false,
        pre: installState('previous-watch', watchVersion.versionCode - 1),
        post: installState(watchVersion.versionName, watchVersion.versionCode)
      }
    },
    checkpoints,
    capabilities
  };
  const physicalRecord = {
    id: 'recorded-physical-validation',
    riskArea: 'critical-client-workflows',
    status: 'passed',
    owner: resultArtifactContents.owner,
    executedOn: resultArtifactContents.executedOn,
    sourceCommit,
    protocolPath: NATIVE_RELEASE_PROTOCOL,
    resultArtifact,
    capabilities
  };
  fixture.manifest.physicalDeviceEvidence.push(physicalRecord);
  fixture.manifest.diagnosticGaps = fixture.manifest.diagnosticGaps.filter(
    (gap) => gap.id !== 'physical-galaxy-phone-and-watch-validation'
  );
  fixture.statSync = (resolvedPath) => resolvedPath.endsWith('test-fixture.json')
    ? { isFile: () => true, size: 100 }
    : fs.statSync(resolvedPath);
  fixture.readFileSync = (resolvedPath, encoding) => resolvedPath.endsWith('test-fixture.json')
    ? JSON.stringify(resultArtifactContents)
    : fs.readFileSync(resolvedPath, encoding);
  return { physicalRecord, resultArtifactContents };
}

test('repository manifest covers every required capability and reports the optional physical gap', () => {
  const result = validateRiskEvidence(repositoryFixture());

  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(result.gaps.map((gap) => gap.id), [
    'physical-galaxy-phone-and-watch-validation'
  ]);
});

test('missing risk capability fails even when the rest of the area has evidence', () => {
  const fixture = repositoryFixture();
  const area = fixture.manifest.riskAreas.find(
    (candidate) => candidate.id === 'authentication-and-authorization'
  );
  for (const evidence of area.evidence) {
    evidence.capabilities = evidence.capabilities.filter((capability) => capability !== 'success');
  }

  const result = validateRiskEvidence(fixture);

  assert.ok(result.errors.includes(
    'Risk area authentication-and-authorization has no evidence or diagnostic gap for success.'
  ));
});

test('unknown npm scripts and missing or escaping evidence paths fail validation', () => {
  const fixture = repositoryFixture();
  const evidence = fixture.manifest.riskAreas[0].evidence[0];
  evidence.npmScript = 'test:not-a-real-script';
  evidence.paths = ['quality/not-present.test.ts', '../outside.test.ts'];

  const result = validateRiskEvidence(fixture);

  assert.ok(result.errors.some((error) => error.includes('unknown root npm script')));
  assert.ok(result.errors.some((error) => error.includes('does not exist')));
  assert.ok(result.errors.some((error) => error.includes('must stay within the repository')));
});

test('changed npm commands cannot retain stale evidence claims', () => {
  const fixture = repositoryFixture();
  fixture.packageScripts['test:backend'] = 'node -e "process.exit(0)"';

  const result = validateRiskEvidence(fixture);

  assert.ok(result.errors.some((error) => error.includes('npm script command changed')));
});

test('workflow-backed evidence fails when its test command is removed', () => {
  const fixture = repositoryFixture();
  const evidence = fixture.manifest.riskAreas
    .find((area) => area.id === 'synchronization-and-offline-writes')
    .evidence.find((item) => item.id === 'watch-reconciliation');
  evidence.workflowContains = './gradlew command-that-does-not-exist';

  const result = validateRiskEvidence(fixture);

  assert.ok(result.errors.some((error) => error.includes('workflow no longer contains')));
});

test('every diagnostic gap requires a scoped owner, reason, issue, and known capability', () => {
  const fixture = repositoryFixture();
  const area = fixture.manifest.riskAreas.find(
    (candidate) => candidate.id === 'authentication-and-authorization'
  );
  for (const evidence of area.evidence) {
    evidence.capabilities = evidence.capabilities.filter((capability) => capability !== 'success');
  }
  fixture.manifest.diagnosticGaps.push({
    id: 'incomplete-gap',
    riskArea: 'authentication-and-authorization',
    status: 'diagnostic',
    capabilities: ['success']
  });

  const result = validateRiskEvidence(fixture);

  assert.ok(result.errors.includes('Diagnostic gap incomplete-gap must name an owner.'));
  assert.ok(result.errors.includes('Diagnostic gap incomplete-gap must explain why evidence is outstanding.'));
  assert.ok(result.errors.some((error) => error.includes('trackingIssues must contain')));
});

test('physical evidence replaces the temporary diagnostic gap', () => {
  const fixture = repositoryFixture();
  attachPhysicalEvidence(fixture);

  const result = validateRiskEvidence(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(result.gaps.length, 0);
});
test('risk inventory CLI has no release-gate mode', () => {
  assert.deepEqual(parseRiskEvidenceArgs([]), {});
  assert.throws(() => parseRiskEvidenceArgs(['--release']), /Unknown risk-evidence option/);
});

test('ordinary unit evidence cannot clear a physical-device capability', () => {
  const fixture = repositoryFixture();
  const evidence = fixture.manifest.riskAreas
    .find((area) => area.id === 'critical-client-workflows')
    .evidence[0];
  evidence.capabilities.push('wear-physical-happy-path');

  const result = validateRiskEvidence(fixture);

  assert.ok(result.errors.some((error) => error.includes('use physicalDeviceEvidence')));
});
