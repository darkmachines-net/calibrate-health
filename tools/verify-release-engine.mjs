/** @file Verifies a consumer's pinned engine snapshot, optionally against the authoritative action source. */

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'MChartier/expo-release-template';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

/** Validate an archive-relative path before resolving it beneath a snapshot root. */
export function snapshotPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..') || name.startsWith('/')) fail(`Unsafe snapshot path: ${name}`);
  const path = resolve(root, name);
  if (!path.startsWith(`${resolve(root)}${sep}`)) fail(`Snapshot path escapes its root: ${name}`);
  return path;
}

/** Enumerate regular files, rejecting links and special files before their contents can be read. */
export async function snapshotFiles(root, prefix = '') {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`Snapshot root must be a real directory: ${root}`);
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) fail(`Snapshot contains a symbolic link: ${name}`);
    if (entry.isDirectory()) result.push(...await snapshotFiles(path, name));
    else if (entry.isFile()) result.push(name);
    else fail(`Snapshot contains a non-regular file: ${name}`);
  }
  return result.sort();
}

/** Return a stable digest of a sorted path-to-content-digest map. */
export function snapshotDigest(files) {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
}

/** Verify every file and the exact file set; an authoritative source also proves the locked revision's contents. */
export async function verifySnapshot({ target, source, revision } = {}) {
  const targetRoot = resolve(target || process.cwd());
  const toolsInfo = await lstat(resolve(targetRoot, 'tools'));
  if (!toolsInfo.isDirectory() || toolsInfo.isSymbolicLink()) fail('Consumer tools must be a real directory.');
  const lockPath = resolve(targetRoot, 'release-engine.lock.json');
  const lockInfo = await lstat(lockPath);
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) fail('Engine lock must be a regular file.');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.repository !== repository || !/^[a-f0-9]{40}$/.test(lock.revision || '') || !lock.files || Array.isArray(lock.files) || typeof lock.files !== 'object') fail('Invalid release engine lock.');
  if (revision && (!/^[a-f0-9]{40}$/.test(revision) || revision !== lock.revision)) fail('Action revision and engine lock differ; update them together.');
  const snapshotRoot = resolve(targetRoot, 'tools/release-engine');
  const names = Object.keys(lock.files).sort();
  if (!names.length || !names.includes('index.mjs') || !names.includes('package.json')) fail('Engine snapshot is incomplete.');
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) fail('Engine paths collide on case-insensitive filesystems.');
  if (JSON.stringify(names) !== JSON.stringify(await snapshotFiles(snapshotRoot))) fail('Engine snapshot file set differs from its lock.');
  for (const name of names) {
    const hash = lock.files[name];
    if (!/^[a-f0-9]{64}$/.test(hash)) fail(`Invalid content digest: ${name}`);
    if (sha256(await readFile(snapshotPath(snapshotRoot, name))) !== hash) fail(`Engine snapshot changed: ${name}`);
  }
  if (snapshotDigest(lock.files) !== lock.digest) fail('Engine snapshot manifest digest differs.');
  const verifier = resolve(targetRoot, 'tools/verify-release-engine.mjs');
  const verifierInfo = await lstat(verifier);
  if (!verifierInfo.isFile() || verifierInfo.isSymbolicLink() || sha256(await readFile(verifier)) !== lock.verifierDigest) fail('Engine verification script changed.');
  if (source) {
    const sourceRoot = resolve(source, 'packages/release-engine');
    if (JSON.stringify(names) !== JSON.stringify(await snapshotFiles(sourceRoot))) fail('Engine snapshot file set differs from the pinned upstream source.');
    for (const name of names) {
      if (sha256(await readFile(snapshotPath(sourceRoot, name))) !== lock.files[name]) fail(`Engine snapshot differs from the pinned upstream source: ${name}`);
    }
    if (sha256(await readFile(resolve(source, 'scripts/verify-engine.mjs'))) !== lock.verifierDigest) fail('Engine verifier differs from the pinned upstream source.');
  }
  return { repository: lock.repository, revision: lock.revision, digest: lock.digest, files: names.length };
}

/** Parse explicit CLI options; unknown or repeated options fail instead of changing verification scope. */
export function parseArguments(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !allowed.includes(key) || key in result || !value || value.startsWith('--')) fail(`Invalid argument: ${args[index]}`);
    result[key] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2), ['target', 'source', 'revision']);
    const result = await verifySnapshot(options);
    process.stdout.write(`Verified ${result.repository}@${result.revision} (${result.files} files).\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
