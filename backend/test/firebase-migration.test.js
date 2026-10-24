/** @file Regression coverage for firebase migration: inventory accounts for every row, holds both sides of collisions and exposes no credentials. */

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createHash } = require('node:crypto');
const {
  planFirebaseMigration, migrationUid, initialMigrationCheckpoint, runFirebaseMigration
} = require('../scripts/lib/firebaseMigration');

const scope = { installationId: 'synthetic-install', sourceId: 'synthetic-db', projectId: 'synthetic-project' };
const password = 'synthetic-password';
const passwordHash = bcrypt.hashSync(password, 10);
const preservationDigest = createHash('sha256').update('synthetic ownership, verification, onboarding and legal history').digest('hex');
const account = (id = 1, overrides = {}) => ({ id, email: `synthetic-${id}@example.invalid`, passwordHash,
  emailVerified: false, preservationDigest, ...overrides });

function harness(accounts = [account()], overrides = {}) {
  const plan = planFirebaseMigration(scope, accounts, []);
  const saved = [];
  const imports = [];
  const options = {
    checkpoint: initialMigrationCheckpoint(plan),
    readSource: async () => accounts,
    saveCheckpoint: async (value) => saved.push(structuredClone(value)),
    destination: {
      projectId: scope.projectId,
      findCollisions: async () => false,
      importUsers: async (rows, config) => {
        imports.push({ rows, config });
        return { successCount: rows.length, failureCount: 0, errors: [] };
      }
    },
    ...overrides
  };
  return { plan, options, saved, imports };
}

test('inventory accounts for every row, holds both sides of collisions and exposes no credentials', () => {
  const accounts = [account(), account(2, { email: ' SYNTHETIC-1@EXAMPLE.INVALID ' }),
    account(3, { passwordHash: 'unknown-secret-hash' }), account(4, { providerLinked: true }),
    account(5, { disabled: true }), account(6, { email: 'bad' }), account(0), account(7), account(7)];
  const plan = planFirebaseMigration(scope, accounts, [{ uid: 'other', email: accounts[7].email }]);
  assert.equal(plan.summary.accounts, 9);
  assert.equal(plan.summary.held, 9);
  assert.equal(plan.summary.eligible, 0);
  assert.deepEqual(plan.records[0].holds, ['email_collision']);
  assert.deepEqual(plan.records[1].holds, ['email_collision']);
  assert.ok(plan.records[7].holds.includes('duplicate_id'));
  assert.ok(plan.records[7].holds.includes('destination_collision'));
  const output = JSON.stringify(plan);
  assert.ok(!output.includes(passwordHash));
  assert.ok(!output.includes('example.invalid'));
  assert.ok(!output.includes('unknown-secret-hash'));
});

test('mapping is deterministic and source/installation/project scoped', () => {
  const uid = migrationUid(scope, 1);
  assert.equal(uid, migrationUid(scope, 1));
  assert.notEqual(uid, migrationUid(scope, 2));
  for (const field of ['installationId', 'sourceId', 'projectId']) {
    assert.notEqual(uid, migrationUid({ ...scope, [field]: 'different-scope' }, 1));
  }
  assert.ok(uid.length <= 128);
  assert.throws(() => migrationUid(scope, -1));
  assert.throws(() => migrationUid({ ...scope, sourceId: 'postgres://user:secret@server' }, 1));
});

test('default dry run reads source only and never calls destination or persists progress', async () => {
  const h = harness();
  h.options.destination.findCollisions = async () => { throw new Error('must not call'); };
  const result = await runFirebaseMigration(h.plan, h.options);
  assert.deepEqual(result.states, ['pending']);
  assert.equal(h.saved.length, 0);
  assert.equal(h.imports.length, 0);
});

test('bounded import preserves encoded BCRYPT and verification, and resume never reimports successful records', async () => {
  const h = harness([account(), account(2, { emailVerified: true }), account(3)]);
  const result = await runFirebaseMigration(h.plan, { ...h.options, apply: true, batchSize: 2 });
  assert.deepEqual(h.imports.map((call) => call.rows.length), [2, 1]);
  assert.deepEqual(h.saved.map((value) => value.states), [
    ['in_flight', 'in_flight', 'pending'], ['imported', 'imported', 'pending'],
    ['imported', 'imported', 'in_flight'], ['imported', 'imported', 'imported']
  ]);
  assert.deepEqual(h.imports[0].config, { hash: { algorithm: 'BCRYPT' } });
  assert.equal(h.imports[0].rows[0].passwordHash.toString('utf8'), passwordHash);
  assert.equal(h.imports[0].rows[1].emailVerified, true);
  assert.deepEqual(Object.keys(h.imports[0].rows[0]).sort(), ['email', 'emailVerified', 'passwordHash', 'uid']);
  // Simulate a destination password change. A successful record is never submitted again.
  h.options.destination.importUsers = async () => { throw new Error('would overwrite new password'); };
  await runFirebaseMigration(h.plan, { ...h.options, checkpoint: result, apply: true });
});

