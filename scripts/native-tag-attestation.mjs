import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const NATIVE_TAG_SIGNING_PRINCIPAL = 'calibrate-native-release';
export const NATIVE_TAG_ALLOWED_SIGNERS_PLACEHOLDER = [
  '# Native release onboarding must replace this comment-only placeholder with one or more reviewed SSH public keys:',
  '# calibrate-native-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...',
  '# Workflows read this trust set from current protected master so key revocation also applies to reruns.'
].join('\n') + '\n';

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_ALLOWED_SIGNERS_BYTES = 64 * 1024;
const MAX_ALLOWED_SIGNING_KEYS = 16;
const NATIVE_TAG_PATTERN = /^native-v\d+\.\d+\.\d+$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SUPPORTED_SSH_KEY_TYPES = new Set([
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'sk-ssh-ed25519@openssh.com',
  'ssh-ed25519',
  'ssh-rsa'
]);

function requireNativeTag(tag) {
  if (typeof tag !== 'string' || !NATIVE_TAG_PATTERN.test(tag)) {
    throw new Error('Native tag attestation requires --tag native-vMAJOR.MINOR.PATCH.');
  }
  return tag;
}

function requireExpectedCommit(commit) {
  if (typeof commit !== 'string' || !SHA1_PATTERN.test(commit)) {
    throw new Error('Native tag attestation requires --expected-commit with a full lowercase 40-character SHA.');
  }
  return commit;
}

function requireRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim().length === 0 || repositoryRoot.includes('\0')) {
    throw new Error('Native tag attestation requires --repository-root.');
  }
  return path.resolve(repositoryRoot);
}

function decodeSshKeyBlob(keyType, keyData) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyData) || keyData.length % 4 === 1) {
    throw new Error('The native tag public key is not valid base64.');
  }

  const decoded = Buffer.from(keyData, 'base64');
  const canonicalData = decoded.toString('base64').replace(/=+$/, '');
  if (!decoded.length || canonicalData !== keyData.replace(/=+$/, '')) {
    throw new Error('The native tag public key is not canonical base64.');
  }
  if (decoded.length < 5) throw new Error('The native tag public key blob is malformed.');

  const embeddedTypeLength = decoded.readUInt32BE(0);
  const embeddedTypeEnd = 4 + embeddedTypeLength;
  if (embeddedTypeLength < 1 || embeddedTypeEnd >= decoded.length) {
    throw new Error('The native tag public key blob is malformed.');
  }
  const embeddedType = decoded.subarray(4, embeddedTypeEnd).toString('utf8');
  if (embeddedType !== keyType) {
    throw new Error('The native tag public key type does not match its encoded key blob.');
  }
  return decoded;
}

/** Parse one raw OpenSSH public key without accepting allowed-signers options or principals. */
export function parseNativeTagPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || Buffer.byteLength(publicKey, 'utf8') > MAX_PUBLIC_KEY_BYTES) {
    throw new Error('The native tag public key is missing or too large.');
  }
  if (publicKey.includes('\0')) throw new Error('The native tag public key contains an invalid NUL byte.');

  const lines = publicKey.trim().split(/\r?\n/);
  if (lines.length !== 1 || lines[0].length === 0) {
    throw new Error('The native tag public key file must contain exactly one OpenSSH public key.');
  }
  const fields = lines[0].trim().split(/[\t ]+/);
  if (fields.length < 2) {
    throw new Error('The native tag public key must use OpenSSH public-key syntax.');
  }

  const [keyType, keyData] = fields;
  if (!SUPPORTED_SSH_KEY_TYPES.has(keyType)) {
    throw new Error(`Unsupported native tag SSH public-key type: ${keyType}.`);
  }
  const keyBlob = decodeSshKeyBlob(keyType, keyData);
  const fingerprint = crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');

  return Object.freeze({
    keyType,
    keyData,
    fingerprint: `SHA256:${fingerprint}`,
    allowedSignersEntry: `${NATIVE_TAG_SIGNING_PRINCIPAL} ${keyType} ${keyData}\n`
  });
}

/**
 * Parse a deliberately narrow allowed-signers file: one fixed principal, no
 * options, and one or more raw OpenSSH keys. Repeated keys are normalized away.
 */
