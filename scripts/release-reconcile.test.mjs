/** @file Exercise explicit recovery evidence, exact provider readback, and prevention of duplicate enqueue. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRelease, validateReconciliation } from './release-reconcile.mjs';
import { queueSubmission, waitForSubmission, EAS_PROJECT_ID } from './native-eas-submit.mjs';

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const hash = 'a'.repeat(64);
const evidence = 'Inspected provider logs and matched the retained AAB SHA-256 and version code.';
const submission = { id, app: { id: EAS_PROJECT_ID }, platform: 'ANDROID', androidConfig: { track: 'internal' }, status: 'IN_QUEUE' };

/** Preserve append ordering and let assertions inspect every checkpoint mutation. */
function storeFixture(checkpoints) {
  return { state: { release: { draft: true }, record: { source_commit: 'c'.repeat(40) }, checkpoints },
    /** Return the in-memory recovery state without performing provider I/O. */
    async read() { return this.state; },
    /** Append test events in the same order as durable recovery assets. */
    async checkpoint(_id, stage, value) { this.state.checkpoints.push({ stage, ...value, asset_id: this.state.checkpoints.length + 1 }); } };
}

test('reconciliation rejects missing acknowledgement, unknown fields and malformed remote identity', () => {
  const value = { stage: 'phone-submit', status: 'observed', id, artifact_hash: hash, evidence, confirmed: true };
  assert.deepEqual(validateReconciliation(JSON.stringify(value)), value);
  assert.throws(() => validateReconciliation({ ...value, confirmed: false }), /explicit operator/);
  assert.throws(() => validateReconciliation({ ...value, extra: true }), /exact documented/);
  assert.throws(() => validateReconciliation({ ...value, id: 'latest' }), /exact ID/);
});

test('ambiguous phone enqueue resumes only the operator-identified, provider-verified submission', async () => {
  const store = storeFixture([
    { stage: 'native-build', status: 'succeeded', aab_hashes: { phone: hash }, asset_id: 1 },
    { stage: 'phone-submit', status: 'enqueueing', asset_id: 2 }
  ]);
  const input = { stage: 'phone-submit', status: 'observed', id, artifact_hash: hash, evidence, confirmed: true };
  await assert.rejects(reconcileRelease({ store, releaseId: '1', input: { ...input, artifact_hash: 'b'.repeat(64) }, runEas: () => assert.fail() }), /retained AAB/);
  await reconcileRelease({ store, releaseId: '1', input, runEas: (args) => {
    assert.deepEqual(args, ['submit:view', id, '--json']); return JSON.stringify(submission);
  } });
  await queueSubmission({ store, releaseId: '1', role: 'phone', runEas: (args) => {
    assert.equal(args[0], 'submit:view'); return JSON.stringify(submission);
  } });
  assert.equal(store.state.checkpoints.at(-1).submission_id, id);
});

test('late submission failure and retry preserve the original OTA result and record the replacement ID', async () => {
  const replacement = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  const store = storeFixture([{ stage: 'ota-internal', status: 'succeeded', asset_id: 1 },
    { stage: 'phone-submit', status: 'queued', submission_id: id, asset_id: 2 }]);
  await assert.rejects(waitForSubmission({ store, releaseId: '1', role: 'phone', id,
    runEas: () => JSON.stringify({ ...submission, status: 'ERRORED' }) }), /OTA is independent/);
  let retryCalls = 0;
  const result = await queueSubmission({ store, releaseId: '1', role: 'phone', retryFailed: true, runEas: (args) => {
    if (args[0] === 'submit:retry') { retryCalls++; return JSON.stringify({ id: replacement }); }
    assert.equal(args[0], 'submit:view');
    return JSON.stringify(args[1] === id ? { ...submission, status: 'ERRORED', canRetry: true } : { ...submission, id: replacement });
  } });
  assert.equal(result, replacement);
  assert.equal(retryCalls, 1);
  assert.equal(store.state.checkpoints[0].status, 'succeeded');
});

