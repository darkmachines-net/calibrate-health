import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyRequiredTests } from './ci-test-gate.mjs';

function results(backend = 'true', mobile = 'true') {
  return {
    changes: { result: 'success', outputs: { backend, mobile } },
    'backend-tests': { result: backend === 'true' ? 'success' : 'skipped' },
    'mobile-tests': { result: mobile === 'true' ? 'success' : 'skipped' },
  };
}

test('successful selected suites and explicitly unselected suites satisfy the gate', () => {
  for (const backend of ['true', 'false']) {
    for (const mobile of ['true', 'false']) assert.doesNotThrow(() => verifyRequiredTests(results(backend, mobile)));
  }
});

test('a failed or absent classifier never authorizes a merge', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const needs = results();
    needs.changes.result = result;
    assert.throws(() => verifyRequiredTests(needs), /classification/);
  }
  assert.throws(() => verifyRequiredTests({}), /classification/);
});

test('selected test failures, cancellation, skips and missing results block a merge', () => {
  for (const surface of ['backend', 'mobile']) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      const needs = results();
      needs[`${surface}-tests`].result = result;
      assert.throws(() => verifyRequiredTests(needs), new RegExp(`${surface} tests`));
    }
    const needs = results();
    delete needs.changes.outputs[surface];
    assert.throws(() => verifyRequiredTests(needs), /Missing test selection/);
  }
});

test('unselected suites cannot hide a failure or missing result', () => {
  for (const result of ['failure', 'cancelled', undefined]) {
    const needs = results('false', 'false');
    needs['backend-tests'].result = result;
    assert.throws(() => verifyRequiredTests(needs), /backend tests/);
  }
});

test('the PR test gate always waits for the classifier and both suites', () => {
  const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\n {2}pull_request:/);
  const gate = workflow.split(/\n {2}required-tests:/)[1];
  assert.ok(gate);
  assert.match(gate, /\n {4}if: always\(\)/);
  assert.match(gate, /needs: \[changes, backend-tests, mobile-tests\]/);
  assert.doesNotMatch(gate, /continue-on-error/);
  assert.match(gate, /TEST_JOB_RESULTS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(gate, /run: node scripts\/ci-test-gate.mjs/);
});
