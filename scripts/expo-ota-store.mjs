/** @file Retain attested OTA exports so recovery reuses exact bundle bytes without executing application source. */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ReleaseRecordStore, latestCheckpoint } from './release-record.mjs';
import { verifyUpdateArtifact } from './expo-ota-artifact.mjs';
import { verifyNativeArtifactMetadata } from './native-release-artifacts.mjs';
import { releaseGit } from './release-selection.mjs';
import { parseNativePlayWorkflowTrustSet } from './native-play-receipt.mjs';
import { createReleaseArtifactManifest, verifyReleaseArtifactManifest } from './release-engine.mjs';
import { RELEASE_ENGINE_CONFIG, RELEASE_ENGINE_TRUST_FILES } from './release-engine.config.mjs';

/** Resolve the immutable source and channel from the orchestration record. */
export function otaTarget(state, channel) {
  if (!['internal', 'production'].includes(channel)) throw new Error('Invalid OTA channel.');
  return { sourceCommit: latestCheckpoint(state.checkpoints, 'prepared')?.source_commit ?? state.record.source_commit,
    channel, environment: channel === 'production' ? 'production' : 'preview', projectId: RELEASE_ENGINE_CONFIG.expo.projectId };
}

/** Authenticate the export's file hashes against its original reviewed workflow before reuse. */
export function verifyOtaAttestation(file, signer, root, repository, execute = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(signer ?? '')) throw new Error('Missing OTA producing workflow identity.');
  const current = releaseGit(root, ['rev-parse', 'refs/remotes/origin/master']);
  releaseGit(root, ['merge-base', '--is-ancestor', signer, current]);
  const policy = parseNativePlayWorkflowTrustSet(releaseGit(root, ['show', `${current}:.github/native-play-attestation-trusted-workflow-shas`]));
  if (policy.revoked.includes(signer)) throw new Error('OTA artifact signer is revoked by current master.');
  const critical = ['.github/workflows/expo-ota-update.yml', 'scripts/expo-ota-artifact.mjs',
    'scripts/expo-ota-store.mjs', 'scripts/expo-runtime.mjs', 'scripts/release-config.mjs', ...RELEASE_ENGINE_TRUST_FILES];
  if (!policy.allowed.includes(signer) && !critical.every((name) =>
    releaseGit(root, ['rev-parse', `${signer}:${name}`]) === releaseGit(root, ['rev-parse', `${current}:${name}`]))) {
    throw new Error('Retain the reviewed OTA signer in the master trust policy before recovery.');
  }
  execute('gh', ['attestation', 'verify', file, '--repo', repository,
    '--signer-workflow', `${repository}/.github/workflows/expo-ota-update.yml`,
    '--signer-digest', signer, '--source-digest', signer,
    '--source-ref', 'refs/heads/master', '--deny-self-hosted-runners'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** Compare production targeting with the verified runtime embedded in the selected phone binary. */
export async function verifySelectedNativeRuntime(store, releaseId, state, provenance, directory, toolRoot) {
  if (!state.record.plan.native || provenance.channel !== 'production') return;
  const checkpoint = latestCheckpoint(state.checkpoints, 'native-build');
  const asset = state.assets.find((item) => item.name === 'native-metadata.json');
  if (!asset || !checkpoint?.metadata_sha256) throw new Error('Selected native build evidence is missing.');
  const file = path.join(directory, 'native-runtime-metadata.json');
  await store.download(asset, checkpoint.metadata_sha256, file);
  const metadata = verifyNativeArtifactMetadata(toolRoot, file, store.repository);
  if (metadata.source_commit !== provenance.sourceCommit || metadata.native.runtime_version !== provenance.runtimeVersion) {
    throw new Error('Production OTA runtime differs from the selected phone binary.');
  }
}

/** Compress only verified files; hashes and attestation authenticate the uncompressed export. */
export function packOtaArtifact(root, target) {
  const provenance = verifyUpdateArtifact({ artifactRoot: root, ...target });
  return gzipSync(JSON.stringify({ provenance: fs.readFileSync(path.join(root, 'provenance.json')).toString('base64'), files: provenance.files.map((file) => ({
    path: file.path, bytes: fs.readFileSync(path.join(root, 'bundle', file.path)).toString('base64')
  })) }));
}

/** Restore a bounded inert export without allowing archive paths to escape the destination. */
export function unpackOtaArtifact(bytes, root, target) {
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }));
  if (fs.existsSync(root)) throw new Error('OTA restore destination must not exist.');
  fs.mkdirSync(path.join(root, 'bundle'), { recursive: true });
  if (typeof value.provenance !== 'string') throw new Error('Missing exact retained provenance bytes.');
  fs.writeFileSync(path.join(root, 'provenance.json'), Buffer.from(value.provenance, 'base64'));
  const names = new Set();
  for (const file of value.files ?? []) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.startsWith('/') || file.path.includes(':') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') || names.has(file.path)) throw new Error('Unsafe retained OTA path.');
    names.add(file.path);
    const destination = path.join(root, 'bundle', file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(file.bytes, 'base64'), { flag: 'wx' });
  }
  return verifyUpdateArtifact({ artifactRoot: root, ...target });
}

