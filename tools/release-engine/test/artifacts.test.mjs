/** @file Verify exact artifact membership, byte integrity, hostile manifests, and symlink rejection across portable staging trees. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactManifest, hashIdentity, validateArtifactPath, verifyArtifactManifest } from '../index.mjs';

async function staging(t) {
  const root = await mkdtemp(join(tmpdir(), 'expo-release-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('manifest verifies exact nested bytes and rejects additions and modifications', async (t) => {
  const root = await staging(t);
  await mkdir(join(root, 'bundle'));
  await writeFile(join(root, 'bundle', 'app.hbc'), Buffer.from([0, 1, 255]));
  const manifest = await createArtifactManifest(root);
  assert.equal(manifest.files[0].path, 'bundle/app.hbc');
  assert.equal(manifest.files[0].size, 3);
  assert.deepEqual(await verifyArtifactManifest(root, manifest), manifest);
  await writeFile(join(root, 'extra.txt'), 'unreviewed');
  await assert.rejects(verifyArtifactManifest(root, manifest), /file set or bytes/);
  await rm(join(root, 'extra.txt'));
  await writeFile(join(root, 'bundle', 'app.hbc'), Buffer.from([0, 2, 255]));
  await assert.rejects(verifyArtifactManifest(root, manifest), /file set or bytes/);
});

test('unsafe artifact paths and self-consistent hostile manifests are rejected', async (t) => {
  const root = await staging(t);
  for (const path of ['../secret', '/absolute', 'a/../secret', 'a\\secret', 'C:/secret', 'file:stream', 'a//b', './a', 'CON.txt', 'file.', 'file ']) {
    assert.throws(() => validateArtifactPath(path), /Artifact path|Unsafe artifact/);
  }
  const payload = { schemaVersion: 1, kind: 'release-artifact-manifest', files: [{ path: '../secret', size: 0, sha256: 'a'.repeat(64) }] };
  await assert.rejects(verifyArtifactManifest(root, { ...payload, digest: hashIdentity(payload) }), /Unsafe artifact/);
  const clean = await createArtifactManifest(root);
  await assert.rejects(verifyArtifactManifest(root, { ...clean, digest: 'b'.repeat(64) }), /manifest digest/);
});

test('directory symlinks and symlink roots cannot introduce outside files', async (t) => {
  const parent = await staging(t);
  const root = join(parent, 'root');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside');
  try {
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('This Windows sandbox does not permit creation of symlink fixtures; Linux CI exercises this case.');
      return;
    }
    throw error;
  }
  await assert.rejects(createArtifactManifest(root), /symlink/);
  await assert.rejects(createArtifactManifest(join(root, 'linked')), /real directory/);
});