export function parseNativeTagAllowedSigners(allowedSigners) {
  if (
    typeof allowedSigners !== 'string' ||
    allowedSigners.length === 0 ||
    Buffer.byteLength(allowedSigners, 'utf8') > MAX_ALLOWED_SIGNERS_BYTES
  ) {
    throw new Error('The native tag allowed-signers file is missing or too large.');
  }
  if (allowedSigners.includes('\0')) {
    throw new Error('The native tag allowed-signers file contains an invalid NUL byte.');
  }

  const lines = allowedSigners.trim().split(/\r?\n/);
  if (lines.some((line) => line.trim().length === 0)) {
    throw new Error('The native tag allowed-signers file must not contain blank entries.');
  }
  const uniqueKeys = new Map();
  for (const [index, line] of lines.entries()) {
    const fields = line.trim().split(/[\t ]+/);
    if (fields.length < 3 || fields[0] !== NATIVE_TAG_SIGNING_PRINCIPAL) {
      throw new Error(
        `Allowed signer entry ${index + 1} must name only principal ${NATIVE_TAG_SIGNING_PRINCIPAL}.`
      );
    }
    const parsed = parseNativeTagPublicKey(`${fields[1]} ${fields[2]}`);
    uniqueKeys.set(`${parsed.keyType} ${parsed.keyData}`, parsed);
  }
  if (uniqueKeys.size === 0 || uniqueKeys.size > MAX_ALLOWED_SIGNING_KEYS) {
    throw new Error(`The native tag allowed-signers file must contain 1-${MAX_ALLOWED_SIGNING_KEYS} unique keys.`);
  }

  const keys = [...uniqueKeys.values()];
  return Object.freeze({
    keys: Object.freeze(keys),
    fingerprints: Object.freeze(keys.map(({ fingerprint }) => fingerprint)),
    normalizedContents: keys.map(({ allowedSignersEntry }) => allowedSignersEntry).join('')
  });
}

function requireUniqueHeader(headers, name) {
  const matches = headers.filter(([header]) => header === name).map(([, value]) => value);
  if (matches.length !== 1 || matches[0].length === 0) {
    throw new Error(`Native tag object must contain exactly one ${name} header.`);
  }
  return matches[0];
}

/** Validate the immutable fields covered by an annotated tag's SSH signature. */
export function validateNativeTagObject(options = {}) {
  const tag = requireNativeTag(options.tag);
  const expectedCommit = requireExpectedCommit(options.expectedCommit);
  if (typeof options.objectType !== 'string' || options.objectType.trim() !== 'tag') {
    throw new Error(`Native tag ${tag} must be an annotated tag, not a lightweight tag.`);
  }
  if (typeof options.contents !== 'string') throw new Error(`Native tag ${tag} object is malformed.`);

  const headerEnd = options.contents.indexOf('\n\n');
  if (headerEnd < 1) throw new Error(`Native tag ${tag} object has malformed headers.`);
  const headers = options.contents.slice(0, headerEnd).split('\n').map((line) => {
    const separator = line.indexOf(' ');
    if (separator < 1) throw new Error(`Native tag ${tag} object has a malformed header.`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  });

  const target = requireUniqueHeader(headers, 'object');
  if (target !== expectedCommit) {
    throw new Error(`Native tag ${tag} targets ${target}, not expected commit ${expectedCommit}.`);
  }
  const targetType = requireUniqueHeader(headers, 'type');
  if (targetType !== 'commit') throw new Error(`Native tag ${tag} must target a commit, not ${targetType}.`);
  const internalTag = requireUniqueHeader(headers, 'tag');
  if (internalTag !== tag) {
    throw new Error(`Native tag object names ${internalTag}, not requested tag ${tag}.`);
  }
  requireUniqueHeader(headers, 'tagger');

  const signatureBegin = '-----BEGIN SSH SIGNATURE-----';
  const signatureEnd = '-----END SSH SIGNATURE-----';
  const beginCount = options.contents.split(signatureBegin).length - 1;
  const endCount = options.contents.split(signatureEnd).length - 1;
  if (
    beginCount !== 1 ||
    endCount !== 1 ||
    options.contents.indexOf(signatureBegin) <= headerEnd ||
    !options.contents.trimEnd().endsWith(signatureEnd)
  ) {
    throw new Error(`Native tag ${tag} must contain exactly one SSH signature.`);
  }

  return Object.freeze({ tag, expectedCommit, targetType, internalTag });
}

function commandDetail(result) {
  const detail = `${result?.stderr ?? ''}`.trim() || `${result?.stdout ?? ''}`.trim();
  return detail ? `: ${detail.slice(0, 2_000)}` : '';
}

function requireGitSuccess(result, label) {
  if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
    throw new Error(`${label} returned a malformed command result.`);
  }
  if (result.error) throw new Error(`${label} could not start: ${result.error.message ?? result.error}.`);
  if (result.status !== 0) throw new Error(`${label} failed${commandDetail(result)}`);
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    throw new Error(`${label} returned malformed command output.`);
  }
  return result;
}

