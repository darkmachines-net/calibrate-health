/** @file Coordinate component selection, one pending release, and durable recovery checkpoints for Cut release. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseRecordStore, completedBaseline, latestCheckpoint } from './release-record.mjs';
import { inspectReleaseSelection, releaseGit } from './release-selection.mjs';
import { verifyCurrentReleaseWorkflow, verifyPreparedReleaseCandidate } from './release-config.mjs';
import { checkpointReleaseOperation, incompleteCalibrateStages, sealCalibrateRecord, summarizeCalibrateRelease } from './release-engine.mjs';

/** Export explicit scalar values for workflow conditions and never embed untrusted JSON in shell code. */
function outputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Invalid release output.');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

/** Show why components were selected before version preparation or publication. */
function summary(record) {
  const lines = ['## Release component selection', `Source: \`${record.source_commit}\``, ''];
  for (const key of ['server', 'native', 'ota_internal', 'ota_production']) lines.push(`- ${key}: ${record.plan[key] ? 'selected' : 'unchanged'}`);
  for (const [key, reasons] of Object.entries(record.plan.reasons)) {
    if (reasons.length) lines.push(`- ${key} inputs: ${reasons.slice(0, 25).join(', ')}`);
  }
  if (record.plan.noop) lines.push('No applicable changes; no versions or publications will be created.');
  const text = `${lines.join('\n')}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

/** Select from the last resolved record and reject a second unfinished orchestration. */
export async function planRelease({ store, root, source, workflowSha, runId, bump, confirmPlay }) {
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/heads/master') throw new Error('Cut release must run from protected master.');
  await verifyCurrentReleaseWorkflow({ root, workflowSha });
  if (source !== workflowSha || releaseGit(root, ['rev-parse', 'HEAD']) !== source) throw new Error('Cut source must equal the current protected workflow.');
  const releases = await store.list();
  const pending = releases.find((item) => item.draft);
  if (pending) throw new Error(`Release ${pending.id} is unfinished. Resume it instead of allocating another release.`);
  const previous = releases.find((item) => !item.draft);
  let baseline = null;
  if (previous) {
    const state = await store.read(previous.id);
    const final = latestCheckpoint(state.checkpoints, 'final');
    if (!['succeeded', 'abandoned'].includes(final?.status)) throw new Error('The last resolved release is missing its completion checkpoint.');
    baseline = completedBaseline(state.record, state.checkpoints);
  }
  const plan = inspectReleaseSelection(root, source, baseline, bump);
  if (plan.native && !confirmPlay) throw new Error('Native submission is selected. Confirm Play Publishing overview is clear and pause other Console/API edits for this release.');
  return sealCalibrateRecord({ schema_version: 1, repository: store.repository, run_id: String(runId),
    source_commit: source, workflow_sha: workflowSha, baseline, plan });
}

/** Require all selected publications, but do not make native monitoring a prerequisite for OTA. */
export function unfinishedStages(record, checkpoints) {
  return incompleteCalibrateStages(record, checkpoints);
}

/** Resolve the exact already prepared source for recovery without allocating versions or rebuilding. */
export async function recoveryInputs(store, releaseId) {
  const state = await store.read(releaseId);
  let prepared = latestCheckpoint(state.checkpoints, 'prepared');
  if (!prepared && state.record.plan.server) {
    const branch = `release/v${state.record.plan.server_version}`;
    const owner = store.repository.split('/')[0];
    const pulls = await store.api(`/pulls?state=closed&base=master&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
    const merged = pulls.filter((pull) => pull.merged_at && pull.head?.repo?.full_name === store.repository && pull.head.ref === branch);
    if (merged.length !== 1 || !/^[a-f0-9]{40}$/.test(merged[0].head.sha)) {
      throw new Error('No unique merged candidate. Resume the original Cut release candidate jobs; do not allocate another version.');
    }
    // bindReleaseSource subsequently proves canonical bytes, original parent, and current master ancestry.
    prepared = { source_commit: merged[0].head.sha, release_branch: branch };
  }
  const source = prepared?.source_commit ?? state.record.source_commit;
  /** Treat only an explicit successful checkpoint as a completed stage. */
  const stageDone = (stage) => latestCheckpoint(state.checkpoints, stage)?.status === 'succeeded';
  const complete = new Set(summarizeCalibrateRelease(state.record, state.checkpoints).completedComponents);
  return { ...state.record.plan, source_commit: source, release_id: releaseId,
    producing_run_id: state.record.run_id,
    release_branch: prepared?.release_branch ?? '',
    image_complete: stageDone('image'), native_build_complete: stageDone('native-build'),
    server: state.record.plan.server && !complete.has('server'),
    native: state.record.plan.native && !complete.has('native'),
    ota_internal: state.record.plan.ota_internal && !complete.has('ota-internal'),
    ota_production: state.record.plan.ota_production && !complete.has('ota-production') };
}

