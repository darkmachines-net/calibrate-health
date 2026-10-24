/** @file Regression coverage for firebase migration cli: offline CLI reports synthetic inventory and holds collisions without disclosing input. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DUMMY_AUTH_PASSWORD_HASH } = require('../src/utils/authCredentials');

const run = (args) => spawnSync(process.execPath, ['-r', 'ts-node/register', 'scripts/firebase-migration-plan.js', ...args],
  { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });

test('offline CLI reports synthetic inventory and holds collisions without disclosing input', () => {
  const filename = path.join(os.tmpdir(), `calibrate-firebase-synthetic-${randomUUID()}.json`);
  const input = {
    scope: { installationId: 'synthetic-install', sourceId: 'synthetic-source', projectId: 'synthetic-project' },
    accounts: [{ id: 1, email: 'synthetic@example.invalid', passwordHash: DUMMY_AUTH_PASSWORD_HASH,
      emailVerified: false, preservationDigest: 'a'.repeat(64) }], destination: []
  };
  try {
    fs.writeFileSync(filename, JSON.stringify(input), { flag: 'wx' });
    const clean = run([filename]);
    assert.equal(clean.status, 0, clean.stderr);
    const plan = JSON.parse(clean.stdout);
    assert.equal(plan.mode, 'offline-dry-run');
    assert.equal(plan.summary.eligible, 1);
    assert.ok(!clean.stdout.includes(input.accounts[0].email));
    assert.ok(!clean.stdout.includes(DUMMY_AUTH_PASSWORD_HASH));
    assert.equal(fs.readFileSync(filename, 'utf8'), JSON.stringify(input));
    input.destination = [{ uid: 'someone-else', email: 'SYNTHETIC@example.invalid' }];
    fs.writeFileSync(filename, JSON.stringify(input));
    const collision = run([filename]);
    assert.equal(collision.status, 2);
    assert.deepEqual(JSON.parse(collision.stdout).records[0].holds, ['destination_collision']);
    fs.writeFileSync(filename, 'invalid-json-sensitive-marker');
    const invalid = run([filename]);
    assert.equal(invalid.status, 1);
    assert.ok(!invalid.stderr.includes('sensitive-marker'));
    assert.ok(!invalid.stderr.includes(filename));
  } finally {
    fs.unlinkSync(filename);
  }
});

test('offline CLI refuses apply and exposes a usable help contract', () => {
  const apply = run(['--apply']);
  assert.equal(apply.status, 1);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Offline dry run only/);
});