function sanitizedGitEnvironment(environment) {
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      key === 'GIT_DIR' ||
      key === 'GIT_WORK_TREE' ||
      key === 'GIT_COMMON_DIR' ||
      key === 'GIT_OBJECT_DIRECTORY' ||
      key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
      key === 'GIT_CONFIG' ||
      key === 'GIT_CONFIG_COUNT' ||
      key === 'GIT_CONFIG_PARAMETERS' ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return {
    ...sanitized,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C'
  };
}

function defaultGitRunner({ repositoryRoot, args }) {
  return spawnSync('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(process.env),
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    windowsHide: true
  });
}

function invokeGit(gitRunner, repositoryRoot, args, label) {
  let result;
  try {
    result = gitRunner({ repositoryRoot, args: [...args] });
  } catch (error) {
    throw new Error(`${label} could not run: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
  return requireGitSuccess(result, label);
}

function createAllowedSignersFile(parsedAllowedSigners) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-tag-'));
  const file = path.join(directory, 'allowed_signers');
  try {
    fs.writeFileSync(file, parsedAllowedSigners.normalizedContents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
  } catch (error) {
    try { fs.rmdirSync(directory); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return { directory, file };
}

function removeAllowedSignersFile(temporary) {
  try { fs.unlinkSync(temporary.file); } catch { /* best-effort cleanup */ }
  try { fs.rmdirSync(temporary.directory); } catch { /* best-effort cleanup */ }
}

/**
 * Verify one resolved tag object against a single allowlisted SSH public key.
 * gitRunner is injectable for deterministic policy tests without signing keys.
 */
export function verifyNativeTagAttestation(options = {}) {
  const repositoryRoot = requireRepositoryRoot(options.repositoryRoot);
  const tag = requireNativeTag(options.tag);
  const expectedCommit = requireExpectedCommit(options.expectedCommit);
  if ((options.publicKey === undefined) === (options.allowedSigners === undefined)) {
    throw new Error('Provide exactly one native tag public key or allowed-signers file.');
  }
  let parsedAllowedSigners;
  if (options.allowedSigners === undefined) {
    const parsedPublicKey = parseNativeTagPublicKey(options.publicKey);
    parsedAllowedSigners = Object.freeze({
      keys: Object.freeze([parsedPublicKey]),
      fingerprints: Object.freeze([parsedPublicKey.fingerprint]),
      normalizedContents: parsedPublicKey.allowedSignersEntry
    });
  } else {
    parsedAllowedSigners = parseNativeTagAllowedSigners(options.allowedSigners);
  }
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  if (typeof gitRunner !== 'function') throw new Error('Native tag attestation requires a Git command runner.');

  const tagRef = `refs/tags/${tag}`;
  const resolved = invokeGit(
    gitRunner,
    repositoryRoot,
    ['rev-parse', '--verify', `${tagRef}^{tag}`],
    `Resolve annotated native tag ${tag}`
  ).stdout.trim();
  if (!SHA1_PATTERN.test(resolved)) {
    throw new Error(`Native tag ${tag} resolved to an invalid tag object ID.`);
  }

  const objectType = invokeGit(
    gitRunner,
    repositoryRoot,
    ['cat-file', '-t', resolved],
    `Inspect native tag ${tag} object type`
  ).stdout;
  const contents = invokeGit(
    gitRunner,
    repositoryRoot,
    ['cat-file', 'tag', resolved],
    `Read native tag ${tag} object`
  ).stdout;
  validateNativeTagObject({ tag, expectedCommit, objectType, contents });
  const peeledCommit = invokeGit(
    gitRunner,
    repositoryRoot,
    ['rev-parse', '--verify', `${resolved}^{commit}`],
    `Peel native tag ${tag} to its commit`
  ).stdout.trim();
  if (peeledCommit !== expectedCommit) {
    throw new Error(`Native tag ${tag} peels to ${peeledCommit}, not expected commit ${expectedCommit}.`);
  }

  const temporary = createAllowedSignersFile(parsedAllowedSigners);
  let verifiedKeyFingerprint;
  try {
    const signature = invokeGit(
      gitRunner,
      repositoryRoot,
      [
        '-c', 'gpg.format=ssh',
        '-c', 'gpg.ssh.program=ssh-keygen',
        '-c', `gpg.ssh.allowedSignersFile=${temporary.file}`,
        'verify-tag', '--raw', resolved
      ],
      `Verify SSH signature for native tag ${tag}`
    );
    const verificationOutput = `${signature.stdout}\n${signature.stderr}`;
    const goodSignature = new RegExp(
      `Good ["']git["'] signature for ${NATIVE_TAG_SIGNING_PRINCIPAL}(?:\\s|$)`
    );
    if (!goodSignature.test(verificationOutput)) {
      throw new Error(
        `Native tag ${tag} signature did not verify for principal ${NATIVE_TAG_SIGNING_PRINCIPAL}.`
      );
    }
    verifiedKeyFingerprint = parsedAllowedSigners.fingerprints.find(
      (fingerprint) => verificationOutput.includes(fingerprint)
    );
    if (!verifiedKeyFingerprint) {
      throw new Error(`Native tag ${tag} signature used a key outside the reviewed allowlist.`);
    }
  } finally {
    removeAllowedSignersFile(temporary);
  }

  const finalResolved = invokeGit(
    gitRunner,
    repositoryRoot,
    ['rev-parse', '--verify', `${tagRef}^{tag}`],
    `Re-resolve annotated native tag ${tag}`
  ).stdout.trim();
  if (finalResolved !== resolved) {
    throw new Error(`Native tag ${tag} changed while its attestation was being verified.`);
  }

  return Object.freeze({
    tag,
    expectedCommit,
    tagObject: resolved,
    principal: NATIVE_TAG_SIGNING_PRINCIPAL,
    publicKeyFingerprints: parsedAllowedSigners.fingerprints,
    verifiedKeyFingerprint
  });
}

function parseArguments(args) {
  const result = {
    command: args[0],
    repositoryRoot: null,
    tag: null,
    expectedCommit: null,
    publicKeyFile: null,
    allowedSignersFile: null
  };
  const argumentKeys = new Map([
    ['--repository-root', 'repositoryRoot'],
    ['--tag', 'tag'],
    ['--expected-commit', 'expectedCommit'],
    ['--public-key-file', 'publicKeyFile'],
    ['--allowed-signers-file', 'allowedSignersFile']
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const key = argumentKeys.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (result[key] !== null) throw new Error(`Duplicate argument: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    result[key] = value;
  }
  return result;
}

function readSigningKeyFile(keyFile, label, maxBytes) {
  if (typeof keyFile !== 'string' || keyFile.length === 0 || keyFile.includes('\0')) {
    throw new Error(`Native tag attestation requires ${label}.`);
  }
  const resolved = path.resolve(keyFile);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error(`${label} must name a regular file within its size limit.`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

export function runNativeTagAttestationCli(options = {}) {
  const config = parseArguments(options.args ?? process.argv.slice(2));
  if (config.command !== 'verify') throw new Error('Expected command: verify.');
  if ((config.publicKeyFile === null) === (config.allowedSignersFile === null)) {
    throw new Error('Provide exactly one of --public-key-file or --allowed-signers-file.');
  }
  const result = verifyNativeTagAttestation({
    repositoryRoot: config.repositoryRoot,
    tag: config.tag,
    expectedCommit: config.expectedCommit,
    ...(config.publicKeyFile === null
      ? {
          allowedSigners: readSigningKeyFile(
            config.allowedSignersFile,
            '--allowed-signers-file',
            MAX_ALLOWED_SIGNERS_BYTES
          )
        }
      : {
          publicKey: readSigningKeyFile(
            config.publicKeyFile,
            '--public-key-file',
            MAX_PUBLIC_KEY_BYTES
          )
        }),
    gitRunner: options.gitRunner
  });
  (options.stdout ?? process.stdout).write(
    `Native tag attestation verified for ${result.tag} at ${result.expectedCommit} ` +
      `(verified key ${result.verifiedKeyFingerprint}).\n`
  );
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runNativeTagAttestationCli();
  } catch (error) {
    console.error(`[native-tag-attestation] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