/** Bind the canonical merged candidate once; OTA-only releases retain their original protected source. */
export async function bindReleaseSource(store, releaseId, root, source, branch, workflowSha) {
  await verifyCurrentReleaseWorkflow({ root, workflowSha, releaseCommit: source });
  const state = await store.read(releaseId);
  const prepared = latestCheckpoint(state.checkpoints, 'prepared');
  if (prepared && (prepared.source_commit !== source || prepared.release_branch !== branch)) {
    throw new Error('Recovery must use the original prepared source and branch.');
  }
  releaseGit(root, ['merge-base', '--is-ancestor', source, 'refs/remotes/origin/master']);
  if (state.record.plan.server) {
    if (releaseGit(root, ['rev-parse', `${source}^`]) !== state.record.source_commit) throw new Error('Release candidate does not descend directly from its reserved source.');
    releaseGit(root, ['checkout', '--quiet', '--detach', source]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/release.json'), 'utf8'));
    if (branch !== `release/v${manifest.server.version}`) throw new Error('Release candidate branch differs from its manifest.');
    await verifyPreparedReleaseCandidate({ root, releaseTag: `v${manifest.server.version}`, expectedCommit: source, publishLatest: true });
  } else if (source !== state.record.source_commit || branch) throw new Error('Client-only release source cannot be replaced during recovery.');
  if (!prepared) {
    const manifest = JSON.parse(releaseGit(root, ['show', `${source}:shared/release.json`]));
    if (state.record.plan.native && (manifest.android.mobile.version_name !== state.record.plan.native_version ||
      manifest.android.mobile.version_code !== state.record.plan.native_codes.mobileVersionCode ||
      manifest.android.wear.version_code !== state.record.plan.native_codes.wearVersionCode)) throw new Error('Prepared native allocation differs from its recorded reservation.');
    await store.checkpoint(releaseId, 'prepared', { status: 'succeeded', source_commit: source, release_branch: branch,
      native_version: state.record.plan.native ? manifest.android.mobile.version_name : undefined });
  }
  return recoveryInputs(store, releaseId);
}

/** A deployment intent survives interruption, preventing a timed-out POST from being repeated by recovery. */
export async function markReleaseStage(store, releaseId, stage, status) {
  if (!['image', 'deploy'].includes(stage) || !['started', 'succeeded'].includes(status)) throw new Error('Unsupported release stage marker.');
  if (status === 'started') {
    const state = await store.read(releaseId);
    if (latestCheckpoint(state.checkpoints, stage)?.status === 'started') throw new Error('Inspect and reconcile the previous deployment before sending another POST.');
  }
  const identity = {};
  if (stage === 'image' && status === 'succeeded') {
    if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(process.env.RELEASE_IMAGE_REF ?? '')) throw new Error('A verified image digest is required for the release record.');
    identity.image_ref = process.env.RELEASE_IMAGE_REF;
  }
  if (stage === 'deploy') {
    const previous = latestCheckpoint((await store.read(releaseId)).checkpoints, stage);
    let event = { type: 'complete', receipt: { service: 'calibratehealth', healthy: true } };
    if (status === 'started') event = previous?.status === 'not-published'
      ? { type: 'retry' } : { type: 'intent', operationKey: stage };
    await checkpointReleaseOperation(store, releaseId, stage, event, identity);
  } else await store.checkpoint(releaseId, stage, { status, ...identity });
}

