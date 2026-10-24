/** @file Regression coverage for release handler event: accepts an exact protected request with GitHub live dynamic run-name. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyReleaseHandlerEvent } from './release-handler-event.mjs';

const SHA = 'a'.repeat(40);
const EXPECTED = Object.freeze({
  workflowPath: '.github/workflows/cut-release-request.yml',
  repository: 'MChartier/calibrate-health',
  repositoryId: '1234',
  handlerRef: 'refs/heads/master',
  handlerSha: SHA
});

function validEvent() {
  return {
    action: 'completed',
    repository: { id: 1234, full_name: 'MChartier/calibrate-health' },
    workflow_run: {
      id: 4567,
      run_attempt: 2,
      // GitHub replaces the static workflow name with run-name in live run payloads.
      name: 'Cut minor release from master',
      display_title: 'Cut minor release from master',
      path: '.github/workflows/cut-release-request.yml',
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_branch: 'master',
      head_sha: SHA,
      actor: { type: 'User', login: 'release-owner' },
      triggering_actor: { type: 'User', login: 'release-owner' },
      repository: { id: 1234, full_name: 'MChartier/calibrate-health' },
      head_repository: { id: 1234, full_name: 'MChartier/calibrate-health' }
    }
  };
}

test('accepts an exact protected request with GitHub live dynamic run-name', () => {
  const result = verifyReleaseHandlerEvent(validEvent(), EXPECTED);
  assert.deepEqual(result, {
    headBranch: 'master',
    headSha: SHA,
    runAttempt: '2',
    runId: '4567'
  });
});

test('dynamic display names are not an authorization input', () => {
  const event = validEvent();
  event.workflow_run.name = 'Cut patch release from master';
  event.workflow_run.display_title = 'operator-controlled display text';
  assert.equal(verifyReleaseHandlerEvent(event, EXPECTED).headSha, SHA);
});

test('rejects non-success, non-dispatch, non-master, wrong-path, and stale handler runs', () => {
  const defects = [
    ['action', 'requested'],
    ['workflow_run.conclusion', 'failure'],
    ['workflow_run.event', 'push'],
    ['workflow_run.head_branch', 'feature/unsafe'],
    ['workflow_run.path', '.github/workflows/unsafe.yml'],
    ['workflow_run.head_sha', 'b'.repeat(40)]
  ];
  for (const [field, value] of defects) {
    const event = validEvent();
    const parts = field.split('.');
    let target = event;
    while (parts.length > 1) target = target[parts.shift()];
    target[parts[0]] = value;
    assert.throws(() => verifyReleaseHandlerEvent(event, EXPECTED), /does not match/);
  }
  assert.throws(
    () => verifyReleaseHandlerEvent(validEvent(), { ...EXPECTED, handlerRef: 'refs/heads/feature' }),
    /handler ref does not match/
  );
});

test('rejects repository substitution and automation actors', () => {
  for (const field of [
    'repository.full_name',
    'repository.id',
    'workflow_run.repository.full_name',
    'workflow_run.repository.id',
    'workflow_run.head_repository.full_name',
    'workflow_run.head_repository.id'
  ]) {
    const event = validEvent();
    const parts = field.split('.');
    let target = event;
    while (parts.length > 1) target = target[parts.shift()];
    target[parts[0]] = field.endsWith('.id') ? 9999 : 'attacker/fork';
    assert.throws(() => verifyReleaseHandlerEvent(event, EXPECTED), /does not match/);
  }
  for (const field of ['actor', 'triggering_actor']) {
    const event = validEvent();
    event.workflow_run[field].type = 'Bot';
    assert.throws(() => verifyReleaseHandlerEvent(event, EXPECTED), /actor type does not match/);
  }
});

test('rejects malformed identifiers and event structures', () => {
  assert.throws(() => verifyReleaseHandlerEvent(null, EXPECTED), /event is malformed/);
  assert.throws(() => verifyReleaseHandlerEvent({}, EXPECTED), /repository is malformed/);
  assert.throws(
    () => verifyReleaseHandlerEvent(validEvent(), { ...EXPECTED, workflowPath: '../unsafe.yml' }),
    /expected workflow path is malformed/
  );
  const event = validEvent();
  event.workflow_run.run_attempt = 0;
  assert.throws(() => verifyReleaseHandlerEvent(event, EXPECTED), /attempt is malformed/);
});
