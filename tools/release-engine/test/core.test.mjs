/** @file Verify semantic identities reject lossy data and plans retain independent source/workflow/toolkit provenance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalStringify, createPlan, hashIdentity, immutable, verifyPlan } from '../index.mjs';

const source = { repository: 'owner/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };

test('canonical identity ignores object insertion order but retains array order', () => {
  assert.equal(hashIdentity({ b: 2, a: [1, 2] }), hashIdentity({ a: [1, 2], b: 2 }));
  assert.notEqual(hashIdentity([1, 2]), hashIdentity([2, 1]));
  assert.equal(canonicalStringify({ a: null }), '{"a":null}');
});

test('canonical JSON rejects silent serialization loss and never executes getters', () => {
  const cyclic = {}; cyclic.self = cyclic;
  let invoked = false;
  const accessor = { get token() { invoked = true; return 'not-data'; } };
  for (const invalid of [undefined, NaN, Infinity, 1n, { a: undefined }, new Date(), cyclic, [, 1], accessor, { [Symbol('x')]: 1 }]) {
    assert.throws(() => canonicalStringify(invalid));
  }
  assert.equal(invoked, false);
});

test('plans seal separate trusted provenance and detect tampering', () => {
  const plan = createPlan({ source, selection: ['server'], config: { target: 'production' } });
  assert.equal(verifyPlan(plan, { commit: source.commit }).source.toolkitCommit, source.toolkitCommit);
  assert.throws(() => verifyPlan({ ...plan, selection: ['ota'] }), /digest/);
  assert.throws(() => verifyPlan(plan, { workflowCommit: source.commit }), /workflowCommit/);
  assert.throws(() => createPlan({ source: { ...source, toolkitCommit: 'main' } }), /SHA/);
  assert.throws(() => createPlan({ source, schemaVersion: 1 }), /reserves/);
  assert.throws(() => { plan.config.target = 'preview'; }, TypeError);
});

test('immutable returns isolated data rather than freezing the caller object', () => {
  const original = { nested: ['a'] };
  const copy = immutable(original);
  original.nested.push('b');
  assert.deepEqual(copy, { nested: ['a'] });
  assert.ok(Object.isFrozen(copy.nested));
});