/** Keep incomplete records draft; explicit abandonment cannot discard an ambiguous remote operation. */
export async function finishRelease(store, releaseId, abandon = false) {
  const state = await store.read(releaseId);
  const pending = unfinishedStages(state.record, state.checkpoints);
  const lines = [`## Release ${releaseId} outcomes`, ''];
  for (const stage of ['image', 'deploy', 'native-build', 'phone-handoff', 'phone-submit', 'wear-submit', 'ota-internal', 'ota-production']) {
    const checkpoint = latestCheckpoint(state.checkpoints, stage);
    const detail = checkpoint?.submission_id ?? checkpoint?.publication?.group ?? checkpoint?.image_ref ?? '';
    lines.push(`- ${stage}: ${checkpoint?.status ?? (pending.includes(stage) ? 'not completed' : 'not selected')} ${detail}`);
  }
  lines.push(`Record: https://github.com/${store.repository}/releases/tag/release-run-${state.record.run_id}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (abandon) {
    for (const stage of ['deploy', 'phone-submit', 'wear-submit', 'ota-internal', 'ota-production']) {
      if (['enqueueing', 'queued', 'started', 'unknown'].includes(latestCheckpoint(state.checkpoints, stage)?.status)) {
        throw new Error(`Reconcile ${stage} before abandoning this release.`);
      }
    }
    if (!state.release?.draft) throw new Error('Only an unfinished draft release can be abandoned.');
    if (state.record.plan.server && latestCheckpoint(state.checkpoints, 'image')?.status !== 'succeeded') {
      const branch = `release/v${state.record.plan.server_version}`;
      const refs = await store.api(`/git/matching-refs/heads/${branch}`);
      const owner = store.repository.split('/')[0];
      const pulls = await store.api(`/pulls?state=all&base=master&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
      if (pulls.some((pull) => pull.merged_at) || latestCheckpoint(state.checkpoints, 'prepared')) {
        throw new Error('Finish the prepared server tag/image stage before abandonment so protected master does not retain an unpublished server version.');
      }
      if (refs.some((ref) => ref.ref === `refs/heads/${branch}`) || pulls.some((pull) => pull.state === 'open')) {
        throw new Error(`Close and remove only the reviewed unmerged ${branch} candidate before abandonment. A moved or merged candidate must never be deleted.`);
      }
    }
  } else if (pending.length) {
    throw new Error(`Release ${releaseId} remains unfinished: ${pending.join(', ')}. Resume this release; do not cut another version.`);
  }
  await store.checkpoint(releaseId, 'final', { status: abandon ? 'abandoned' : 'succeeded' });
  await store.api(`/releases/${releaseId}`, { method: 'PATCH', body: { draft: false, make_latest: 'false' } });
}

/** Workflow interface keeps source inspection read-only and gives writes only to explicit record operations. */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const store = new ReleaseRecordStore();
  if (command === 'select') {
    const [source, bump, file] = args;
    const record = await planRelease({ store, root: process.cwd(), source, workflowSha: process.env.WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID, bump, confirmPlay: process.env.CONFIRM_PLAY_CONSOLE_CLEAN === 'true' });
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    summary(record);
    outputs(Object.fromEntries(['server', 'native', 'ota_internal', 'ota_production', 'reserve_native', 'minimum_native_code', 'noop'].map((key) => [key, record.plan[key]])));
  } else if (command === 'begin') {
    const record = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    if (record.run_id !== process.env.GITHUB_RUN_ID || record.workflow_sha !== process.env.WORKFLOW_SHA) throw new Error('Release plan is from another run or workflow.');
    const release = await store.begin(record);
    outputs({ release_id: release.id });
  } else if (command === 'bind') {
    const values = await bindReleaseSource(store, args[0], process.cwd(), args[1], args[2] ?? '', process.env.WORKFLOW_SHA);
    outputs(Object.fromEntries(Object.entries(values).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value))));
  } else if (command === 'mark') {
    await markReleaseStage(store, ...args);
  } else if (command === 'require-native-submitted') {
    if ((await store.list()).some((release) => release.draft && String(release.id) !== String(args[0]))) throw new Error('Resolve the other unfinished release before editing Play tracks.');
    const state = await store.read(args[0]);
    if (['phone-submit', 'wear-submit'].some((stage) => latestCheckpoint(state.checkpoints, stage)?.status !== 'succeeded')) {
      throw new Error('Both EAS submissions must finish before a Play promotion.');
    }
  } else if (command === 'recover') {
    const values = await recoveryInputs(store, args[0]);
    if (values.native && process.env.CONFIRM_PLAY_CONSOLE_CLEAN !== 'true') throw new Error('Confirm Play Console coordination before resuming native submission.');
    outputs(Object.fromEntries(Object.entries(values).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value))));
    if (args[1]) fs.writeFileSync(args[1], `${JSON.stringify(values)}\n`);
  } else if (command === 'finish' || command === 'abandon') {
    await finishRelease(store, args[0], command === 'abandon');
  } else throw new Error('Expected select, begin, recover, finish, or abandon.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
