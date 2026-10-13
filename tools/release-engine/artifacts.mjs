/** @file Seal and verify exact artifact trees without accepting symlinks, traversal, case collisions, or unlisted files. */
import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { constants } from 'node:fs';
import { hashIdentity, immutable, invariant } from './core.mjs';

/** Validate a portable artifact-relative path; logical artifact names cannot escape or alias another file on Windows. */
export function validateArtifactPath(value) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !isAbsolute(value), 'Artifact path must be relative.');
  const segments = value.split('/');
  invariant(segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !/[<>:"\\|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)), `Unsafe artifact path ${value}.`);
  return value;
}

async function fileDigest(path, initial) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    invariant(before.isFile() && before.dev === initial.dev && before.ino === initial.ino, 'Artifact changed during verification.');
    const hasher = createHash('sha256');
    const bytes = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      if (bytesRead === 0) break;
      hasher.update(bytes.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    invariant(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && position === after.size, 'Artifact changed while hashing.');
    return { size: after.size, sha256: hasher.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function enumerate(root) {
  const absoluteRoot = resolve(root);
  const rootInfo = await lstat(absoluteRoot);
  invariant(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Artifact root must be a real directory.');
  const files = [];
  const spellings = new Set();
  async function walk(directory, prefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      validateArtifactPath(path);
      const folded = path.toLowerCase();
      invariant(!spellings.has(folded), `Artifact path has a case collision: ${path}.`);
      spellings.add(folded);
      const absolute = join(directory, name);
      const rel = relative(absoluteRoot, absolute);
      invariant(!rel.startsWith('..') && !isAbsolute(rel), 'Artifact path escaped its root.');
      const info = await lstat(absolute);
      invariant(!info.isSymbolicLink(), `Artifact symlink is forbidden: ${path}.`);
      if (info.isDirectory()) await walk(absolute, path);
      else {
        invariant(info.isFile(), `Artifact must contain only regular files: ${path}.`);
        files.push({ path, ...await fileDigest(absolute, info) });
      }
    }
  }
  await walk(absoluteRoot, '');
  return files;
}

/** Hash all regular files under an inert staging directory; store the returned manifest outside that directory. */
export async function createArtifactManifest(root) {
  const files = await enumerate(root);
  const payload = { schemaVersion: 1, kind: 'release-artifact-manifest', files };
  return immutable({ ...payload, digest: hashIdentity(payload) });
}

/** Verify the exact file set and bytes, rejecting additions and substitutions before a publisher consumes them. */
export async function verifyArtifactManifest(root, manifest) {
  const checked = immutable(manifest);
  invariant(checked.schemaVersion === 1 && checked.kind === 'release-artifact-manifest' && Array.isArray(checked.files), 'Unsupported artifact manifest schema.');
  invariant(Object.keys(checked).sort().join(',') === 'digest,files,kind,schemaVersion', 'Unexpected artifact manifest fields.');
  const seen = new Set();
  for (const file of checked.files) {
    invariant(file && Object.keys(file).sort().join(',') === 'path,sha256,size', 'Unexpected artifact file fields.');
    validateArtifactPath(file.path);
    invariant(!seen.has(file.path.toLowerCase()), 'Duplicate artifact path.');
    seen.add(file.path.toLowerCase());
    invariant(Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), 'Invalid artifact size or digest.');
  }
  const { digest, ...payload } = checked;
  invariant(typeof digest === 'string' && hashIdentity(payload) === digest, 'Artifact manifest digest differs.');
  const actual = await createArtifactManifest(root);
  invariant(actual.digest === digest, 'Artifact file set or bytes differ from the retained manifest.');
  return checked;
}
