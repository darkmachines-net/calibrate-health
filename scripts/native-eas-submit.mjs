/** @file Queue exact retained AABs through EAS, recording intent before any externally visible submission. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ReleaseRecordStore, latestCheckpoint } from './release-record.mjs';
import { checkpointReleaseOperation } from './release-engine.mjs';
import { RELEASE_ENGINE_CONFIG } from './release-engine.config.mjs';

export const EAS_PROJECT_ID = RELEASE_ENGINE_CONFIG.expo.projectId;
export const SUBMISSION_TRACKS = RELEASE_ENGINE_CONFIG.expo.tracks;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The pinned submit command has no JSON flag; bind only its unique project-specific details URL. */
export function parseSubmissionId(output) {
  const matches = [...output.matchAll(new RegExp(`https://expo\\.dev/accounts/calibrate-health/projects/calibrate-health-app/submissions/(${UUID})(?![0-9a-z-])`, 'g'))];
  const ids = [...new Set(matches.map((match) => match[1]))];
  if (ids.length !== 1) throw new Error('EAS enqueue outcome is ambiguous; reconcile the submission before retrying.');
  return ids[0];
}

/** Validate a specific submission; never infer success from the most recent EAS build or release. */
export function verifySubmission(value, id, role) {
  if (value?.id !== id || value.app?.id !== EAS_PROJECT_ID || value.platform !== 'ANDROID'
    || value.androidConfig?.track !== SUBMISSION_TRACKS[role]) throw new Error('EAS submission identity or track mismatch.');
  if (!['IN_QUEUE', 'IN_PROGRESS', 'AWAITING_BUILD', 'FINISHED', 'ERRORED', 'CANCELED'].includes(value.status)) {
    throw new Error(`Unknown EAS submission status: ${value.status}`);
  }
  return value;
}

/** Source-free EAS project uses the assigned app credential, never a broad local Play credential. */
export function writeSubmissionProject(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'calibrate-release-submitter', private: true }));
  fs.writeFileSync(path.join(directory, 'app.json'), JSON.stringify({ expo: {
    name: 'Calibrate', slug: 'calibrate-health-app', owner: 'calibrate-health',
    android: { package: 'net.darkmachines.healthtracker' }, extra: { eas: { projectId: EAS_PROJECT_ID } }
  } }));
  fs.writeFileSync(path.join(directory, 'eas.json'), JSON.stringify({ cli: { version: '22.4.0' }, submit: {
    phone: { android: { applicationId: 'net.darkmachines.healthtracker', track: SUBMISSION_TRACKS.phone, releaseStatus: 'completed' } },
    wear: { android: { applicationId: 'net.darkmachines.healthtracker', track: SUBMISSION_TRACKS.wear, releaseStatus: 'completed' } }
  } }));
}

