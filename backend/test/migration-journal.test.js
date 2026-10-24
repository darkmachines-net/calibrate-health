/** @file Regression coverage for migration journal: actual disk journal resumes successful imports without resubmitting the account. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { planFirebaseMigration, runFirebaseMigration } = require('../scripts/lib/firebaseMigration');
const { withMigrationJournal } = require('../scripts/lib/migrationJournal');
const { DUMMY_AUTH_PASSWORD_HASH } = require('../src/utils/authCredentials');

const scope = { installationId: 'synthetic-install', sourceId: 'synthetic-db', projectId: 'synthetic-project' };
const accounts = [{ id: 1, email: 'synthetic@example.invalid', passwordHash: DUMMY_AUTH_PASSWORD_HASH,
  emailVerified: false, preservationDigest: 'a'.repeat(64) }];
const plan = planFirebaseMigration(scope, accounts, []);

async function temporaryJournal(work) {
  const filename = path.join(os.tmpdir(), `calibrate-migration-journal-${randomUUID()}.jsonl`);
  try { await work(filename); } finally {
    for (const file of [filename, `${filename}.lock`]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

test('actual disk journal resumes successful imports without resubmitting the account', async () => {
  await temporaryJournal(async (filename) => {
    let calls = 0;
    const destination = { projectId: scope.projectId, findCollisions: async () => false,
      importUsers: async () => { calls += 1; return { successCount: 1, failureCount: 0, errors: [] }; } };
    const run = () => withMigrationJournal(filename, plan, (checkpoint, saveCheckpoint) =>
      runFirebaseMigration(plan, { checkpoint, saveCheckpoint, readSource: async () => accounts, destination, apply: true }));
    assert.deepEqual((await run()).states, ['imported']);
    assert.deepEqual((await run()).states, ['imported']);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(filename, 'utf8').trim().split('\n').length, 3);
    assert.ok(!fs.readFileSync(filename, 'utf8').includes(DUMMY_AUTH_PASSWORD_HASH));
  });
});

test('persisted import intent survives a failed process operation and requires reconciliation', async () => {
  await temporaryJournal(async (filename) => {
    await assert.rejects(withMigrationJournal(filename, plan, async (checkpoint, save) => {
      checkpoint.states[0] = 'in_flight';
      await save(checkpoint);
      throw new Error('simulated interrupted operation');
    }));
    await withMigrationJournal(filename, plan, async (checkpoint) => {
      assert.deepEqual(checkpoint.states, ['in_flight']);
      await assert.rejects(runFirebaseMigration(plan, { checkpoint, apply: true,
        saveCheckpoint: async () => {}, readSource: async () => accounts,
        destination: { projectId: scope.projectId } }), /reconciliation/);
    });
  });
});

test('journal excludes concurrent importers and refuses stale locks', async () => {
  await temporaryJournal(async (filename) => {
    await withMigrationJournal(filename, plan, async () => {
      await assert.rejects(withMigrationJournal(filename, plan, async () => {}), /locked or unavailable/);
    });
    fs.writeFileSync(`${filename}.lock`, 'synthetic abandoned lock', { flag: 'wx' });
    await assert.rejects(withMigrationJournal(filename, plan, async () => {}), /locked or unavailable/);
  });
});

test('abrupt process exit retains both import intent and lock instead of allowing an automatic retry', async () => {
  await temporaryJournal(async (filename) => {
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', `
      const { withMigrationJournal } = require('./scripts/lib/migrationJournal');
      const plan = JSON.parse(process.argv[2]);
      withMigrationJournal(process.argv[1], plan, async (checkpoint, save) => {
        checkpoint.states[0] = 'in_flight';
        await save(checkpoint);
        process.exit(23);
      }).catch(() => process.exit(24));
    `, filename, JSON.stringify(plan)], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.equal(child.status, 23, child.stderr);
    assert.equal(fs.existsSync(`${filename}.lock`), true);
    const latest = JSON.parse(fs.readFileSync(filename, 'utf8').trim().split('\n').at(-1));
    assert.deepEqual(latest.states, ['in_flight']);
    await assert.rejects(withMigrationJournal(filename, plan, async () => {}), /locked or unavailable/);
  });
});

test('journal refuses wrong manifests, torn records and attempts to rewind successful imports', async () => {
  await temporaryJournal(async (filename) => {
    await withMigrationJournal(filename, plan, async (checkpoint, save) => {
      checkpoint.states[0] = 'imported';
      await assert.rejects(save(checkpoint), /cannot rewind or skip/);
      checkpoint.states[0] = 'in_flight';
      await save(checkpoint);
      checkpoint.states[0] = 'imported';
      await save(checkpoint);
      checkpoint.states[0] = 'pending';
      await assert.rejects(save(checkpoint), /cannot rewind or skip/);
    });
    await assert.rejects(withMigrationJournal(filename, { ...plan, digest: 'wrong' }, async () => {}), /Invalid migration journal/);
    fs.appendFileSync(filename, '{torn');
    await assert.rejects(withMigrationJournal(filename, plan, async () => {}), /Incomplete migration journal/);
  });
});
