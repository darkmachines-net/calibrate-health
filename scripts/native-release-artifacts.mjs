/** @file Retain and independently verify signed native build evidence before EAS or Play credentials are admitted. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ReleaseRecordStore, latestCheckpoint } from './release-record.mjs';
import { releaseGit, wearInputHash } from './release-selection.mjs';
import { resolveExpoRuntime, verifyEmbeddedRuntime } from './expo-runtime.mjs';
import { parseNativePlayWorkflowTrustSet } from './native-play-receipt.mjs';
import { createReleaseArtifactManifest, verifyReleaseArtifactManifest } from './release-engine.mjs';
import { RELEASE_ENGINE_TRUST_FILES } from './release-engine.config.mjs';

export const NATIVE_ARTIFACT_PATHS = Object.freeze({
  'phone-apk': 'mobile/android/app/build/outputs/apk/release/app-release.apk',
  'phone-aab': 'mobile/android/app/build/outputs/bundle/release/app-release.aab',
  'wear-apk': 'wear/app/build/outputs/apk/release/app-release.apk',
  'wear-aab': 'wear/app/build/outputs/bundle/release/app-release.aab'
});
const CRITICAL = ['.github/workflows/native-build.yml', 'scripts/native-release-artifacts.mjs',
  'scripts/native-release-build.mjs', 'scripts/native-release-evidence.mjs', 'scripts/native-play-release.mjs',
  'scripts/expo-runtime.mjs', 'scripts/release-config.mjs', 'scripts/zip-entry.mjs',
  'scripts/release-selection.mjs', 'mobile/fingerprint.config.js', ...RELEASE_ENGINE_TRUST_FILES];

/** Hash verified regular files, rejecting symlinks at the artifact boundary. */
function fileHash(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Native artifacts must be regular files.');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Bind every retained binary to the inspected source, native runtime, and paired version codes. */
export function createNativeArtifactMetadata(root, source, workflowSha) {
  if (releaseGit(root, ['rev-parse', 'HEAD']) !== source || !/^[0-9a-f]{40}$/.test(workflowSha)) throw new Error('Native artifact source identity differs.');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/release.json'), 'utf8'));
  const runtime = resolveExpoRuntime(root, { environment: { ...process.env, EXPO_UPDATES_CHANNEL: 'production' } });
  for (const [id, member] of [['phone-apk', 'assets/fingerprint'], ['phone-aab', 'base/assets/fingerprint']]) {
    verifyEmbeddedRuntime(path.join(root, NATIVE_ARTIFACT_PATHS[id]), member, runtime);
  }
  return {
    schema_version: 1, source_commit: source, workflow_sha: workflowSha,
    application_id: manifest.android.application_id,
    native: { version: manifest.android.mobile.version_name,
      phone_code: manifest.android.mobile.version_code, wear_code: manifest.android.wear.version_code,
      runtime_version: runtime, wear_hash: wearInputHash(root, source) },
    artifacts: Object.entries(NATIVE_ARTIFACT_PATHS).map(([id, file]) => ({ id, path: file, sha256: fileHash(path.join(root, file)) }))
  };
}

/** Restrict attestation recovery using the freshly fetched master allow/revoke policy. */
export function authorizeNativeArtifactSigner(root, metadata) {
  const current = releaseGit(root, ['rev-parse', 'refs/remotes/origin/master']);
  const signer = metadata.workflow_sha;
  if (!/^[0-9a-f]{40}$/.test(signer ?? '') || !/^[0-9a-f]{40}$/.test(metadata.source_commit ?? '')) throw new Error('Invalid native signer/source SHA.');
  releaseGit(root, ['merge-base', '--is-ancestor', signer, current]);
  releaseGit(root, ['merge-base', '--is-ancestor', metadata.source_commit, current]);
  const policy = parseNativePlayWorkflowTrustSet(releaseGit(root, ['show', `${current}:.github/native-play-attestation-trusted-workflow-shas`]));
  if (policy.revoked.includes(signer)) throw new Error('The native artifact signer is revoked by current master.');
  if (policy.allowed.includes(signer)) return;
  const unchanged = CRITICAL.every((file) => releaseGit(root, ['rev-parse', `${signer}:${file}`]) === releaseGit(root, ['rev-parse', `${current}:${file}`]));
  if (!unchanged && !policy.allowed.includes(signer)) throw new Error('Retain the original reviewed native signer in the master trust policy before recovery.');
}

/** Verify GitHub's attestation independently of release asset names and editable metadata. */
export function verifyNativeArtifactMetadata(root, metadataFile, repository, execute = execFileSync) {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (metadata.schema_version !== 1 || metadata.application_id !== 'net.darkmachines.healthtracker'
    || !/^[a-f0-9]{40,64}$/.test(metadata.native?.runtime_version ?? '') || metadata.artifacts?.length !== 4) {
    throw new Error('Malformed retained native metadata.');
  }
  for (const [id, file] of Object.entries(NATIVE_ARTIFACT_PATHS)) {
    const matches = metadata.artifacts.filter((item) => item.id === id && item.path === file && /^[a-f0-9]{64}$/.test(item.sha256));
    if (matches.length !== 1) throw new Error('Unexpected native artifact identity.');
  }
  authorizeNativeArtifactSigner(root, metadata);
  execute('gh', ['attestation', 'verify', metadataFile, '--repo', repository,
    '--signer-workflow', `${repository}/.github/workflows/native-build.yml`,
    '--signer-digest', metadata.workflow_sha, '--source-digest', metadata.workflow_sha,
    '--source-ref', 'refs/heads/master', '--deny-self-hosted-runners'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  return metadata;
}

/** Upload the already attested build once; exact existing assets are safe to reuse after interruption. */
export async function retainNativeArtifacts(store, releaseId, artifactRoot, toolingRoot) {
  const state = await store.read(releaseId);
  const metadataFile = path.join(artifactRoot, 'native-metadata.json');
  const metadata = verifyNativeArtifactMetadata(toolingRoot, metadataFile, store.repository);
  const expectedSource = latestCheckpoint(state.checkpoints, 'prepared')?.source_commit ?? state.record.source_commit;
  if (metadata.source_commit !== expectedSource || metadata.workflow_sha !== state.record.workflow_sha) throw new Error('Native build does not belong to this release.');
  const files = [...metadata.artifacts.map((item) => ({ ...item, name: `${item.id}${path.extname(item.path)}` })),
    { path: 'native-metadata.json', name: 'native-metadata.json', sha256: fileHash(metadataFile) }];
  const provenanceFile = path.join(artifactRoot, 'build/native-release-provenance.json');
  if (fs.existsSync(provenanceFile)) files.push({ path: 'build/native-release-provenance.json',
    name: 'native-release-provenance.json', sha256: fileHash(provenanceFile) });
  const artifactManifest = await createReleaseArtifactManifest(artifactRoot);
  if (artifactManifest.files.length !== files.length || artifactManifest.files.some((item) =>
    !files.some((file) => file.path === item.path && file.sha256 === item.sha256))) {
    throw new Error('The native artifact tree contains unrecognized or changed files.');
  }
  for (const file of files) {
    if (fileHash(path.join(artifactRoot, file.path)) !== file.sha256) throw new Error('Native build bytes changed after attestation.');
    const existing = state.assets.find((item) => item.name === file.name);
    if (existing) {
      const bytes = await store.api(`/releases/assets/${existing.id}`, { raw: true });
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('A conflicting retained native asset already exists.');
    } else await store.upload(releaseId, file.name, fs.readFileSync(path.join(artifactRoot, file.path)));
  }
  await verifyReleaseArtifactManifest(artifactRoot, artifactManifest);
  await store.checkpoint(releaseId, 'native-build', { status: 'succeeded', native: metadata.native,
    artifact_manifest: artifactManifest, metadata_sha256: fileHash(metadataFile),
    aab_hashes: { phone: metadata.artifacts.find((file) => file.id === 'phone-aab').sha256,
      wear: metadata.artifacts.find((file) => file.id === 'wear-aab').sha256 } });
  return metadata;
}

/** Restore the identical attested bytes; recovery never rebuilds or adopts an unrelated store upload. */
export async function restoreNativeArtifacts(store, releaseId, artifactRoot, toolingRoot) {
  const state = await store.read(releaseId);
  const checkpoint = latestCheckpoint(state.checkpoints, 'native-build');
  if (checkpoint?.status !== 'succeeded') throw new Error('The release has no retained native build. Resume its build jobs first.');
  const metadataAsset = state.assets.find((item) => item.name === 'native-metadata.json');
  if (!metadataAsset) throw new Error('Retained native metadata is missing.');
  const metadataFile = path.join(artifactRoot, 'native-metadata.json');
  await store.download(metadataAsset, checkpoint.metadata_sha256, metadataFile);
  const metadata = verifyNativeArtifactMetadata(toolingRoot, metadataFile, store.repository);
  const expectedSource = latestCheckpoint(state.checkpoints, 'prepared')?.source_commit ?? state.record.source_commit;
  if (metadata.source_commit !== expectedSource || metadata.workflow_sha !== state.record.workflow_sha) throw new Error('Retained native source differs from this release.');
  for (const file of metadata.artifacts) {
    const asset = state.assets.find((item) => item.name === `${file.id}${path.extname(file.path)}`);
    if (!asset) throw new Error(`Retained ${file.id} is missing.`);
    await store.download(asset, file.sha256, path.join(artifactRoot, file.path));
  }
  if (checkpoint.artifact_manifest) {
    const provenance = checkpoint.artifact_manifest.files.find((file) => file.path === 'build/native-release-provenance.json');
    if (provenance) {
      const asset = state.assets.find((item) => item.name === 'native-release-provenance.json');
      if (!asset) throw new Error('Retained native provenance is missing.');
      await store.download(asset, provenance.sha256, path.join(artifactRoot, provenance.path));
    }
    await verifyReleaseArtifactManifest(artifactRoot, checkpoint.artifact_manifest);
  }
  return metadata;
}

/** Run metadata capture without credentials, or retained-asset operations with job-scoped GitHub access. */
async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'capture') fs.writeFileSync('native-metadata.json', `${JSON.stringify(createNativeArtifactMetadata(process.cwd(), first, second))}\n`);
  else if (command === 'retain') await retainNativeArtifacts(new ReleaseRecordStore(), first, path.resolve(second), path.resolve(third));
  else if (command === 'restore') await restoreNativeArtifacts(new ReleaseRecordStore(), first, path.resolve(second), path.resolve(third));
  else throw new Error('Usage: native-release-artifacts.mjs capture <source> <workflow> | retain/restore <release-id> <artifact-root> <tooling-root>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
