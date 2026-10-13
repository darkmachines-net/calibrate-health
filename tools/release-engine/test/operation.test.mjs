/** @file Verify publication intent survives ambiguous outcomes and queued requests never masquerade as completed releases. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceOperation } from '../index.mjs';

const intent = () => reduceOperation(null, { type: 'intent', operationKey: 'ota.android.1.2.3', request: { digest: 'abc' } });

test('intent precedes provider acceptance and completion is an independent observation', () => {
  const accepted = reduceOperation(intent(), { type: 'accepted', operationId: 'provider-1' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.receipt, undefined);
  assert.throws(() => reduceOperation(accepted, { type: 'retry' }), /blindly retried/);
  const complete = reduceOperation(accepted, { type: 'complete', receipt: { operationId: 'provider-1', artifactDigest: 'abc' } });
  assert.equal(complete.status, 'complete');
  assert.throws(() => reduceOperation(complete, { type: 'retry' }), /blindly retried/);
});

test('lost enqueue response blocks retries until verified reconciliation', () => {
  const unknown = reduceOperation(intent(), { type: 'unknown', reason: 'Network failed after request transmission.' });
  assert.throws(() => reduceOperation(unknown, { type: 'retry' }), /blindly retried/);
  assert.throws(() => reduceOperation(unknown, { type: 'accepted', operationId: 'provider-1' }), /proof/);
  assert.throws(() => reduceOperation(unknown, { type: 'failed', definitive: true, reason: 'Probably absent.' }), /proof/);
  const absent = reduceOperation(unknown, { type: 'reconciled-absent', proof: { query: 'exact-idempotency-key', result: 'absent' } });
  const retry = reduceOperation(absent, { type: 'retry' });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.status, 'intent');
  assert.equal(retry.operationKey, unknown.operationKey);
  assert.deepEqual(retry.request, unknown.request);
  assert.equal(retry.history[0].proof.result, 'absent');
});

test('known provider identities cannot be replaced or reconciled away', () => {
  const accepted = reduceOperation(intent(), { type: 'accepted', operationId: 'provider-1' });
  const unknown = reduceOperation(accepted, { type: 'unknown', reason: 'Readback unavailable.' });
  assert.throws(() => reduceOperation(unknown, { type: 'accepted', operationId: 'provider-2', proof: 'observed' }), /changed/);
  assert.throws(() => reduceOperation(unknown, { type: 'reconciled-absent', proof: 'not in first page' }), /definitive provider outcome/);
  const reconciled = reduceOperation(unknown, { type: 'accepted', operationId: 'provider-1', proof: { verified: true } });
  assert.equal(reconciled.operationId, 'provider-1');
});

test('non-definitive failures become unknown; only definitive failure permits retry', () => {
  const unknown = reduceOperation(intent(), { type: 'failed', reason: 'Timeout' });
  assert.equal(unknown.status, 'unknown');
  const failed = reduceOperation(intent(), { type: 'failed', reason: 'Provider refused request before creation', definitive: true });
  assert.equal(reduceOperation(failed, { type: 'retry' }).status, 'intent');
  assert.throws(() => reduceOperation(intent(), { type: 'intent', operationKey: 'other' }), /reconciled/);
});

test('corrupt restored states are rejected instead of inventing provider proof', () => {
  for (const corrupt of [
    { ...intent(), status: 'accepted' },
    { ...intent(), status: 'complete' },
    { ...intent(), attempt: 0 },
    { ...intent(), status: 'unknown', reason: 'lost', retrySafe: true },
    { ...intent(), status: 'failed', reason: 'failed' },
  ]) assert.throws(() => reduceOperation(corrupt, { type: 'unknown', reason: 'resume' }));
});

test('repeated definitive failures retain linear immutable attempt history', () => {
  let state = intent();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state = reduceOperation(state, { type: 'failed', definitive: true, reason: 'Provider rejected before creation.' });
    state = reduceOperation(state, { type: 'retry' });
  }
  assert.equal(state.attempt, 4);
  assert.equal(state.history.length, 3);
  assert.ok(state.history.every((entry) => entry.history === undefined));
});

test('known-ID terminal rejection requires fresh proof and retains its identity through an audited retry', () => {
  const request = { artifactSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), reservedVersionCode: 17 };
  const original = reduceOperation(null, { type: 'intent', operationKey: 'phone-submit', request });
  const accepted = reduceOperation(original, { type: 'accepted', operationId: 'failed-provider-id', proof: { status: 'IN_QUEUE' } });
  assert.throws(() => reduceOperation(accepted, { type: 'failed', definitive: true, reason: 'ERRORED' }), /proof/);
  const proof = { provider: { operationId: 'failed-provider-id', status: 'ERRORED', reason: 'Track not found' },
    publication: { checked: true, artifactSha256: request.artifactSha256, uploaded: false },
    authorization: { retryMode: 'new-request', rejectedTrack: 'qa', approvedTrack: 'internal', confirmed: true } };
  const rejected = reduceOperation(accepted, { type: 'failed', definitive: true, reason: 'Provider rejected the destination before store publication.', proof });
  assert.equal(rejected.operationId, 'failed-provider-id');
  assert.deepEqual(rejected.proof, proof);
  assert.throws(() => reduceOperation(rejected, { type: 'retry' }), /Fresh retry proof/);
  const resumed = reduceOperation(rejected, { type: 'retry', proof });
  assert.equal(resumed.status, 'intent');
  assert.equal(resumed.operationId, undefined);
  assert.deepEqual(resumed.request, request);
  assert.equal(resumed.history[0].operationId, 'failed-provider-id');
  assert.deepEqual(resumed.history[0].proof, proof);
  assert.deepEqual(resumed.history[0].retryProof, proof);
  assert.ok(Object.isFrozen(resumed.history[0].proof));
  const next = reduceOperation(resumed, { type: 'accepted', operationId: 'replacement-provider-id' });
  assert.equal(next.history[0].operationId, 'failed-provider-id');
  assert.throws(() => reduceOperation(next, { type: 'retry' }), /blindly retried/);
});

test('provider failure observations never become absence proof or implicit retry authorization', () => {
  const accepted = reduceOperation(intent(), { type: 'accepted', operationId: 'provider-1' });
  const uncertain = reduceOperation(accepted, { type: 'failed', reason: 'Provider returned ERRORED; publication outcome has not been checked.',
    proof: { providerStatus: 'ERRORED', publicationOutcome: 'unknown' } });
  assert.equal(uncertain.status, 'unknown');
  assert.deepEqual(uncertain.proof, { providerStatus: 'ERRORED', publicationOutcome: 'unknown' });
  assert.equal(uncertain.operationId, 'provider-1');
  assert.throws(() => reduceOperation(uncertain, { type: 'retry' }), /blindly retried/);
  assert.throws(() => reduceOperation(uncertain, { type: 'reconciled-absent', proof: { uploaded: false } }), /definitive provider outcome/);
  assert.throws(() => reduceOperation(uncertain, { type: 'failed', definitive: true, reason: 'Use retained acceptance evidence' }), /proof/);
});

test('supplied acceptance, completion and pre-acceptance failure proof is retained and validated', () => {
  const acceptance = { readback: { id: 'provider-1', status: 'IN_QUEUE' } };
  const accepted = reduceOperation(intent(), { type: 'accepted', operationId: 'provider-1', proof: acceptance });
  assert.deepEqual(accepted.proof, acceptance);
  const completion = { artifactDigest: 'exact-bytes', providerStatus: 'FINISHED' };
  const completed = reduceOperation(accepted, { type: 'complete', receipt: { id: 'provider-1' }, proof: completion });
  assert.deepEqual(completed.proof, completion);
  const preflight = { response: 'rejected-before-operation-created' };
  assert.deepEqual(reduceOperation(intent(), { type: 'failed', definitive: true, reason: 'Request refused', proof: preflight }).proof, preflight);
  for (const event of [
    { type: 'accepted', operationId: 'provider-1', proof: {} },
    { type: 'complete', receipt: { id: 'provider-1' }, proof: '' },
    { type: 'failed', definitive: true, reason: 'Request refused', proof: null },
  ]) assert.throws(() => reduceOperation(intent(), event), /proof/i);
});

test('historical definitive failure never supplies fresh authorization for another known-ID request', () => {
  for (const retained of [
    {}, { proof: { observed: 'old acceptance' } }, { retryProof: { observed: 'previous retry authorization' } },
  ]) {
    const failed = { schemaVersion: 1, status: 'failed', attempt: 1, operationKey: 'phone-submit',
      operationId: 'old-provider-id', reason: 'ERRORED', retrySafe: true, ...retained };
    assert.throws(() => reduceOperation(failed, { type: 'retry' }), /Fresh retry proof/);
    const proof = { observedNow: { id: 'old-provider-id', status: 'ERRORED', canRetry: true }, action: 'provider-retry' };
    const next = reduceOperation(failed, { type: 'retry', proof });
    assert.deepEqual(next.history[0].retryProof, proof);
    assert.equal(next.history[0].operationId, 'old-provider-id');
    if (retained.proof) assert.deepEqual(next.history[0].proof, retained.proof);
  }
});

test('an audited failure refresh retains its identity and cannot inherit authorization from non-definitive evidence', () => {
  const failed = { schemaVersion: 1, status: 'failed', attempt: 1, operationKey: 'phone-submit',
    operationId: 'old-provider-id', reason: 'ERRORED', retrySafe: true };
  assert.throws(() => reduceOperation(failed, { type: 'failed', definitive: false, reason: 'Unknown publication result' }), /fresh definitive proof/);
  assert.throws(() => reduceOperation(failed, { type: 'failed', definitive: true, reason: 'Rechecked' }), /proof/);
  const proof = { providerId: 'old-provider-id', rejected: true, artifactWasNotPublished: true };
  const refreshed = reduceOperation(failed, { type: 'failed', definitive: true, reason: 'Verified request rejection', proof });
  assert.equal(refreshed.operationId, failed.operationId);
  assert.equal(refreshed.attempt, failed.attempt);
  assert.deepEqual(refreshed.proof, proof);
  assert.throws(() => reduceOperation(refreshed, { type: 'retry' }), /Fresh retry proof/);
  assert.throws(() => reduceOperation({ ...failed, retryProof: {} }, { type: 'retry', proof }), /Retained retry proof/);
  assert.throws(() => reduceOperation({ ...intent(), retryProof: proof }, { type: 'accepted', operationId: 'unexpected' }), /Only a failed attempt/);
});