/** Strip unrelated CI credentials before invoking the locked CLI in the isolated project. */
export function easInvocation(toolRoot, directory, args, execute = execFileSync) {
  const env = { ...process.env, EAS_NO_VCS: '1', EXPO_NO_DOTENV: '1' };
  for (const key of Object.keys(env)) {
    if (/^(GITHUB_TOKEN|GH_TOKEN|DEPLOY_|CALIBRATE_ANDROID_|GOOGLE_|PLAY_)/.test(key)) delete env[key];
  }
  return execute(process.execPath, [path.join(toolRoot, 'tools/eas-cli/node_modules/eas-cli/bin/run'), ...args], {
    cwd: directory, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** Record verified acceptance separately from eventual provider completion so only the handoff unlocks OTA. */
export async function recordSubmissionHandoff(store, releaseId, role, submission) {
  if (role !== 'phone' || ['ERRORED', 'CANCELED'].includes(submission.status)) return;
  const state = await store.read(releaseId);
  const previous = latestCheckpoint(state.checkpoints, 'phone-handoff');
  if (previous?.status === 'succeeded' && previous.submission_id === submission.id) return;
  await store.checkpoint(releaseId, 'phone-handoff', { status: 'succeeded', submission_id: submission.id,
    provider_status: submission.status });
}

/** A prior intent without an ID must be reconciled rather than creating an untracked duplicate. */
export async function queueSubmission({ store, releaseId, role, aab, runEas, retryFailed = false }) {
  const state = await store.read(releaseId);
  const stage = `${role}-submit`;
  const previous = latestCheckpoint(state.checkpoints, stage);
  if (previous && previous.status !== 'not-published') {
    if (!previous.submission_id) throw new Error(`${role} enqueue is unresolved; reconcile its EAS ID before retrying.`);
    const observed = verifySubmission(JSON.parse(runEas(['submit:view', previous.submission_id, '--json'])), previous.submission_id, role);
    if (['ERRORED', 'CANCELED'].includes(observed.status)) {
      if (!retryFailed || !observed.canRetry) throw new Error(`${role} submission failed. Resume with provider retry support or explicitly abandon this release; never upload another AAB under the same codes.`);
      if (previous.operation?.status !== 'failed') await checkpointReleaseOperation(store, releaseId, stage,
        { type: 'failed', definitive: true, reason: observed.status, proof: observed });
      await checkpointReleaseOperation(store, releaseId, stage, { type: 'retry' }, { prior_submission_id: previous.submission_id });
      const retried = JSON.parse(runEas(['submit:retry', previous.submission_id, '--non-interactive', '--json']));
      if (!new RegExp(`^${UUID}$`).test(retried.id ?? '')) throw new Error('EAS retry outcome is ambiguous; reconcile before continuing.');
      await checkpointReleaseOperation(store, releaseId, stage, { type: 'accepted', operationId: retried.id },
        { prior_submission_id: previous.submission_id });
      const checked = verifySubmission(JSON.parse(runEas(['submit:view', retried.id, '--json'])), retried.id, role);
      if (['ERRORED', 'CANCELED'].includes(checked.status)) {
        await checkpointReleaseOperation(store, releaseId, stage, { type: 'failed', definitive: true, reason: checked.status });
        throw new Error('EAS rejected the replacement submission.');
      }
      await recordSubmissionHandoff(store, releaseId, role, checked);
      return retried.id;
    }
    await recordSubmissionHandoff(store, releaseId, role, observed);
    return previous.submission_id;
  }
  await checkpointReleaseOperation(store, releaseId, stage, previous ? { type: 'retry' } : { type: 'intent', operationKey: stage });
  const output = runEas(['submit', '--platform', 'android', '--profile', role, '--path', aab, '--non-interactive', '--no-wait']);
  const id = parseSubmissionId(output);
  // Persist the ID before readback, so a readback outage cannot cause a duplicate enqueue.
  await checkpointReleaseOperation(store, releaseId, stage, { type: 'accepted', operationId: id });
  const observed = verifySubmission(JSON.parse(runEas(['submit:view', id, '--json'])), id, role);
  if (['ERRORED', 'CANCELED'].includes(observed.status)) {
    await checkpointReleaseOperation(store, releaseId, stage, { type: 'failed', definitive: true, reason: observed.status });
    throw new Error('EAS rejected the initial submission before OTA handoff.');
  }
  await recordSubmissionHandoff(store, releaseId, role, observed);
  return id;
}

/** Monitor transport completion separately from OTA; this does not poll Play review or approval. */
export async function waitForSubmission({ store, releaseId, role, id, runEas, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 240 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const submission = verifySubmission(JSON.parse(runEas(['submit:view', id, '--json'])), id, role);
    const previous = latestCheckpoint((await store.read(releaseId)).checkpoints, `${role}-submit`);
    if (submission.status === 'FINISHED') {
      await recordSubmissionHandoff(store, releaseId, role, submission);
      if (previous?.status !== 'succeeded') await checkpointReleaseOperation(store, releaseId, `${role}-submit`,
        { type: 'complete', receipt: submission, proof: submission });
      return;
    }
    if (['ERRORED', 'CANCELED'].includes(submission.status)) {
      if (previous?.status !== 'failed') await checkpointReleaseOperation(store, releaseId, `${role}-submit`,
        { type: 'failed', definitive: true, reason: submission.status, proof: submission }, { submission_id: id });
      throw new Error(`${role} EAS submission ${id} ${submission.status.toLowerCase()}; OTA is independent. Recover this release before another cut.`);
    }
    if (attempt % 4 === 0) console.log(`${role} submission ${id}: ${submission.status}`);
    await sleep(15000);
  }
  throw new Error(`${role} submission ${id} is still pending; resume monitoring instead of resubmitting.`);
}

/** Queue phone once, or finish the serialized phone/Wear chain using verified retained AABs. */
async function main() {
  const [operation, releaseId, artifactRoot, toolRoot] = process.argv.slice(2);
  if (!['queue-phone', 'finish'].includes(operation) || !toolRoot) throw new Error('Usage: native-eas-submit.mjs <queue-phone|finish> <release-id> <artifact-root> <tool-root>');
  if (!process.env.EXPO_TOKEN) throw new Error('EXPO_TOKEN is required for EAS submission.');
  const store = new ReleaseRecordStore();
  const directory = path.join(process.env.RUNNER_TEMP ?? artifactRoot, 'native-eas-submitter');
  writeSubmissionProject(directory);
  /** Use the isolated pinned provider client; no source build runs with this authentication. */
  const runEas = (args) => easInvocation(path.resolve(toolRoot), directory, args);
  const phone = path.resolve(artifactRoot, 'mobile/android/app/build/outputs/bundle/release/app-release.aab');
  const wear = path.resolve(artifactRoot, 'wear/app/build/outputs/bundle/release/app-release.aab');
  const retryFailed = process.env.RETRY_FAILED_SUBMISSION === 'true';
  const id = await queueSubmission({ store, releaseId, role: 'phone', aab: phone, runEas, retryFailed });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `phone_submission_id=${id}\n`);
  if (operation === 'queue-phone') return;
  await waitForSubmission({ store, releaseId, role: 'phone', id, runEas });
  const wearId = await queueSubmission({ store, releaseId, role: 'wear', aab: wear, runEas, retryFailed });
  await waitForSubmission({ store, releaseId, role: 'wear', id: wearId, runEas });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