test('reconciliation cannot substitute another submission for a previously accepted ID', async () => {
  const store = storeFixture([
    { stage: 'native-build', status: 'succeeded', aab_hashes: { phone: hash }, asset_id: 1 },
    { stage: 'phone-submit', status: 'queued', submission_id: id, asset_id: 2 }
  ]);
  await assert.rejects(reconcileRelease({ store, releaseId: '1', input: { stage: 'phone-submit',
    status: 'observed', id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', artifact_hash: hash, evidence, confirmed: true },
  runEas: () => assert.fail('Readback must not silently replace an accepted operation.') }), /cannot replace/);
  assert.equal(store.state.checkpoints.length, 2);
});

test('failed legacy provider IDs cannot be replaced or declared absent without verified wrong-track rejection', async () => {
  const store = storeFixture([
    { stage: 'native-build', status: 'succeeded', aab_hashes: { phone: hash }, asset_id: 1 },
    { stage: 'phone-submit', status: 'failed', submission_id: id, asset_id: 2 }
  ]);
  const input = { stage: 'phone-submit', status: 'observed', id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
    artifact_hash: hash, evidence, confirmed: true };
  await assert.rejects(reconcileRelease({ store, releaseId: '1', input, runEas: () => assert.fail() }), /cannot replace/);
  await assert.rejects(reconcileRelease({ store, releaseId: '1', input: { ...input, status: 'not-published', id: '', artifact_hash: '' },
    runEas: () => JSON.stringify({ ...submission, status: 'ERRORED' }) }), /terminal wrong-track rejection/);
});

test('OTA reconciliation binds channel, runtime and retained artifact, without publishing', async () => {
  const store = storeFixture([{ stage: 'ota-production-artifact', status: 'succeeded', bundle_integrity: hash,
    runtime_version: 'b'.repeat(40), asset_id: 1 }, { stage: 'ota-production', status: 'started', asset_id: 2 }]);
  const input = { stage: 'ota-production', status: 'observed', id, artifact_hash: hash, evidence, confirmed: true };
  const update = { group: id, platform: 'android', runtimeVersion: 'b'.repeat(40), branch: { name: 'production' } };
  await assert.rejects(reconcileRelease({ store, releaseId: '1', input,
    runEas: () => JSON.stringify([{ ...update, runtimeVersion: 'c'.repeat(40) }]) }), /does not match/);
  await reconcileRelease({ store, releaseId: '1', input, runEas: (args) => {
    assert.deepEqual(args, ['update:view', id, '--json']); return JSON.stringify([update]);
  } });
  assert.equal(store.state.checkpoints.at(-1).publication.group, id);
});

test('wrong-track submission requires explicit rejection reconciliation before exactly one corrected enqueue', async () => {
  const store = storeFixture([
    { stage: 'native-build', status: 'succeeded', aab_hashes: { phone: hash }, asset_id: 1 },
    { stage: 'phone-submit', status: 'failed', submission_id: id, asset_id: 2 }
  ]);
  const oldSubmission = { ...submission, status: 'ERRORED', canRetry: true, androidConfig: { track: 'qa' } };
  await assert.rejects(queueSubmission({ store, releaseId: '1', role: 'phone', retryFailed: true, runEas: (args) => {
    assert.deepEqual(args, ['submit:view', id, '--json']);
    return JSON.stringify(oldSubmission);
  } }), /track mismatch/);
  await reconcileRelease({ store, releaseId: '1', input: {
    stage: 'phone-submit', status: 'not-published', id: '', artifact_hash: '', confirmed: true,
    evidence: 'Provider reports terminal Track not found; inspected Play bundles and confirmed code 17 was not committed.'
  }, runEas: (args) => {
    assert.deepEqual(args, ['submit:view', id, '--json'], 'reconciliation only reads the recorded provider operation');
    return JSON.stringify(oldSubmission);
  } });
  const correction = store.state.checkpoints.at(-1);
  assert.equal(correction.retry_mode, 'new-request');
  assert.equal(correction.operation.operationId, id);
  assert.equal(correction.operation.proof.corrected_destination, 'internal');
  assert.equal(correction.operation.proof.artifact_hash, hash);
  await reconcileRelease({ store, releaseId: '1', input: {
    stage: 'phone-submit', status: 'not-published', id: '', artifact_hash: '', confirmed: true,
    evidence: 'Rechecked the terminal old-track rejection and Play bundles before permitting the corrected request.'
  }, runEas: (args) => {
    assert.deepEqual(args, ['submit:view', id, '--json']);
    return JSON.stringify(oldSubmission);
  } });
  assert.equal(store.state.checkpoints.at(-1).operation.operationId, id, 'an audited correction refresh preserves the rejected ID');
  const replacement = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  const calls = [];
  const options = { store, releaseId: '1', role: 'phone', aab: '/retained/phone-17.aab', runEas: (args) => {
    calls.push(args);
    if (args[0] === 'submit') {
      assert.deepEqual(args, ['submit', '--platform', 'android', '--profile', 'phone', '--path', '/retained/phone-17.aab', '--non-interactive', '--no-wait']);
      return `https://expo.dev/accounts/calibrate-health/projects/calibrate-health-app/submissions/${replacement}`;
    }
    if (args[0] === 'submit:view' && args[1] === id) return JSON.stringify(oldSubmission);
    assert.deepEqual(args, ['submit:view', replacement, '--json']);
    return JSON.stringify({ ...submission, id: replacement });
  } };
  assert.equal(await queueSubmission(options), replacement);
  assert.equal(await queueSubmission(options), replacement);
  assert.equal(calls.filter(args => args[0] === 'submit').length, 1);
  assert.equal(calls.some(args => args[0] === 'submit:retry'), false);
  assert.equal(store.state.checkpoints[0].status, 'succeeded');
  const replacementOperation = store.state.checkpoints.find(checkpoint => checkpoint.stage === 'phone-submit'
    && checkpoint.submission_id === replacement).operation;
  assert.equal(replacementOperation.history[0].operationId, id);
  assert.equal(replacementOperation.history[0].proof.observed.androidConfig.track, 'qa');
  assert.equal(replacementOperation.history[0].retryProof.corrected_destination, 'internal');
});

test('wrong-track correction rejects pending operations, wrong app or role, and missing retained evidence', async () => {
  const oldSubmission = { ...submission, status: 'ERRORED', androidConfig: { track: 'qa' } };
  const input = { stage: 'phone-submit', status: 'not-published', id: '', artifact_hash: '', confirmed: true, evidence };
  for (const observed of [
    { ...oldSubmission, status: 'IN_PROGRESS' }, { ...oldSubmission, status: 'FINISHED' },
    { ...oldSubmission, app: { id: 'another-app' } }, { ...oldSubmission, id: 'another-id' },
    { ...oldSubmission, androidConfig: { track: 'wear:qa' } },
    { ...oldSubmission, androidConfig: { track: 'production' } }
  ]) {
    const store = storeFixture([
      { stage: 'native-build', status: 'succeeded', aab_hashes: { phone: hash }, asset_id: 1 },
      { stage: 'phone-submit', status: 'failed', submission_id: id, asset_id: 2 }
    ]);
    await assert.rejects(reconcileRelease({ store, releaseId: '1', input, runEas: () => JSON.stringify(observed) }), /terminal wrong-track rejection/);
    assert.equal(store.state.checkpoints.length, 2);
  }
  const store = storeFixture([{ stage: 'phone-submit', status: 'failed', submission_id: id, asset_id: 1 }]);
  await assert.rejects(reconcileRelease({ store, releaseId: '1', input, runEas: () => JSON.stringify(oldSubmission) }), /retained AAB/);
});

test('corrected enqueue rebinds retained authorization and blocks a second request after a lost response', async () => {
  const observed = { ...submission, status: 'ERRORED', androidConfig: { track: 'qa' } };
  const store = storeFixture([
    { stage: 'native-build', status: 'succeeded', aab_hashes: { phone: hash }, asset_id: 1 },
    { stage: 'phone-submit', status: 'failed', submission_id: id, asset_id: 2 }
  ]);
  await reconcileRelease({ store, releaseId: '1', input: { stage: 'phone-submit', status: 'not-published',
    id: '', artifact_hash: '', evidence, confirmed: true }, runEas: () => JSON.stringify(observed) });
  const correction = structuredClone(store.state.checkpoints.at(-1));
  for (const change of [
    { corrected_destination: 'production' }, { artifact_hash: 'b'.repeat(64) },
    { observed: { ...observed, id: 'wrong-provider-id' } }, { confirmed: false }
  ]) {
    const tampered = structuredClone(correction);
    Object.assign(tampered.operation.proof, change);
    const changedStore = storeFixture([store.state.checkpoints[0], tampered]);
    await assert.rejects(queueSubmission({ store: changedStore, releaseId: '1', role: 'phone', aab: '/retained/phone.aab',
      runEas: () => assert.fail('Changed correction bindings must fail before any provider request.') }), /authorization no longer matches/);
  }
  let submissions = 0;
  const options = { store, releaseId: '1', role: 'phone', aab: '/retained/phone.aab', runEas: (args) => {
    if (args[0] === 'submit:view') {
      assert.equal(args[1], id);
      return JSON.stringify(observed);
    }
    assert.equal(args[0], 'submit');
    submissions++;
    throw new Error('Lost enqueue response');
  } };
  await assert.rejects(queueSubmission(options), /Lost enqueue response/);
  await assert.rejects(queueSubmission(options), /unresolved/);
  assert.equal(submissions, 1);
  assert.equal(store.state.checkpoints.at(-1).operation.history[0].operationId, id);
});