test('partial failure records exact failed indexes and stops all automatic retries', async () => {
  const h = harness([account(), account(2), account(3)]);
  h.options.destination.importUsers = async () => ({ successCount: 1, failureCount: 1, errors: [{ index: 1 }] });
  await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true, batchSize: 2 }), /Partial import/);
  assert.deepEqual(h.saved.at(-1).states, ['imported', 'rejected', 'pending']);
  await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, checkpoint: h.saved.at(-1), apply: true }), /reviewed recovery/);
});

test('timeout after possible success leaves durable ambiguity and suppresses provider details', async () => {
  const h = harness();
  h.options.destination.importUsers = async () => { throw new Error(`provider leaked ${passwordHash}`); };
  await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true }), { message: 'Ambiguous import requires reconciliation' });
  assert.deepEqual(h.saved.at(-1).states, ['in_flight']);
  await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, checkpoint: h.saved.at(-1), apply: true }), /reconciliation/);
});

test('failed intent persistence prevents any network mutation', async () => {
  const h = harness();
  h.options.saveCheckpoint = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true }), /checkpoint persistence failed/);
  assert.equal(h.imports.length, 0);
});

test('wrong project, source drift, destination conflicts and malformed checkpoints fail closed', async () => {
  for (const change of [
    (h) => { h.options.destination.projectId = 'wrong-project'; },
    (h) => { h.options.readSource = async () => [account(1, { passwordHash: bcrypt.hashSync('changed-password', 4) })]; },
    (h) => { h.options.readSource = async () => [account(1, { preservationDigest: 'a'.repeat(64) })]; },
    (h) => { h.options.destination.findCollisions = async () => true; },
    (h) => { h.options.checkpoint.planDigest = 'wrong'; },
    (h) => { h.options.checkpoint.states = ['surprise']; }
  ]) {
    const h = harness();
    change(h);
    await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true }));
    assert.equal(h.imports.length, 0);
  }
});

test('malformed provider partial-result indexes remain ambiguous', async () => {
  const h = harness();
  h.options.destination.importUsers = async () => ({ successCount: 0, failureCount: 1, errors: [{ index: 3 }] });
  await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true }), /reconciliation/);
  assert.deepEqual(h.saved.at(-1).states, ['in_flight']);
});

test('unavailable source or destination inspection cannot leak callback details or permit import', async () => {
  for (const target of ['readSource', 'findCollisions']) {
    const h = harness();
    const fail = async () => { throw new Error('secret-source-connection'); };
    if (target === 'readSource') h.options.readSource = fail;
    else h.options.destination.findCollisions = fail;
    await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true }), (error) => {
      assert.ok(!error.message.includes('secret'));
      return true;
    });
    assert.equal(h.imports.length, 0);
  }
  for (const result of [null, {}, { errors: [null] }]) {
    const h = harness();
    h.options.destination.importUsers = async () => result;
    await assert.rejects(runFirebaseMigration(h.plan, { ...h.options, apply: true }), /reconciliation/);
    assert.deepEqual(h.saved.at(-1).states, ['in_flight']);
  }
});

test('synthetic bcrypt variants, Unicode and 72-byte boundaries retain password bytes locally', async () => {
  for (const value of ['correct-horse', 'caf\u00e9-\u03bb-password', 'a'.repeat(72), '\ud83d\ude00'.repeat(18)]) {
    const hash = await bcrypt.hash(value, 10);
    for (const prefix of ['$2a$', '$2b$', '$2y$']) {
      const variant = prefix + hash.slice(4);
      const plan = planFirebaseMigration(scope, [account(1, { passwordHash: variant })], []);
      assert.equal(plan.summary.held, 0);
      assert.equal(await bcrypt.compare(value, Buffer.from(variant).toString('utf8')), true);
      assert.equal(await bcrypt.compare('wrong-password', variant), false);
    }
  }
  // This proves local byte preservation only, never real Firebase import compatibility.
});
