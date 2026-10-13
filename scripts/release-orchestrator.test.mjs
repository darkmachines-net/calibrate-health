/** @file Exercise component selection, partial release recovery, and the independent OTA/submission gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { affectsComponent, selectRelease, applicationContent, wearInputHash } from './release-selection.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { completedBaseline, latestCheckpoint, validateRecord } from './release-record.mjs';
import { unfinishedStages, finishRelease, recoveryInputs } from './release-orchestrator.mjs';
import { parseSubmissionId, verifySubmission, queueSubmission, waitForSubmission, writeSubmissionProject } from './native-eas-submit.mjs';

const manifest = { server: { version: '0.40.1' }, android: { mobile: { version_name: '0.2.7', version_code: 11 }, wear: { version_code: 12 } } };
const baseline = { native: { version: '0.2.7', runtime_version: 'a'.repeat(40), wear_hash: 'b'.repeat(64) } };
const base = { manifest, baseline, serverChanges: [], otaChanges: [], runtimeVersion: 'a'.repeat(40), wearHash: 'b'.repeat(64), bump: 'patch' };

test('selection covers no-op, server-only, OTA-only, native, and combined releases', () => {
  assert.equal(selectRelease(base).noop, true);
  const server = selectRelease({ ...base, serverChanges: ['backend/src/index.ts'] });
  assert.equal(server.server, true);
  assert.equal(server.native, false);
  assert.equal(server.ota_internal, false);
  const ota = selectRelease({ ...base, otaChanges: ['mobile/src/view.native.tsx'] });
  assert.equal(ota.server, false);
  assert.equal(ota.ota_internal, true);
  const native = selectRelease({ ...base, wearHash: 'c'.repeat(64) });
  assert.equal(native.native, true);
  assert.equal(native.reserve_native, true);
  assert.equal(native.server, true, 'native diagnostic mirrors require server publication');
  assert.equal(native.ota_production, true, 'The paired native version bump introduces a new phone runtime');
  const first = selectRelease({ ...base, baseline: null });
  assert.equal(first.native, true);
  const major = selectRelease({ ...base, serverChanges: ['backend/src/index.ts'], bump: 'major' });
  assert.equal(major.ota_internal, true);
});

test('a reserved higher native version is reused instead of allocated twice', () => {
  const next = selectRelease({ ...base, manifest: { ...manifest, android: { mobile: { version_name: '0.2.8', version_code: 13 }, wear: { version_code: 14 } } }, runtimeVersion: 'c'.repeat(40) });
  assert.equal(next.native, true);
  assert.equal(next.reserve_native, false);
});

test('abandoned allocations remain burned while irrelevant bookkeeping is excluded', () => {
  const plan = selectRelease({ ...base, baseline: { ...baseline, reserved_native_code: 18 }, runtimeVersion: 'd'.repeat(40) });
  assert.deepEqual(plan.native_codes, { mobileVersionCode: 19, wearVersionCode: 20 });
  const original = { scripts: { 'test:release': 'old', build: 'build-app' }, version: '1.0.0' };
  const changed = { ...original, version: '1.0.1', scripts: { ...original.scripts, 'test:release': 'new' } };
  assert.equal(applicationContent('package.json', JSON.stringify(original)), applicationContent('package.json', JSON.stringify(changed)));
  assert.notEqual(applicationContent('package.json', JSON.stringify(original)), applicationContent('package.json', JSON.stringify({ ...original, scripts: { build: 'different-build' } })));
  const carried = completedBaseline({ baseline: {}, plan: { native_codes: plan.native_codes, native_version: plan.native_version } }, []);
  assert.equal(carried.reserved_native_code, 20);
});

test('release classification separates browser/native modules and excludes docs/tests', () => {
  for (const file of ['mobile/src/view.test.tsx', 'backend/docs/README.md', 'AGENTS.md', 'scripts/README.md']) {
    assert.equal(affectsComponent(file, 'server'), false);
    assert.equal(affectsComponent(file, 'ota'), false);
  }
  assert.equal(affectsComponent('mobile/src/view.native.tsx', 'server'), false);
  assert.equal(affectsComponent('mobile/src/view.native.tsx', 'ota'), true);
  assert.equal(affectsComponent('mobile/src/view.web.tsx', 'ota'), false);
  assert.equal(affectsComponent('mobile/src/view.tsx', 'server'), true);
  assert.equal(affectsComponent('mobile/src/view.tsx', 'ota'), true);
});

test('Wear unit and instrumentation tests do not select a new native release', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wear-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  /** Commit only disposable fixture inputs so production history stays untouched. */
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  for (const source of ['main', 'test', 'androidTest']) {
    fs.mkdirSync(path.join(root, 'wear/app/src', source), { recursive: true });
    fs.writeFileSync(path.join(root, 'wear/app/src', source, 'Example.kt'), 'initial');
  }
  git('add', '.');
  git('commit', '-m', 'Initial');
  const initial = wearInputHash(root, git('rev-parse', 'HEAD'));
  for (const source of ['test', 'androidTest']) fs.writeFileSync(path.join(root, 'wear/app/src', source, 'Example.kt'), 'changed');
  git('commit', '-am', 'Tests only');
  assert.equal(wearInputHash(root, git('rev-parse', 'HEAD')), initial);
  fs.writeFileSync(path.join(root, 'wear/app/src/main/Example.kt'), 'changed');
  git('commit', '-am', 'Application change');
  assert.notEqual(wearInputHash(root, git('rev-parse', 'HEAD')), initial);
});

