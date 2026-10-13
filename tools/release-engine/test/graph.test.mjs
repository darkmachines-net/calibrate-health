/** @file Verify queued native work permits independent OTA after handoff while only completed stages advance baselines. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReleaseGraph, canRunStage, completedComponents, latestCheckpoint, remainingStages, requiredStages, summarizeRelease } from '../index.mjs';

const graph = buildReleaseGraph([
  { id: 'image', component: 'server' },
  { id: 'deploy', component: 'server', needs: ['image'] },
  { id: 'native-build', component: 'phone' },
  { id: 'phone-handoff', component: 'phone', needs: ['native-build'] },
  { id: 'phone-submit', component: 'phone', needs: ['phone-handoff'] },
  { id: 'ota', component: 'ota', needs: ['deploy', 'phone-handoff'] },
]);

test('native queue acceptance cannot advance a baseline but handoff permits OTA', () => {
  const receipts = ['image', 'deploy', 'native-build', 'phone-handoff'].map((stage) => ({ stage, status: 'complete' }));
  receipts.push({ stage: 'phone-submit', status: 'accepted', operationId: 'submission-1' });
  assert.equal(canRunStage(graph, 'ota', receipts), true);
  assert.equal(canRunStage(graph, 'phone-submit', receipts), false);
  assert.deepEqual(completedComponents(graph, receipts), ['server']);
  assert.deepEqual(remainingStages(graph, receipts), ['ota', 'phone-submit']);
  receipts.push({ stage: 'ota', status: 'complete' });
  assert.equal(summarizeRelease(graph, receipts).status, 'pending');
  receipts.push({ stage: 'phone-submit', status: 'complete' });
  assert.equal(summarizeRelease(graph, receipts).status, 'complete');
});

test('latest failure wins over previous success and unknown stages are blocked', () => {
  const receipts = [{ stage: 'image', status: 'complete' }, { stage: 'image', status: 'failed' }];
  assert.equal(latestCheckpoint(receipts, 'image').status, 'failed');
  assert.equal(canRunStage(graph, 'deploy', receipts), false);
  assert.equal(summarizeRelease(graph, receipts).status, 'failed');
  receipts.push({ stage: 'image', status: 'unknown' });
  assert.equal(canRunStage(graph, 'image', receipts), false);
  assert.equal(summarizeRelease(graph, receipts).status, 'blocked');
});

test('optional work cannot hide required dependencies or skip mandatory publication', () => {
  const optionalGraph = buildReleaseGraph([{ id: 'prep', component: 'server', optional: true }, { id: 'deploy', component: 'server', needs: ['prep'] }, { id: 'report', component: 'report', optional: true }]);
  assert.deepEqual(requiredStages(optionalGraph), ['deploy', 'prep']);
  assert.throws(() => remainingStages(optionalGraph, [{ stage: 'deploy', status: 'skipped' }]), /cannot be skipped/);
  assert.equal(canRunStage(optionalGraph, 'deploy', [{ stage: 'prep', status: 'skipped' }]), false);
  assert.equal(summarizeRelease(buildReleaseGraph([])).status, 'noop');
});

test('malformed retained graphs and receipts fail closed', () => {
  assert.throws(() => buildReleaseGraph([{ id: 'a', component: 'server', needs: ['b'] }, { id: 'b', component: 'server', needs: ['a'] }]), /cycle/);
  assert.throws(() => buildReleaseGraph([{ id: 'a', component: 'server', needs: ['missing'] }]), /Unknown/);
  assert.throws(() => remainingStages(graph, [{ stage: 'wrong', status: 'complete' }]), /unknown stage/);
  assert.throws(() => remainingStages(graph, [{ stage: 'image', status: 'success' }]), /Invalid/);
});

test('completion requires prerequisite evidence and unrelated failures retain completed components', () => {
  const independent = buildReleaseGraph([{ id: 'image', component: 'server' }, { id: 'deploy', component: 'server', needs: ['image'] }, { id: 'ota', component: 'ota', needs: ['deploy'] }, { id: 'native', component: 'phone' }]);
  const malformed = [{ stage: 'ota', status: 'complete' }];
  assert.deepEqual(completedComponents(independent, malformed), []);
  assert.equal(summarizeRelease(independent, malformed).status, 'blocked');
  const valid = ['image', 'deploy', 'ota'].map((stage) => ({ stage, status: 'complete' }));
  valid.push({ stage: 'native', status: 'failed' });
  assert.deepEqual(completedComponents(independent, valid), ['ota', 'server']);
  assert.equal(summarizeRelease(independent, valid).status, 'failed');
});
