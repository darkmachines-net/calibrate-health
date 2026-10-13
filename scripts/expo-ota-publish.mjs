/** @file Publish a verified pre-exported update and retain its exact EAS result for interruption-safe recovery. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ReleaseRecordStore, latestCheckpoint } from './release-record.mjs';
import { verifyUpdateArtifact } from './expo-ota-artifact.mjs';
import { canRunCalibrateStage, checkpointReleaseOperation } from './release-engine.mjs';

/** Refuse to repeat an ambiguous update publication; completed groups remain authoritative on recovery. */
export async function publishOta({ artifactRoot, toolRoot, publisherRoot, target, message, releaseId,
  store = releaseId ? new ReleaseRecordStore() : null, execute = execFileSync }) {
  const provenance = verifyUpdateArtifact({ artifactRoot, ...target });
  const stage = `ota-${target.channel}`;
  if (store) {
    const state = await store.read(releaseId);
    const previous = latestCheckpoint(state.checkpoints, stage);
    if (previous?.status === 'succeeded') return previous.publication;
    if (['started', 'unknown'].includes(previous?.status)) throw new Error('OTA publication outcome is unresolved. Reconcile its EAS update group before retrying.');
    if (state.record?.plan && !canRunCalibrateStage(state.record, state.checkpoints, stage)) {
      throw new Error('OTA publication prerequisites are incomplete.');
    }
    await checkpointReleaseOperation(store, releaseId, stage, previous ? { type: 'retry' } : { type: 'intent', operationKey: stage },
      { source_commit: target.sourceCommit, runtime_version: provenance.runtimeVersion, bundle_integrity: provenance.bundleIntegrity });
  }
  const env = { ...process.env, EAS_NO_VCS: '1', EAS_SKIP_AUTO_FINGERPRINT: '1', EXPO_NO_DOTENV: '1' };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const result = execute(process.execPath, [path.join(toolRoot, 'tools/eas-cli/node_modules/eas-cli/bin/run'),
    'update', '--skip-bundler', '--input-dir', path.join(artifactRoot, 'bundle'), '--channel', target.channel,
    '--message', message, '--environment', target.environment, '--platform', 'android', '--non-interactive', '--json'], {
    cwd: publisherRoot, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const updates = JSON.parse(result);
  if (!Array.isArray(updates) || updates.length !== 1 || updates[0].platform !== 'android'
    || !/^[a-f0-9-]{36}$/.test(updates[0].group ?? '') || updates[0].runtimeVersion !== provenance.runtimeVersion) {
    throw new Error('Expo returned an unexpected update identity. Reconcile publication before retrying.');
  }
  const publication = { group: updates[0].group, runtime_version: provenance.runtimeVersion,
    source_commit: target.sourceCommit, bundle_integrity: provenance.bundleIntegrity };
  if (store) await checkpointReleaseOperation(store, releaseId, stage, { type: 'complete', receipt: publication }, { publication });
  console.log(`Published ${target.channel} OTA group ${publication.group} for runtime ${publication.runtime_version}.`);
  return publication;
}

/** Read only explicit workflow configuration; source code has already been exported without tokens. */
async function main() {
  const [artifactRoot, toolRoot] = process.argv.slice(2);
  if (!artifactRoot || !toolRoot || !process.env.EXPO_TOKEN) throw new Error('OTA publication requires artifact/tool roots and EXPO_TOKEN.');
  const result = await publishOta({ artifactRoot: path.resolve(artifactRoot), toolRoot: path.resolve(toolRoot),
    publisherRoot: process.cwd(), message: process.env.OTA_MESSAGE, releaseId: process.env.RELEASE_RECORD_ID,
    target: { sourceCommit: process.env.OTA_SOURCE_REF, channel: process.env.EXPO_UPDATES_CHANNEL,
      environment: process.env.EAS_ENVIRONMENT, projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `update_group=${result.group}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
