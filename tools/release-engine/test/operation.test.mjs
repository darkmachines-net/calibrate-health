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