test('partial outcomes preserve OTA/server success without claiming completed native distribution', () => {
  const record = { source_commit: 'a'.repeat(40), baseline: {}, plan: { server: true, native: true, ota_internal: true, ota_production: true } };
  const checkpoints = [
    { stage: 'image', status: 'succeeded', asset_id: 1 },
    { stage: 'deploy', status: 'succeeded', asset_id: 2 },
    { stage: 'native-build', status: 'succeeded', asset_id: 3, native: baseline.native },
    { stage: 'phone-handoff', status: 'succeeded', asset_id: 4 },
    { stage: 'phone-submit', status: 'failed', asset_id: 4 },
    { stage: 'ota-internal', status: 'succeeded', asset_id: 5, publication: { group: 'group-a' } }
  ];
  assert.deepEqual(unfinishedStages(record, checkpoints), ['ota-production', 'phone-submit', 'wear-submit']);
  const carried = completedBaseline(record, checkpoints);
  assert.equal(carried.server.source_commit, record.source_commit);
  assert.equal(carried.ota_internal.group, 'group-a');
  assert.equal(carried.native, undefined);
});

test('an ambiguous remote operation cannot be abandoned', async () => {
  const store = { read: async () => ({ record: { plan: { native: true } }, checkpoints: [{ stage: 'phone-submit', status: 'enqueueing', asset_id: 1 }] }) };
  await assert.rejects(finishRelease(store, '1', true), /Reconcile phone-submit/);
});

test('recovery carries the trusted producing run when durable native retention was interrupted', async () => {
  const source = 'a'.repeat(40);
  const store = { read: async () => ({ record: { run_id: '123', source_commit: source,
    plan: { server: false, native: true, ota_internal: true, ota_production: true } }, checkpoints: [] }) };
  const inputs = await recoveryInputs(store, '456');
  assert.equal(inputs.producing_run_id, '123');
  assert.equal(inputs.source_commit, source);
  assert.equal(inputs.native_build_complete, false);
  assert.equal(inputs.native, true);
});

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const submission = { id, platform: 'ANDROID', app: { id: 'fda8f8c5-e646-47ac-82fb-35003c9cbec7' }, androidConfig: { track: 'internal' }, status: 'IN_QUEUE' };

