/** @file Verify Calibrate's shared-engine selection, paired reservations, asynchronous barriers and partial baselines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateCalibrateNativeCodes, canRunCalibrateStage, completedCalibrateBaseline,
  checkpointReleaseOperation, incompleteCalibrateStages, sealCalibrateRecord, selectCalibrateComponents,
  transitionReleaseOperation, verifyCalibrateRecord
} from './release-engine.mjs';
import { createPlan } from '../tools/release-engine/index.mjs';

test('retained plans bind original source, trusted workflow, toolkit, selected graph and provider configuration', () => {
  const record = sealCalibrateRecord({ repository: 'MChartier/calibrate-health', source_commit: 'a'.repeat(40),
    workflow_sha: 'b'.repeat(40), run_id: '100', baseline: null,
    plan: { server: false, native: false, ota_internal: true, ota_production: false } });
  assert.equal(verifyCalibrateRecord(record), true);
  for (const field of ['source_commit', 'workflow_sha', 'toolkit_sha']) {
    assert.throws(() => verifyCalibrateRecord({ ...record, [field]: 'c'.repeat(40) }), /source .* differs/);
  }
  assert.throws(() => verifyCalibrateRecord({ ...record, plan: { ...record.plan, server: true } }), /immutable engine plan/);
  const { schemaVersion, kind, digest, ...payload } = record.engine_plan;
  const changedConfig = createPlan({ ...payload, config: { ...payload.config,
    expo: { ...payload.config.expo, projectId: 'another-project' } } });
  assert.throws(() => verifyCalibrateRecord({ ...record, engine_plan: changedConfig }), /destination\/configuration/);
  assert.equal(verifyCalibrateRecord({ schema_version: 1 }), false);
});

test('no-op, server-only and independent OTA channels select only applicable pieces', () => {
  assert.equal(selectCalibrateComponents({}).noop, true);
  const server = selectCalibrateComponents({ serverChanges: ['backend/src/index.ts'] });
  assert.deepEqual([server.server, server.native, server.ota_internal, server.ota_production], [true, false, false, false]);
  const ota = selectCalibrateComponents({ productionChanges: ['mobile/src/view.native.tsx'] });
  assert.deepEqual([ota.server, ota.native, ota.ota_internal, ota.ota_production], [false, false, false, true]);
});

test('paired native preparation selects diagnostic server metadata and the newly versioned phone runtime OTA', () => {
  const wear = selectCalibrateComponents({ wearChanged: true, reserveNative: true });
  assert.deepEqual([wear.server, wear.native, wear.ota_internal, wear.ota_production], [true, true, true, true]);
  assert.ok(wear.selection.selected.includes('phone'));
  assert.ok(wear.selection.selected.includes('wear'));
});

test('major server contract change selects both OTA channels without requiring native binaries', () => {
  const result = selectCalibrateComponents({ serverChanges: ['backend/src/api.ts'], bump: 'major' });
  assert.deepEqual([result.server, result.native, result.ota_internal, result.ota_production], [true, false, true, true]);
});

test('native allocations preserve 11/12 bootstrap, parity and abandoned higher reservations', () => {
  const manifest = { android: { mobile: { version_code: 11 }, wear: { version_code: 12 } } };
  assert.deepEqual(allocateCalibrateNativeCodes(manifest), { mobileVersionCode: 13, wearVersionCode: 14 });
  assert.deepEqual(allocateCalibrateNativeCodes(manifest, 20), { mobileVersionCode: 21, wearVersionCode: 22 });
});

test('OTA waits for verified phone handoff and selected deployment, not completed store submissions', () => {
  const record = { plan: { server: true, native: true, ota_internal: true, ota_production: true } };
  const checkpoints = [
    { stage: 'image', status: 'succeeded', asset_id: 1 },
    { stage: 'deploy', status: 'succeeded', asset_id: 2 },
    { stage: 'native-build', status: 'succeeded', asset_id: 3 },
    { stage: 'phone-submit', status: 'queued', submission_id: 'provider-id', asset_id: 4 }
  ];
  assert.equal(canRunCalibrateStage(record, checkpoints, 'ota-internal'), false);
  checkpoints.push({ stage: 'phone-handoff', status: 'succeeded', asset_id: 5 });
  assert.equal(canRunCalibrateStage(record, checkpoints, 'ota-internal'), true);
  assert.equal(canRunCalibrateStage(record, checkpoints, 'wear-submit'), false);
  assert.ok(incompleteCalibrateStages(record, checkpoints).includes('phone-submit'));
});

test('client-only graph never requires a deployment or image receipt', () => {
  const record = { plan: { server: false, native: false, ota_internal: true, ota_production: false } };
  const bookkeeping = [{ stage: 'prepared', status: 'succeeded', asset_id: 1 },
    { stage: 'ota-internal-artifact', status: 'succeeded', asset_id: 2 }];
  assert.equal(canRunCalibrateStage(record, bookkeeping, 'ota-internal'), true);
  assert.deepEqual(incompleteCalibrateStages(record, bookkeeping), ['ota-internal']);
});

test('partial native failure preserves server and OTA success without advancing the paired native baseline', () => {
  const source = 'a'.repeat(40);
  const record = { source_commit: source, baseline: {}, plan: { server: true, native: true,
    ota_internal: true, ota_production: true, native_codes: { mobileVersionCode: 13,
    wearVersionCode: 14 }, native_version: '0.2.8' } };
  const checkpoints = [
    { stage: 'image', status: 'succeeded', asset_id: 1 },
    { stage: 'deploy', status: 'succeeded', asset_id: 2 },
    { stage: 'native-build', status: 'succeeded', native: { version: '0.2.8' }, asset_id: 3 },
    { stage: 'phone-handoff', status: 'succeeded', asset_id: 4 },
    { stage: 'phone-submit', status: 'failed', asset_id: 5 },
    { stage: 'wear-submit', status: 'succeeded', asset_id: 6 },
    { stage: 'ota-internal', status: 'succeeded', publication: { group: 'published' }, asset_id: 7 }
  ];
  const result = completedCalibrateBaseline(record, checkpoints);
  assert.equal(result.server.source_commit, source);
  assert.equal(result.ota_internal.group, 'published');
  assert.equal(result.native, undefined);
  assert.equal(result.reserved_native_code, 14);
});

test('isolated success receipts cannot bypass missing transitive prerequisites when advancing baselines', () => {
  const record = { source_commit: 'a'.repeat(40), baseline: {}, plan: { server: true, native: true,
    ota_internal: true, ota_production: false, native_codes: { mobileVersionCode: 13, wearVersionCode: 14 } } };
  const checkpoints = [
    { stage: 'deploy', status: 'succeeded', asset_id: 1 },
    { stage: 'native-build', status: 'succeeded', native: { version: '0.2.8' }, asset_id: 2 },
    { stage: 'phone-submit', status: 'succeeded', asset_id: 3 },
    { stage: 'wear-submit', status: 'succeeded', asset_id: 4 },
    { stage: 'ota-internal', status: 'succeeded', publication: { group: 'unproven' }, asset_id: 5 }
  ];
  const result = completedCalibrateBaseline(record, checkpoints);
  assert.equal(result.server, undefined);
  assert.equal(result.native, undefined);
  assert.equal(result.ota_internal, undefined);
  assert.equal(result.reserved_native_code, 14);
});

test('legacy verified phone completion proves handoff without adding a retroactive checkpoint requirement', () => {
  const record = { schema_version: 1, source_commit: 'a'.repeat(40), baseline: {}, plan: {
    server: false, native: true, ota_internal: true, ota_production: false,
    native_codes: { mobileVersionCode: 13, wearVersionCode: 14 } } };
  const checkpoints = [
    { stage: 'native-build', status: 'succeeded', native: { version: '0.2.8' }, asset_id: 1 },
    { stage: 'phone-submit', status: 'succeeded', submission_id: 'verified-provider-id', asset_id: 2 },
    { stage: 'wear-submit', status: 'succeeded', asset_id: 3 },
    { stage: 'ota-internal', status: 'succeeded', publication: { group: 'published' }, asset_id: 4 }
  ];
  assert.deepEqual(incompleteCalibrateStages(record, checkpoints), []);
  assert.equal(completedCalibrateBaseline(record, checkpoints).native.version, '0.2.8');
  assert.equal(completedCalibrateBaseline(record, checkpoints).ota_internal.group, 'published');
  const queued = checkpoints.filter((checkpoint) => checkpoint.stage !== 'ota-internal').map((checkpoint) => checkpoint.stage === 'phone-submit'
    ? { ...checkpoint, status: 'queued' } : checkpoint);
  assert.equal(canRunCalibrateStage(record, queued, 'ota-internal'), false);
  assert.equal(completedCalibrateBaseline(record, queued).native, undefined);
  assert.ok(incompleteCalibrateStages({ ...record, engine_plan: {} }, checkpoints).includes('phone-handoff'));
});

test('a legacy OTA success remains complete when the asynchronous phone submission subsequently fails', () => {
  const record = { schema_version: 1, source_commit: 'a'.repeat(40), baseline: {}, plan: {
    server: false, native: true, ota_internal: true, ota_production: false } };
  const checkpoints = [
    { stage: 'native-build', status: 'succeeded', native: { version: '0.2.8' }, asset_id: 1 },
    { stage: 'phone-submit', status: 'queued', submission_id: 'provider-id', asset_id: 2 },
    { stage: 'ota-internal', status: 'succeeded', publication: { group: 'published' }, asset_id: 3 },
    { stage: 'phone-submit', status: 'failed', asset_id: 4 }
  ];
  const baseline = completedCalibrateBaseline(record, checkpoints);
  assert.equal(baseline.ota_internal.group, 'published');
  assert.equal(baseline.native, undefined);
  assert.deepEqual(incompleteCalibrateStages(record, checkpoints), ['phone-submit', 'wear-submit']);
});

test('ambiguous provider outcome cannot be blindly retried', () => {
  const intent = transitionReleaseOperation(null, { type: 'intent', operationKey: 'phone-submit' });
  const unknown = transitionReleaseOperation(intent, { type: 'unknown', reason: 'Connection lost' });
  assert.throws(() => transitionReleaseOperation(unknown, { type: 'retry' }));
});

test('durable shared operations preserve accepted IDs and block a second enqueue', async () => {
  const checkpoints = [];
  const store = { read: async () => ({ checkpoints }), checkpoint: async (_release, stage, value) => {
    checkpoints.push({ ...value, stage, asset_id: checkpoints.length + 1 });
  } };
  await checkpointReleaseOperation(store, '1', 'phone-submit', { type: 'intent', operationKey: 'phone-submit' });
  assert.equal(checkpoints[0].status, 'enqueueing');
  await checkpointReleaseOperation(store, '1', 'phone-submit', { type: 'accepted', operationId: 'exact-provider-id' });
  assert.equal(checkpoints[1].submission_id, 'exact-provider-id');
  await assert.rejects(checkpointReleaseOperation(store, '1', 'phone-submit', { type: 'intent', operationKey: 'phone-submit' }));
  await checkpointReleaseOperation(store, '1', 'phone-submit', { type: 'complete', receipt: { id: 'exact-provider-id', status: 'FINISHED' } });
  assert.equal(checkpoints[2].status, 'succeeded');
});

test('legacy interrupted intent requires verified reconciliation before completion or retry', async () => {
  const checkpoints = [{ stage: 'ota-internal', status: 'started', asset_id: 1 }];
  const store = { read: async () => ({ checkpoints }), checkpoint: async (_release, stage, value) => {
    checkpoints.push({ ...value, stage, asset_id: checkpoints.length + 1 });
  } };
  await assert.rejects(checkpointReleaseOperation(store, '1', 'ota-internal', { type: 'retry' }));
  await assert.rejects(checkpointReleaseOperation(store, '1', 'ota-internal', { type: 'complete', receipt: { group: 'exact-group' } }));
  await checkpointReleaseOperation(store, '1', 'ota-internal', { type: 'complete', receipt: { group: 'exact-group' },
    proof: { verifiedProviderGroup: 'exact-group' } }, { publication: { group: 'exact-group' } });
  assert.equal(checkpoints[1].status, 'succeeded');
});

test('legacy operator-confirmed absence permits one retry while missing evidence remains unknown', async () => {
  for (const stage of ['deploy', 'ota-internal', 'phone-submit']) {
    const checkpoints = [{ stage, status: 'not-published', asset_id: 1,
      reconciliation: { confirmed: true, evidence: 'Inspected provider logs and verified that no operation was created.' } }];
    const store = { read: async () => ({ checkpoints }), checkpoint: async (_id, name, value) => {
      checkpoints.push({ ...value, stage: name, asset_id: checkpoints.length + 1 });
    } };
    const operation = await checkpointReleaseOperation(store, '1', stage, { type: 'retry' });
    assert.equal(operation.status, 'intent');
    assert.equal(operation.history[0].proof.confirmed, true);
    await assert.rejects(checkpointReleaseOperation(store, '1', stage, { type: 'retry' }));
    checkpoints.splice(0, checkpoints.length, { stage, status: 'not-published', asset_id: 1 });
    await assert.rejects(checkpointReleaseOperation(store, '1', stage, { type: 'retry' }));
  }
});
