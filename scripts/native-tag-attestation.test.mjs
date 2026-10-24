/** @file Regression coverage for native tag attestation: parses raw OpenSSH keys and normalizes fixed-principal allowed signers. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  NATIVE_TAG_ALLOWED_SIGNERS_PLACEHOLDER,
  NATIVE_TAG_SIGNING_PRINCIPAL,
  parseNativeTagAllowedSigners,
  parseNativeTagPublicKey,
  runNativeTagAttestationCli,
  validateNativeTagObject,
  verifyNativeTagAttestation
} from './native-tag-attestation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TAG = 'native-v1.2.3';
const EXPECTED_COMMIT = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function publicKeyFixture(byte = 1) {
  const keyType = 'ssh-ed25519';
  const blob = Buffer.concat([sshString(keyType), sshString(Buffer.alloc(32, byte))]);
  return `${keyType} ${blob.toString('base64')} fixture-${byte}`;
}

function signedTagObject(options = {}) {
  const tag = options.internalTag ?? TAG;
  const target = options.target ?? EXPECTED_COMMIT;
  const signature = options.signed === false
    ? ''
    : [
        '-----BEGIN SSH SIGNATURE-----',
        'ZmFrZS1zaWduYXR1cmU=',
        '-----END SSH SIGNATURE-----'
      ].join('\n');
  return [
    `object ${target}`,
    `type ${options.targetType ?? 'commit'}`,
    `tag ${tag}`,
    'tagger Release Bot <release@example.com> 1788000000 +0000',
    '',
    'Native release attestation.',
    signature
  ].filter((line, index, lines) => line.length > 0 || index < lines.length - 1).join('\n') + '\n';
}

function commandResult(options = {}) {
  return {
    status: options.status ?? 0,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? ''
  };
}

function gitFixture(options = {}) {
  const parsedKey = parseNativeTagPublicKey(options.verifyingKey ?? publicKeyFixture());
  const calls = [];
  let resolveCount = 0;
  let materializedAllowedSigners = '';
  const gitRunner = ({ repositoryRoot, args }) => {
    calls.push({ repositoryRoot, args });
    if (args[0] === 'rev-parse') {
      if (args[2] === `${TAG_OBJECT}^{commit}`) {
        return commandResult({ stdout: `${options.peeledCommit ?? EXPECTED_COMMIT}\n` });
      }
      resolveCount += 1;
      if (options.lightweight) {
        return commandResult({ status: 128, stderr: 'fatal: expected a tag object' });
      }
      const resolved = options.changedDuringVerification && resolveCount > 1
        ? 'c'.repeat(40)
        : TAG_OBJECT;
      return commandResult({ stdout: `${resolved}\n` });
    }
    if (args[0] === 'cat-file' && args[1] === '-t') {
      return commandResult({ stdout: `${options.objectType ?? 'tag'}\n` });
    }
    if (args[0] === 'cat-file' && args[1] === 'tag') {
      return commandResult({ stdout: options.contents ?? signedTagObject() });
    }
    if (args.includes('verify-tag')) {
      const allowedSignersArgument = args.find((argument) =>
        argument.startsWith('gpg.ssh.allowedSignersFile=')
      );
      const allowedSignersFile = allowedSignersArgument.split('=', 2)[1];
      materializedAllowedSigners = fs.readFileSync(allowedSignersFile, 'utf8');
      if (options.verificationFailure) {
        return commandResult({ status: 1, stderr: 'Could not verify signature.' });
      }
      const principal = options.reportedPrincipal ?? NATIVE_TAG_SIGNING_PRINCIPAL;
      const fingerprint = options.reportedFingerprint ?? parsedKey.fingerprint;
      return commandResult({
        stderr: `Good "git" signature for ${principal} with ED25519 key ${fingerprint}\n`
      });
    }
    throw new Error(`Unexpected Git arguments: ${args.join(' ')}`);
  };
  return {
    calls,
    gitRunner,
    get materializedAllowedSigners() { return materializedAllowedSigners; }
  };
}

test('parses raw OpenSSH keys and normalizes fixed-principal allowed signers', () => {
  const key1 = publicKeyFixture(1);
  const key2 = publicKeyFixture(2);
  const parsed1 = parseNativeTagPublicKey(key1);
  const parsed = parseNativeTagAllowedSigners([
    `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key1}`,
    `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key2}`,
    `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key1}`
  ].join('\n'));

  assert.equal(parsed1.keyType, 'ssh-ed25519');
  assert.match(parsed1.fingerprint, /^SHA256:/);
  assert.equal(parsed.keys.length, 2);
  assert.deepEqual(parsed.fingerprints, [
    parseNativeTagPublicKey(key1).fingerprint,
    parseNativeTagPublicKey(key2).fingerprint
  ]);
  assert.equal(parsed.normalizedContents.split('\n').filter(Boolean).length, 2);
  assert.ok(parsed.normalizedContents.split('\n').filter(Boolean).every(
    (line) => line.startsWith(`${NATIVE_TAG_SIGNING_PRINCIPAL} ssh-ed25519 `)
  ));
});

test('repository trust data is the exact fail-closed placeholder or a valid allowed-signers file', () => {
  const contents = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'native-release-tag-allowed-signers'),
    'utf8'
  ).replaceAll('\r\n', '\n');
  if (contents === NATIVE_TAG_ALLOWED_SIGNERS_PLACEHOLDER) return;
  assert.doesNotThrow(() => parseNativeTagAllowedSigners(contents));
});

test('allowed-signers parsing rejects other principals, options, malformed keys, and blank entries', () => {
  const key = publicKeyFixture();
  const [, keyType, keyData] = `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key}`.split(' ');
  const malformedBlob = Buffer.concat([sshString('ssh-rsa'), sshString(Buffer.alloc(32, 1))]).toString('base64');

  assert.throws(
    () => parseNativeTagAllowedSigners(`someone-else ${key}`),
    /must name only principal calibrate-native-release/
  );
  assert.throws(
    () => parseNativeTagAllowedSigners(
      `${NATIVE_TAG_SIGNING_PRINCIPAL} namespaces="other" ${keyType} ${keyData}`
    ),
    /Unsupported native tag SSH public-key type/
  );
  assert.throws(
    () => parseNativeTagPublicKey(`ssh-ed25519 ${malformedBlob}`),
    /type does not match/
  );
  assert.throws(
    () => parseNativeTagAllowedSigners(
      `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key}\n\n${NATIVE_TAG_SIGNING_PRINCIPAL} ${key}`
    ),
    /blank entries/
  );
});

test('pure tag-object validation requires annotated exact-name direct-commit SSH-signed metadata', () => {
  const result = validateNativeTagObject({
    tag: TAG,
    expectedCommit: EXPECTED_COMMIT,
    objectType: 'tag\n',
    contents: signedTagObject()
  });
  assert.equal(result.internalTag, TAG);
  assert.equal(result.expectedCommit, EXPECTED_COMMIT);

  assert.throws(
    () => validateNativeTagObject({
      tag: TAG,
      expectedCommit: EXPECTED_COMMIT,
      objectType: 'commit\n',
      contents: signedTagObject()
    }),
    /annotated tag, not a lightweight tag/
  );
  assert.throws(
    () => validateNativeTagObject({
      tag: TAG,
      expectedCommit: EXPECTED_COMMIT,
      objectType: 'tag',
      contents: signedTagObject({ internalTag: 'native-v9.9.9' })
    }),
    /not requested tag/
  );
  assert.throws(
    () => validateNativeTagObject({
      tag: TAG,
      expectedCommit: EXPECTED_COMMIT,
      objectType: 'tag',
      contents: signedTagObject({ target: 'd'.repeat(40) })
    }),
    /not expected commit/
  );
  assert.throws(
    () => validateNativeTagObject({
      tag: TAG,
      expectedCommit: EXPECTED_COMMIT,
      objectType: 'tag',
      contents: signedTagObject({ targetType: 'tag' })
    }),
    /must target a commit/
  );
  assert.throws(
    () => validateNativeTagObject({
      tag: TAG,
      expectedCommit: EXPECTED_COMMIT,
      objectType: 'tag',
      contents: signedTagObject({ signed: false })
    }),
    /exactly one SSH signature/
  );
});

test('injected verification pins the tag object, principal, target, and reviewed overlap keys', () => {
  const key1 = publicKeyFixture(1);
  const key2 = publicKeyFixture(2);
  const key2Fingerprint = parseNativeTagPublicKey(key2).fingerprint;
  const fixture = gitFixture({ verifyingKey: key2, reportedFingerprint: key2Fingerprint });
  const result = verifyNativeTagAttestation({
    repositoryRoot: '.',
    tag: TAG,
    expectedCommit: EXPECTED_COMMIT,
    allowedSigners: [
      `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key1}`,
      `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key2}`
    ].join('\n'),
    gitRunner: fixture.gitRunner
  });

  assert.equal(result.tagObject, TAG_OBJECT);
  assert.equal(result.verifiedKeyFingerprint, key2Fingerprint);
  assert.deepEqual(result.publicKeyFingerprints, [
    parseNativeTagPublicKey(key1).fingerprint,
    key2Fingerprint
  ]);
  assert.equal(fixture.calls.filter(({ args }) => args[2] === `refs/tags/${TAG}^{tag}`).length, 2);
  assert.ok(fixture.calls.some(({ args }) => args[2] === `${TAG_OBJECT}^{commit}`));
  const verification = fixture.calls.find(({ args }) => args.includes('verify-tag'));
  assert.equal(verification.args.at(-1), TAG_OBJECT);
  assert.ok(verification.args.includes('gpg.format=ssh'));
  assert.ok(verification.args.includes('gpg.ssh.program=ssh-keygen'));
  assert.equal(fixture.materializedAllowedSigners.split('\n').filter(Boolean).length, 2);
});

test('verification fails closed for lightweight, wrong-key, wrong-principal, and unreviewed-key results', () => {
  const common = {
    repositoryRoot: '.',
    tag: TAG,
    expectedCommit: EXPECTED_COMMIT,
    publicKey: publicKeyFixture()
  };
  assert.throws(
    () => verifyNativeTagAttestation({ ...common, gitRunner: gitFixture({ lightweight: true }).gitRunner }),
    /Resolve annotated native tag .* failed/
  );
  assert.throws(
    () => verifyNativeTagAttestation({
      ...common,
      gitRunner: gitFixture({ verificationFailure: true }).gitRunner
    }),
    /Verify SSH signature .* failed/
  );
  assert.throws(
    () => verifyNativeTagAttestation({
      ...common,
      gitRunner: gitFixture({ reportedPrincipal: 'other-principal' }).gitRunner
    }),
    /did not verify for principal/
  );
  assert.throws(
    () => verifyNativeTagAttestation({
      ...common,
      gitRunner: gitFixture({ reportedFingerprint: 'SHA256:not-reviewed' }).gitRunner
    }),
    /outside the reviewed allowlist/
  );
});

test('verification rejects a precreated wrong-target tag and a tag changed during verification', () => {
  const common = {
    repositoryRoot: '.',
    tag: TAG,
    expectedCommit: EXPECTED_COMMIT,
    publicKey: publicKeyFixture()
  };
  assert.throws(
    () => verifyNativeTagAttestation({
      ...common,
      gitRunner: gitFixture({ contents: signedTagObject({ target: 'e'.repeat(40) }) }).gitRunner
    }),
    /not expected commit/
  );
  assert.throws(
    () => verifyNativeTagAttestation({
      ...common,
      gitRunner: gitFixture({ changedDuringVerification: true }).gitRunner
    }),
    /changed while its attestation was being verified/
  );
  assert.throws(
    () => verifyNativeTagAttestation({
      ...common,
      gitRunner: gitFixture({ peeledCommit: 'f'.repeat(40) }).gitRunner
    }),
    /peels to .* not expected commit/
  );
});

test('CLI reads an exact allowed-signers file and rejects ambiguous key-source arguments', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tag-attestation-cli-'));
  try {
    const allowedSignersFile = path.join(directory, 'allowed_signers');
    const key = publicKeyFixture();
    fs.writeFileSync(
      allowedSignersFile,
      `${NATIVE_TAG_SIGNING_PRINCIPAL} ${key}\n`,
      'utf8'
    );
    let output = '';
    const result = runNativeTagAttestationCli({
      args: [
        'verify',
        '--repository-root', directory,
        '--tag', TAG,
        '--expected-commit', EXPECTED_COMMIT,
        '--allowed-signers-file', allowedSignersFile
      ],
      gitRunner: gitFixture().gitRunner,
      stdout: { write: (value) => { output += value; } }
    });
    assert.equal(result.tag, TAG);
    assert.match(output, /^Native tag attestation verified/);

    assert.throws(
      () => runNativeTagAttestationCli({
        args: [
          'verify',
          '--repository-root', directory,
          '--tag', TAG,
          '--expected-commit', EXPECTED_COMMIT,
          '--allowed-signers-file', allowedSignersFile,
          '--public-key-file', allowedSignersFile
        ],
        gitRunner: gitFixture().gitRunner
      }),
      /exactly one of/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
}

test('real Git verifies an SSH-signed annotated tag and rejects unsigned, lightweight, stale, and wrong keys', (t) => {
  const sshProbe = run('ssh-keygen', ['-?']);
  if (sshProbe.error?.code === 'ENOENT') {
    t.skip('ssh-keygen is unavailable on this host');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tag-attestation-git-'));
  try {
    assert.equal(run('git', ['init', '--quiet'], directory).status, 0);
    assert.equal(run('git', ['config', 'user.name', 'Release Test'], directory).status, 0);
    assert.equal(run('git', ['config', 'user.email', 'release-test@example.com'], directory).status, 0);
    fs.writeFileSync(path.join(directory, 'payload.txt'), 'first\n', 'utf8');
    assert.equal(run('git', ['add', 'payload.txt'], directory).status, 0);
    assert.equal(run('git', ['commit', '--quiet', '-m', 'first'], directory).status, 0);
    const firstCommit = run('git', ['rev-parse', 'HEAD'], directory).stdout.trim();

    const signingKey = path.join(directory, 'tag-signing-key');
    const otherKey = path.join(directory, 'other-signing-key');
    assert.equal(run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey], directory).status, 0);
    assert.equal(run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherKey], directory).status, 0);
    const signedTag = run('git', [
      '-c', 'gpg.format=ssh',
      '-c', `user.signingkey=${signingKey}`,
      'tag', '-s', '-a', TAG, '-m', 'signed native release'
    ], directory);
    if (signedTag.status !== 0 && /unsupported|not supported|unknown value/i.test(signedTag.stderr)) {
      t.skip(`Git SSH signing is unavailable: ${signedTag.stderr.trim()}`);
      return;
    }
    assert.equal(signedTag.status, 0, signedTag.stderr);

    fs.appendFileSync(path.join(directory, 'payload.txt'), 'second\n', 'utf8');
    assert.equal(run('git', ['add', 'payload.txt'], directory).status, 0);
    assert.equal(run('git', ['commit', '--quiet', '-m', 'second'], directory).status, 0);
    const secondCommit = run('git', ['rev-parse', 'HEAD'], directory).stdout.trim();
    assert.equal(run('git', ['tag', '-a', 'native-v1.2.4', '-m', 'unsigned'], directory).status, 0);
    assert.equal(run('git', ['tag', 'native-v1.2.5'], directory).status, 0);

    const approvedKey = fs.readFileSync(`${signingKey}.pub`, 'utf8').trim();
    const otherPublicKey = fs.readFileSync(`${otherKey}.pub`, 'utf8').trim();
    const overlap = [
      `${NATIVE_TAG_SIGNING_PRINCIPAL} ${otherPublicKey}`,
      `${NATIVE_TAG_SIGNING_PRINCIPAL} ${approvedKey}`
    ].join('\n');
    const result = verifyNativeTagAttestation({
      repositoryRoot: directory,
      tag: TAG,
      expectedCommit: firstCommit,
      allowedSigners: overlap
    });
    assert.equal(result.expectedCommit, firstCommit);
    assert.equal(result.verifiedKeyFingerprint, parseNativeTagPublicKey(approvedKey).fingerprint);

    assert.throws(
      () => verifyNativeTagAttestation({
        repositoryRoot: directory,
        tag: TAG,
        expectedCommit: firstCommit,
        publicKey: otherPublicKey
      }),
      /Verify SSH signature .* failed/
    );
    assert.throws(
      () => verifyNativeTagAttestation({
        repositoryRoot: directory,
        tag: TAG,
        expectedCommit: secondCommit,
        publicKey: approvedKey
      }),
      /not expected commit/
    );
    assert.throws(
      () => verifyNativeTagAttestation({
        repositoryRoot: directory,
        tag: 'native-v1.2.4',
        expectedCommit: secondCommit,
        publicKey: approvedKey
      }),
      /exactly one SSH signature/
    );
    assert.throws(
      () => verifyNativeTagAttestation({
        repositoryRoot: directory,
        tag: 'native-v1.2.5',
        expectedCommit: secondCommit,
        publicKey: approvedKey
      }),
      /Resolve annotated native tag .* failed/
    );

    const approvedTagObject = run('git', ['rev-parse', `${TAG}^{tag}`], directory).stdout.trim();
    assert.equal(run('git', [
      '-c', 'gpg.format=ssh',
      '-c', `user.signingkey=${otherKey}`,
      'tag', '-s', '-f', '-a', TAG, '-m', 'unapproved replacement-ref source', firstCommit
    ], directory).status, 0);
    const unapprovedTagObject = run('git', ['rev-parse', `${TAG}^{tag}`], directory).stdout.trim();
    assert.notEqual(unapprovedTagObject, approvedTagObject);
    assert.equal(
      run('git', ['replace', unapprovedTagObject, approvedTagObject], directory).status,
      0
    );
    assert.throws(
      () => verifyNativeTagAttestation({
        repositoryRoot: directory,
        tag: TAG,
        expectedCommit: firstCommit,
        publicKey: approvedKey
      }),
      /Verify SSH signature .* failed/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
