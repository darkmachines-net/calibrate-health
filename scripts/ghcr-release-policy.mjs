/** @file GHCR release alias, manifest, config, and attestation policy for exact immutable image publication. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SINGLE_MANIFEST_MEDIA_TYPES = Object.freeze([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json'
]);
export const MULTI_PLATFORM_MEDIA_TYPES = Object.freeze([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json'
]);
const CONFIG_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json'
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

/** Requires a single linux/amd64 image manifest and matching image configuration rather than a platform index. */
export function validateSingleAmd64Manifest(manifestValue, imageConfigValue) {
  const manifest = requireObject(manifestValue, 'Registry manifest');
  const imageConfig = requireObject(imageConfigValue, 'Registry image configuration');
  if (MULTI_PLATFORM_MEDIA_TYPES.includes(manifest.mediaType)) {
    throw new Error(`Registry object is a multi-platform index/list (${manifest.mediaType}).`);
  }
  if (!SINGLE_MANIFEST_MEDIA_TYPES.includes(manifest.mediaType)) {
    throw new Error(`Registry object uses unsupported manifest media type ${String(manifest.mediaType)}.`);
  }
  if (manifest.schemaVersion !== 2) throw new Error('Registry image manifest must use schemaVersion 2.');
  const config = requireObject(manifest.config, 'Registry manifest config descriptor');
  if (!DIGEST_PATTERN.test(config.digest)) throw new Error('Registry manifest config digest is malformed.');
  if (!CONFIG_MEDIA_TYPES.has(config.mediaType)) {
    throw new Error(`Registry manifest config media type ${String(config.mediaType)} is unsupported.`);
  }
  if (!Array.isArray(manifest.layers)) throw new Error('Registry image manifest layers are malformed.');
  if (imageConfig.os !== 'linux' || imageConfig.architecture !== 'amd64') {
    throw new Error(
      `Registry image platform must be linux/amd64, received ${String(imageConfig.os)}/${String(imageConfig.architecture)}.`
    );
  }
  return Object.freeze({
    mediaType: manifest.mediaType,
    configDigest: config.digest,
    os: imageConfig.os,
    architecture: imageConfig.architecture
  });
}

function requireImageRef(imageRef) {
  if (
    typeof imageRef !== 'string' ||
    !/^ghcr\.io\/[a-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(imageRef) ||
    imageRef.includes('..')
  ) {
    throw new Error('GHCR image ref is malformed.');
  }
  return imageRef;
}

/** Recognizes only an exact requested-image absence response; authorization and other registry failures remain errors. */
export function isExplicitRegistryAbsence(stderr, imageRef) {
  if (typeof stderr !== 'string') throw new Error('Registry inspection stderr must be text.');
  const requestedRef = requireImageRef(imageRef);
  const escapedRef = requestedRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = stderr.replaceAll('\r\n', '\n').trim();
  return new RegExp(`^ERROR: ${escapedRef}: (?:not found|manifest unknown)$`, 'i').test(normalized);
}

function parseArguments(args) {
  const command = args[0];
  const allowed = command === 'validate-manifest'
    ? new Set(['--manifest-file', '--image-config-file'])
    : command === 'classify-absence'
      ? new Set(['--error-file', '--image-ref'])
      : null;
  if (!allowed) throw new Error('Expected command: validate-manifest or classify-absence.');
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || !value || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete GHCR policy option: ${option ?? '(missing)'}.`);
    }
    if (Object.hasOwn(values, option)) throw new Error(`Duplicate GHCR policy option: ${option}.`);
    values[option] = value;
  }
  for (const option of allowed) {
    if (!values[option]) throw new Error(`${option} is required.`);
  }
  return { command, values };
}

function readRegularFile(file, maximumBytes, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`${label} must be a regular file of at most ${maximumBytes} bytes.`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/** Dispatches registry shape or absence validation and fails closed on unrecognized registry evidence. */
export function runGhcrReleasePolicyCli(args = process.argv.slice(2)) {
  const { command, values } = parseArguments(args);
  if (command === 'classify-absence') {
    const stderr = readRegularFile(values['--error-file'], 256 * 1024, 'Registry inspection error');
    if (!isExplicitRegistryAbsence(stderr, values['--image-ref'])) {
      throw new Error('Registry inspection failure is not the exact requested-ref absence response.');
    }
    return Object.freeze({ absent: true });
  }
  const manifest = JSON.parse(readRegularFile(values['--manifest-file'], 1024 * 1024, 'Registry manifest'));
  const imageConfig = JSON.parse(
    readRegularFile(values['--image-config-file'], 1024 * 1024, 'Registry image configuration')
  );
  return validateSingleAmd64Manifest(manifest, imageConfig);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = runGhcrReleasePolicyCli();
    if (typeof result?.configDigest === 'string') process.stdout.write(`${result.configDigest}\n`);
  } catch (error) {
    console.error(`[ghcr-release-policy] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
