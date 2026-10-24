/** @file Reconcile interrupted remote calls using explicit operator evidence and exact provider identities. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseRecordStore, latestCheckpoint } from './release-record.mjs';
import { easInvocation, verifySubmission, writeSubmissionProject } from './native-eas-submit.mjs';

/** Keep the recovery request bounded, single-line, and incapable of changing sources or allocated versions. */
export function validateReconciliation(input) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  const keys = ['stage', 'status', 'id', 'artifact_hash', 'evidence', 'confirmed'];
  if (!value || Object.keys(value).sort().join() !== keys.sort().join() || value.confirmed !== true ||
    !['deploy', 'phone-submit', 'wear-submit', 'ota-internal', 'ota-production'].includes(value.stage) ||
    !['observed', 'not-published'].includes(value.status) || typeof value.evidence !== 'string' ||
    value.evidence.trim().length < 20 || value.evidence.length > 1500 || typeof value.id !== 'string' ||
    typeof value.artifact_hash !== 'string') throw new Error('Reconciliation requires the exact documented fields and explicit operator evidence.');
  if (value.stage === 'deploy') {
    if (value.id || value.artifact_hash) throw new Error('Deployment reconciliation does not accept an artifact or provider ID.');
  } else if (value.status === 'observed') {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) ||
      !/^[a-f0-9]{64}$/.test(value.artifact_hash)) throw new Error('Observed publication requires its exact ID and retained artifact hash.');
  } else if (value.id || value.artifact_hash) throw new Error('Absence reconciliation cannot also claim a remote publication.');
  return value;
}

/** Record only observed provider results; the operator must verify exact bytes when the provider omits their hash. */
export async function reconcileRelease({ store, releaseId, input, runEas }) {
  const value = validateReconciliation(input);
  const state = await store.read(releaseId);
  const previous = latestCheckpoint(state.checkpoints, value.stage);
  if (!state.release.draft || !previous || previous.status === 'succeeded') throw new Error('Only an unfinished remote stage can be reconciled.');
  const audit = { reconciliation: { evidence: value.evidence, actor: process.env.GITHUB_ACTOR, confirmed: true } };
  if (value.status === 'not-published') {
    // This is an explicit operator assertion after inspecting provider/service logs, never an automatic retry.
    await store.checkpoint(releaseId, value.stage, { status: 'not-published', ...audit });
    return;
  }
  if (value.stage === 'deploy') {
    await store.checkpoint(releaseId, 'deploy', { status: 'succeeded', ...audit });
    return;
  }
  if (value.stage.endsWith('-submit')) {
    const role = value.stage.split('-')[0];
    const native = latestCheckpoint(state.checkpoints, 'native-build');
    if (native?.status !== 'succeeded' || value.artifact_hash !== native.aab_hashes?.[role]) throw new Error('Reconciliation must identify the retained AAB hash.');
    const observed = verifySubmission(JSON.parse(runEas(['submit:view', value.id, '--json'])), value.id, role);
    const status = observed.status === 'FINISHED' ? 'succeeded' : ['ERRORED', 'CANCELED'].includes(observed.status) ? 'failed' : 'queued';
    await store.checkpoint(releaseId, value.stage, { status, submission_id: value.id, ...audit });
    return;
  }
  const artifact = latestCheckpoint(state.checkpoints, `${value.stage}-artifact`);
  const updates = JSON.parse(runEas(['update:view', value.id, '--json']));
  if (artifact?.status !== 'succeeded' || artifact.bundle_integrity !== value.artifact_hash ||
    !Array.isArray(updates) || updates.length !== 1 || updates[0].group !== value.id || updates[0].platform !== 'android' ||
    updates[0].runtimeVersion !== artifact.runtime_version || updates[0].branch?.name !== value.stage.slice(4)) {
    throw new Error('Observed OTA does not match the retained channel/runtime/artifact.');
  }
  await store.checkpoint(releaseId, value.stage, { status: 'succeeded', ...audit, publication: {
    group: value.id, runtime_version: artifact.runtime_version, bundle_integrity: artifact.bundle_integrity,
    source_commit: latestCheckpoint(state.checkpoints, 'prepared')?.source_commit ?? state.record.source_commit
  } });
}

/** Run provider readback in an isolated project; reconciliation never publishes or rebuilds anything. */
async function main() {
  const [releaseId, toolRoot] = process.argv.slice(2);
  const directory = path.join(process.env.RUNNER_TEMP, 'release-reconciliation');
  writeSubmissionProject(directory);
  await reconcileRelease({ store: new ReleaseRecordStore(), releaseId, input: process.env.RECONCILIATION,
    runEas: (args) => easInvocation(path.resolve(toolRoot), directory, args) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
