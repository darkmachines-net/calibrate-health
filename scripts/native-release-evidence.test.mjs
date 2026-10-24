/** @file Regression coverage for native release evidence: validates four signed artifacts, physical Samsung metadata, strict upgrades, and derived capabilities. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  NATIVE_RELEASE_ARTIFACT_CONTRACTS,
  NATIVE_RELEASE_CHECKPOINT_DEFINITIONS,
  NATIVE_RELEASE_CHECKPOINT_GROUPS,
  NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
  NATIVE_RELEASE_OBSERVATION_SCHEMA_VERSION,
  NATIVE_RELEASE_PROTOCOL,
  deriveNativeReleaseCapabilities,
  finalizeNativeReleaseEvidence,
  nativeReleaseEvidenceResultPath,
  parseKeytoolSignerFingerprint,
  parseNativeReleaseEvidenceArgs,
  validateNativeReleaseEvidence
} from './native-release-evidence.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);
const SIGNER = 'c'.repeat(64);
const MANIFEST = `${JSON.stringify({
  schema_version: 1,
  android: {
    application_id: 'net.darkmachines.healthtracker',
    mobile: { version_name: '1.2.3', version_code: 12 },
    wear: { version_name: '2.3.4', version_code: 23 }
  }
}, null, 2)}\n`;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function evidenceFixture() {
  const checkpoints = Object.fromEntries(Object.entries(NATIVE_RELEASE_CHECKPOINT_DEFINITIONS).map(
    ([checkpoint, definition]) => [checkpoint, { ...definition, outcome: true }]
  ));
  const artifacts = NATIVE_RELEASE_ARTIFACT_CONTRACTS.map((contract, index) => {
    const version = contract.role === 'phone'
      ? { versionName: '1.2.3', versionCode: 12 }
      : { versionName: '2.3.4', versionCode: 23 };
    return {
      ...contract,
      sizeBytes: 1_000 + index,
      sha256: `${index + 1}`.repeat(64),
      applicationId: 'net.darkmachines.healthtracker',
      ...version,
      signerSha256: SIGNER
    };
  });
  const installState = (versionName, versionCode, firstInstallTime = '2026-08-01 10:00:00') => ({
    versionName,
    versionCode,
    firstInstallTime,
    signerSha256: SIGNER
  });
  const releaseManifest = { path: 'shared/release.json', sha256: digest(MANIFEST) };
  const buildProvenance = {
    schemaVersion: 1,
    sourceCommit: SOURCE_COMMIT,
    releaseManifest,
    artifacts: artifacts.map((artifact) => Object.fromEntries(
      Object.entries(artifact).filter(([field]) => field !== 'signerSha256')
    ))
  };
  return {
    schemaVersion: NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
    status: 'passed',
    owner: 'release-owner',
    executedOn: '2026-08-09',
    sourceCommit: SOURCE_COMMIT,
    protocol: NATIVE_RELEASE_PROTOCOL,
    syntheticAccount: true,
    buildProvenance,
    releaseManifest,
    artifacts,
    devices: [
      {
        role: 'phone',
        deviceClass: 'handset',
        manufacturer: 'Samsung',
        model: 'Galaxy phone fixture',
        osVersion: 'Android 16',
        apiLevel: 36,
        isPhysical: true,
        isEmulator: false
      },
      {
        role: 'watch',
        deviceClass: 'watch',
        manufacturer: 'Samsung Electronics',
        model: 'Galaxy Watch Ultra fixture',
        osVersion: 'Wear OS 6',
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
        pre: installState('1.2.2', 11),
        post: installState('1.2.3', 12)
      },
      watch: {
        explicitAdbTarget: true,
        installMode: 'adb-install-r',
        uninstallPerformed: false,
        dataCleared: false,
        pre: installState('2.3.3', 22),
        post: installState('2.3.4', 23)
      }
    },
    checkpoints,
    capabilities: Object.keys(NATIVE_RELEASE_CHECKPOINT_GROUPS).sort()
  };
}

test('validates four signed artifacts, physical Samsung metadata, strict upgrades, and derived capabilities', () => {
  const fixture = evidenceFixture();
  const result = validateNativeReleaseEvidence(fixture, {
    candidateCommit: SOURCE_COMMIT,
    manifestContent: MANIFEST
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.signerSha256, SIGNER);
  assert.deepEqual(result.capabilities, Object.keys(NATIVE_RELEASE_CHECKPOINT_GROUPS).sort());
  assert.deepEqual(deriveNativeReleaseCapabilities(fixture.checkpoints), result.capabilities);
});

test('rejects paths that can escape the repository and requires all four independent signer rows', () => {
  const fixture = evidenceFixture();
  fixture.artifacts[0].path = 'C:\\Users\\person\\phone.apk';
  fixture.artifacts[1].signerSha256 = 'd'.repeat(64);

  const result = validateNativeReleaseEvidence(fixture, { manifestContent: MANIFEST });

  assert.ok(result.errors.some((error) => error.includes('canonical repository-relative output path')));
  assert.ok(result.errors.some((error) => error.includes('share one independently inspected signer')));
  assert.throws(
    () => nativeReleaseEvidenceResultPath('C:\\Users\\person\\galaxy.json'),
    /repository-relative JSON path/
  );
  assert.throws(
    () => nativeReleaseEvidenceResultPath('quality/../private/galaxy.json'),
    /repository-relative JSON path/
  );
});

test('device evidence rejects serial-like fields, non-Samsung targets, and emulators', () => {
  const fixture = evidenceFixture();
  fixture.devices[0].serial = 'R5C-do-not-retain';
  fixture.devices[0].manufacturer = 'Google';
  fixture.devices[1].isPhysical = false;
  fixture.devices[1].isEmulator = true;

  const result = validateNativeReleaseEvidence(fixture, { manifestContent: MANIFEST });

  assert.ok(result.errors.some((error) => error.includes('must not retain serial-like field serial')));
  assert.ok(result.errors.some((error) => error.includes('unexpected fields: serial')));
  assert.ok(result.errors.some((error) => error.includes('manufactured by Samsung')));
  assert.ok(result.errors.some((error) => error.includes('physical, non-emulator Samsung target')));
});

test('strict upgrade evidence requires a lower same-signer version, install -r, and unchanged firstInstallTime', () => {
  const fixture = evidenceFixture();
  fixture.upgrades.phone.pre.versionCode = 12;
  fixture.upgrades.phone.pre.signerSha256 = 'd'.repeat(64);
  fixture.upgrades.phone.post.firstInstallTime = '2026-08-09 10:00:00';
  fixture.upgrades.phone.installMode = 'fresh-install';
  fixture.upgrades.watch.explicitAdbTarget = false;

  const result = validateNativeReleaseEvidence(fixture, { manifestContent: MANIFEST });

  assert.ok(result.errors.some((error) => error.includes('pre-version must be strictly lower')));
  assert.ok(result.errors.some((error) => error.includes('pre/candidate/post signers must match')));
  assert.ok(result.errors.some((error) => error.includes('firstInstallTime must remain unchanged')));
  assert.ok(result.errors.some((error) => error.includes('adb install -r only')));
  assert.ok(result.errors.some((error) => error.includes('explicit ADB target')));
});

test('checkpoint records require allowlisted command/capability IDs and boolean outcomes', () => {
  const fixture = evidenceFixture();
  fixture.checkpoints['phone-food-create'].outcome = false;
  fixture.checkpoints['phone-food-edit'].commandId = 'adb --phone-serial private-value';
  fixture.checkpoints['operator-freeform-claim'] = {
    commandId: 'operator-freeform-command',
    capabilityId: 'operator-freeform-capability',
    outcome: true
  };
  fixture.capabilities = Object.keys(NATIVE_RELEASE_CHECKPOINT_GROUPS);

  const result = validateNativeReleaseEvidence(fixture, { manifestContent: MANIFEST });

  assert.ok(result.errors.some((error) => error.includes('not allowlisted: operator-freeform-claim')));
  assert.ok(result.errors.some((error) => error.includes('phone-food-edit commandId must be protocol-phone-food-edit')));
  assert.ok(result.errors.some((error) => error.includes('capabilities must equal the capabilities derived')));
  assert.ok(result.errors.some((error) => error.includes('Every physical phone/watch checkpoint group must pass')));
});

test('release manifest provenance is bound to the frozen candidate bytes and canonical versions', () => {
  const fixture = evidenceFixture();
  fixture.releaseManifest.sha256 = '0'.repeat(64);
  fixture.artifacts.find(({ id }) => id === 'watch-aab').versionCode = 999;

  const result = validateNativeReleaseEvidence(fixture, {
    candidateCommit: 'f'.repeat(40),
    manifestContent: MANIFEST
  });

  assert.ok(result.errors.some((error) => error.includes('does not match candidate')));
  assert.ok(result.errors.some((error) => error.includes('does not match candidate shared/release.json')));
  assert.ok(result.errors.some((error) => error.includes('versionCode does not match shared/release.json')));
});

test('retained build provenance rejects stale candidates and old same-version artifact bytes', () => {
  const fixture = evidenceFixture();
  fixture.buildProvenance.sourceCommit = 'b'.repeat(40);
  fixture.buildProvenance.artifacts.find(({ id }) => id === 'phone-apk').sha256 = 'f'.repeat(64);

  const result = validateNativeReleaseEvidence(fixture, {
    candidateCommit: SOURCE_COMMIT,
    manifestContent: MANIFEST
  });

  assert.ok(result.errors.some((error) => error.includes('build provenance sourceCommit must match candidate C')));
  assert.ok(result.errors.some((error) =>
    error.includes('Build provenance phone-apk sha256 must match the retained independently inspected artifact')
  ));
});

test('rejects future execution dates and non-allowlisted protocol text', () => {
  const fixture = evidenceFixture();
  fixture.executedOn = '2026-08-10';
  fixture.protocol = 'adb --phone-serial private-value';

  const result = validateNativeReleaseEvidence(fixture, {
    manifestContent: MANIFEST,
    now: new Date('2026-08-09T23:59:59Z')
  });

  assert.ok(result.errors.includes('Native release evidence executedOn cannot be in the future.'));
  assert.ok(result.errors.some((error) => error.includes('protocol must be quality/README.md')));
});

test('rejects calendar dates that JavaScript would otherwise normalize', () => {
  const fixture = evidenceFixture();
  fixture.executedOn = '2026-02-31';

  const result = validateNativeReleaseEvidence(fixture, {
    manifestContent: MANIFEST,
    now: new Date('2026-08-09T23:59:59Z')
  });

  assert.ok(result.errors.includes('Native release evidence executedOn must be a valid YYYY-MM-DD date.'));
});

test('AAB signer parser requires a real keytool SHA-256 fingerprint', () => {
  const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':');
  assert.equal(
    parseKeytoolSignerFingerprint(`Owner: CN=fixture\nSHA256: ${fingerprint}\nSignature algorithm name: SHA256withRSA`),
    fingerprint.replaceAll(':', '')
  );
  assert.throws(
    () => parseKeytoolSignerFingerprint('SHA1: 00:11'),
    /exactly one unique signing certificate/
  );
  const other = 'ff'.repeat(32).match(/.{2}/g).join(':');
  assert.throws(
    () => parseKeytoolSignerFingerprint(`SHA256: ${fingerprint}\nSHA256: ${other}`),
    /exactly one unique signing certificate/
  );
});

test('finalization copies capture facts, requires synthetic-account checkpoints, and derives claims', () => {
  const fixture = evidenceFixture();
  const observation = {
    schemaVersion: NATIVE_RELEASE_OBSERVATION_SCHEMA_VERSION,
    sourceCommit: fixture.sourceCommit,
    buildProvenance: fixture.buildProvenance,
    releaseManifest: fixture.releaseManifest,
    artifacts: fixture.artifacts,
    devices: fixture.devices,
    upgrades: fixture.upgrades
  };
  const finalized = finalizeNativeReleaseEvidence(observation, {
    owner: fixture.owner,
    executedOn: fixture.executedOn,
    syntheticAccount: true,
    checkpoints: fixture.checkpoints
  }, { manifestContent: MANIFEST });
  assert.deepEqual(finalized, fixture);

  assert.throws(() => finalizeNativeReleaseEvidence(observation, {
    owner: fixture.owner,
    executedOn: fixture.executedOn,
    syntheticAccount: false,
    checkpoints: fixture.checkpoints
  }, { manifestContent: MANIFEST }), /must use only a synthetic account/);
});

test('CLI verifies an optional physical result without an evidence commit', () => {
  assert.deepEqual(parseNativeReleaseEvidenceArgs([
    'verify',
    '--result', 'quality/physical-results/galaxy.json',
    '--candidate', SOURCE_COMMIT
  ]), {
    command: 'verify',
    result: 'quality/physical-results/galaxy.json',
    candidate: SOURCE_COMMIT,
    observation: null,
    checkpoints: null,
    output: null,
    owner: null,
    executedOn: null,
    syntheticAccount: false,
    help: false
  });
});