test('EAS profiles and provider readback use exact internal IDs for each form factor', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eas-track-profiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeSubmissionProject(directory);
  const profiles = JSON.parse(fs.readFileSync(path.join(directory, 'eas.json'), 'utf8')).submit;
  for (const [role, track, wrongTracks] of [
    ['phone', 'internal', ['qa', 'wear:internal', 'production']],
    ['wear', 'wear:internal', ['wear:qa', 'internal', 'wear:production']]
  ]) {
    assert.equal(profiles[role].android.track, track);
    assert.equal(profiles[role].android.releaseStatus, 'completed');
    assert.equal(verifySubmission({ ...submission, androidConfig: { track } }, id, role).id, id);
    for (const wrongTrack of wrongTracks) {
      assert.throws(() => verifySubmission({ ...submission, androidConfig: { track: wrongTrack } }, id, role), /track mismatch/);
    }
  }
});

/** In-memory append-only checkpoints let tests observe external-call ordering. */
function fakeStore(initial = []) {
  const checkpoints = [...initial];
  return {
    checkpoints,
    read: async () => ({ checkpoints }),
    checkpoint: async (_releaseId, stage, value) => checkpoints.push({ ...value, stage, asset_id: checkpoints.length + 1 })
  };
}

test('phone enqueue records intent and ID before readback, and returns while upload is queued', async () => {
  const store = fakeStore();
  const calls = [];
  /** Use the isolated pinned provider client; no source build runs with this authentication. */
  const runEas = (args) => {
    calls.push(args);
    if (args[0] === 'submit') {
      assert.equal(latestCheckpoint(store.checkpoints, 'phone-submit').status, 'enqueueing');
      return `Submission details: https://expo.dev/accounts/calibrate-health/projects/calibrate-health-app/submissions/${id}`;
    }
    assert.equal(latestCheckpoint(store.checkpoints, 'phone-submit').submission_id, id);
    return JSON.stringify(submission);
  };
  assert.equal(await queueSubmission({ store, releaseId: '1', role: 'phone', aab: '/exact.aab', runEas }), id);
  assert.ok(calls[0].includes('--no-wait'));
  assert.equal(calls.some((args) => args.includes('--latest')), false);
  await queueSubmission({ store, releaseId: '1', role: 'phone', aab: '/exact.aab', runEas });
  assert.equal(calls.filter((args) => args[0] === 'submit').length, 1);
});

test('ambiguous enqueue cannot be retried automatically', async () => {
  const store = fakeStore([{ stage: 'phone-submit', status: 'enqueueing', asset_id: 1 }]);
  await assert.rejects(queueSubmission({ store, releaseId: '1', role: 'phone', runEas: () => assert.fail('must not enqueue') }), /unresolved/);
  assert.throws(() => parseSubmissionId('No submission ID'), /ambiguous/);
  assert.throws(() => verifySubmission({ ...submission, androidConfig: { track: 'production' } }, id, 'phone'), /track mismatch/);
});

test('later submission failure is recorded without modifying OTA success', async () => {
  const store = fakeStore([{ stage: 'ota-internal', status: 'succeeded', asset_id: 1 },
    { stage: 'phone-submit', status: 'queued', submission_id: id, asset_id: 2 }]);
  await assert.rejects(waitForSubmission({ store, releaseId: '1', role: 'phone', id,
    runEas: () => JSON.stringify({ ...submission, status: 'ERRORED' }), sleep: async () => {} }), /OTA is independent/);
  assert.equal(latestCheckpoint(store.checkpoints, 'ota-internal').status, 'succeeded');
  assert.equal(latestCheckpoint(store.checkpoints, 'phone-submit').status, 'failed');
});

test('release records reject another repository and malformed source identities', () => {
  assert.throws(() => validateRecord({ schema_version: 1, repository: 'other/repo' }, 'MChartier/calibrate-health'), /identity/);
});