/** Store immutable export bytes after the source-free attestation job has verified the producing run. */
export async function retainOtaArtifact(store, releaseId, channel, root, toolRoot) {
  const state = await store.read(releaseId);
  const target = otaTarget(state, channel);
  const provenance = verifyUpdateArtifact({ artifactRoot: root, ...target });
  const signer = process.env.WORKFLOW_SHA;
  verifyOtaAttestation(path.join(root, 'provenance.json'), signer, toolRoot, store.repository);
  await verifySelectedNativeRuntime(store, releaseId, state, provenance, path.dirname(root), toolRoot);
  const artifactManifest = await createReleaseArtifactManifest(root);
  const expectedFiles = ['provenance.json', ...provenance.files.map((file) => `bundle/${file.path}`)].sort();
  if (JSON.stringify(artifactManifest.files.map((file) => file.path).sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error('OTA artifact contains files outside its retained provenance inventory.');
  }
  const bytes = packOtaArtifact(root, target);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const name = `ota-${channel}.json.gz`;
  const existing = state.assets.find((asset) => asset.name === name);
  if (existing) {
    const retained = await store.api(`/releases/assets/${existing.id}`, { raw: true });
    if (createHash('sha256').update(retained).digest('hex') !== hash) throw new Error('OTA export already retained with different bytes. Resume its original export.');
  } else await store.upload(releaseId, name, bytes);
  await verifyReleaseArtifactManifest(root, artifactManifest);
  await store.checkpoint(releaseId, `ota-${channel}-artifact`, { status: 'succeeded', sha256: hash, workflow_sha: signer,
    artifact_manifest: artifactManifest,
    runtime_version: provenance.runtimeVersion, bundle_integrity: provenance.bundleIntegrity });
}

/** Restore and verify the original export before an isolated publisher receives its Expo token. */
export async function restoreOtaArtifact(store, releaseId, channel, root, toolRoot) {
  const state = await store.read(releaseId);
  const checkpoint = latestCheckpoint(state.checkpoints, `ota-${channel}-artifact`);
  const asset = state.assets.find((item) => item.name === `ota-${channel}.json.gz`);
  if (checkpoint?.status !== 'succeeded' || !asset) throw new Error('No retained OTA export; resume the original export/retention jobs.');
  const bytes = await store.api(`/releases/assets/${asset.id}`, { raw: true });
  if (createHash('sha256').update(bytes).digest('hex') !== checkpoint.sha256) throw new Error('Retained OTA archive hash mismatch.');
  const provenance = unpackOtaArtifact(bytes, root, otaTarget(state, channel));
  if (checkpoint.artifact_manifest) await verifyReleaseArtifactManifest(root, checkpoint.artifact_manifest);
  verifyOtaAttestation(path.join(root, 'provenance.json'), checkpoint.workflow_sha, toolRoot, store.repository);
  await verifySelectedNativeRuntime(store, releaseId, state, provenance, path.dirname(root), toolRoot);
}

/** Inspect checkpoints read-only, or retain/restore explicit channel exports on source-free runners. */
async function main() {
  const [command, releaseId, channel, root, toolRoot] = process.argv.slice(2);
  const store = new ReleaseRecordStore();
  if (command === 'inspect') {
    const state = await store.read(releaseId);
    for (const value of ['internal', 'production']) {
      const retained = latestCheckpoint(state.checkpoints, `ota-${value}-artifact`)?.status === 'succeeded';
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${value}_retained=${retained}\n`);
    }
  } else if (command === 'retain') await retainOtaArtifact(store, releaseId, channel, root, toolRoot);
  else if (command === 'restore') await restoreOtaArtifact(store, releaseId, channel, root, toolRoot);
  else throw new Error('Expected inspect, retain, or restore.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
