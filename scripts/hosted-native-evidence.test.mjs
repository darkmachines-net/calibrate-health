/** @file Regression coverage for hosted native evidence: started hosted native evidence is exact, source-bound, and lane-specific. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createStartedHostedNativeEvidence,
  parseHostedNativeEvidenceArgs,
  validateHostedNativeEvidence,
  writeHostedNativeEvidence
} from './hosted-native-evidence.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);

function artifact(id, buildType = 'release') {
  return {
    id,
    packageName: 'net.darkmachines.healthtracker',
    versionName: buildType === 'debug' ? '0.2.5-dev' : '0.2.5',
    versionCode: 7,
    sha256: 'b'.repeat(64),
    buildType,
    disposableSigning: true
  };
}

function passedWearEvidence() {
  const evidence = createStartedHostedNativeEvidence('wear', SOURCE_COMMIT);
  return {
    ...evidence,
    status: 'passed',
    stage: 'completed',
    emulators: [{ role: 'wear', apiLevel: 35, model: 'Wear OS Small Round', abi: 'x86_64', physical: false }],
    artifacts: [artifact('wear-release')],
    checkpoints: Object.fromEntries(Object.keys(evidence.checkpoints).map((key) => [key, true])),
    wearAccessibility: {
      fontScales: [
        {
          fontScale: 1,
          screenWidthPx: 454,
          screenHeightPx: 454,
          densityDpi: 320,
          actionCount: 2,
          minimumWidthDp: 48,
          minimumHeightDp: 52
        },
        {
          fontScale: 1.3,
          screenWidthPx: 454,
          screenHeightPx: 454,
          densityDpi: 320,
          actionCount: 2,
          minimumWidthDp: 48,
          minimumHeightDp: 52
        }
      ]
    }
  };
}

test('started hosted native evidence is exact, source-bound, and lane-specific', () => {
  const evidence = createStartedHostedNativeEvidence('android', SOURCE_COMMIT);
  assert.deepEqual(validateHostedNativeEvidence(evidence), []);
  assert.equal(evidence.status, 'started');
  assert.equal(evidence.checkpoints.onlineLog, false);
  assert.equal(evidence.wearAccessibility, null);
});

test('passed Wear evidence requires both font scales and 48 dp targets', () => {
  const evidence = passedWearEvidence();
  assert.deepEqual(validateHostedNativeEvidence(evidence), []);

  evidence.wearAccessibility.fontScales[1].minimumWidthDp = 47.99;
  assert.ok(validateHostedNativeEvidence(evidence).some((error) => error.includes('at least 48 dp')));
});

test('passed evidence requires every reviewed emulator and artifact', () => {
  const evidence = passedWearEvidence();
  evidence.emulators = [];
  evidence.artifacts = [];
  const errors = validateHostedNativeEvidence(evidence);
  assert.ok(errors.some((error) => error.includes('every reviewed emulator role')));
  assert.ok(errors.some((error) => error.includes('every reviewed artifact')));
});
test('hosted evidence rejects unknown fields, absolute paths, and sensitive aliases', () => {
  for (const [key, value] of [
    ['deviceSerial', 'emulator-5554'],
    ['artifactPath', 'C:\\runner\\app.apk'],
    ['processIds', [123]],
    ['accountEmail', 'alice@example.test'],
    ['foodName', 'private meal'],
    ['rawXml', '<hierarchy />']
  ]) {
    const evidence = passedWearEvidence();
    evidence[key] = value;
    const errors = validateHostedNativeEvidence(evidence);
    assert.ok(errors.some((error) => error.includes('prohibited field') || error.includes('absolute path')));
  }
});

test('hosted evidence writes atomically and replaces only the requested summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-hosted-native-'));
  try {
    const file = path.join(root, 'wear.json');
    writeHostedNativeEvidence(file, createStartedHostedNativeEvidence('wear', SOURCE_COMMIT));
    writeHostedNativeEvidence(file, passedWearEvidence());
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'passed');
    assert.deepEqual(fs.readdirSync(root), ['wear.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hosted evidence CLI accepts only fixed init arguments', () => {
  assert.deepEqual(parseHostedNativeEvidenceArgs([
    'init', '--lane', 'wear', '--source-commit', SOURCE_COMMIT, '--output', 'wear.json'
  ]), {
    command: 'init',
    lane: 'wear',
    sourceCommit: SOURCE_COMMIT,
    output: 'wear.json'
  });
  assert.throws(() => parseHostedNativeEvidenceArgs(['finalize']), /command must be init/);
  assert.throws(() => parseHostedNativeEvidenceArgs(['init', '--token', 'secret']), /Unknown/);
});