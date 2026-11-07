/** @file Rehearse frozen SQL import, preservation and recovery after provider success/SQL failure on an owned empty database and Auth Emulator. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

test('frozen import preserves SQL and resumes confirmed provider imports without overwriting passwords', { skip: process.env.CALIBRATE_FIREBASE_TEST_OWNED_DB !== 'true', timeout: 90000 }, async () => {
  const url = new URL(process.env.CALIBRATE_AUTH_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/calibrate_test_firebase');
  assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST, /^127\.0\.0\.1:\d+$/);
  assert.equal(process.env.FIREBASE_PROJECT_ID, 'demo-calibrate');
  const admin = new Pool({ connectionString: url.toString() });
  assert.equal((await admin.query("SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'")).rows[0].count, 0, 'Only a fresh owned public schema is allowed.');
  process.env.DATABASE_URL = url.toString();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-import-test-'));
  let database, auth, app;
  const owned = [];
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: process.env, stdio: 'pipe', timeout: 45000 });
    database = require('../src/config/database');
    const prisma = database.default;
    const { initializeApp } = require('firebase-admin/app');
    app = initializeApp({ projectId: 'demo-calibrate' }, 'migration-rehearsal');
    auth = require('firebase-admin/auth').getAuth(app);
    const { hash } = require('bcryptjs');
    const { migrateFrozenDatabase } = require('../scripts/firebase-migration-apply');
    const scope = { installationId: `test-${randomUUID()}`, sourceId: 'synthetic-source', projectId: 'demo-calibrate' };
    const planPath = path.join(directory, 'plan.json'), journalPath = path.join(directory, 'journal.jsonl');
    const users = [];
    for (const verified of [true, false]) {
      const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.invalid`, password_hash: await hash('Synthetic-import-password', 10), email_verified_at: verified ? new Date('2026-01-01T00:00:00Z') : null, timezone: 'America/Los_Angeles' } });
      users.push(user);
      await prisma.foodLog.create({ data: { user_id: user.id, name: 'Synthetic food', calories: 350, meal_period: 'LUNCH', local_date: new Date('2026-01-02T00:00:00Z') } });
      await prisma.sessionStore.create({ data: { sid: randomUUID(), user_id: user.id, sess: {}, expire: new Date(Date.now() + 60000) } });
    }
    const beforeFood = await prisma.foodLog.findMany({ orderBy: { id: 'asc' } });
    const dryRun = await migrateFrozenDatabase(prisma, auth, scope, { planPath, journalPath });
    assert.equal(dryRun.eligible, 2);
    assert.equal(await prisma.firebaseIdentity.count(), 0);
    assert.equal(fs.existsSync(journalPath), false);
    owned.push(...JSON.parse(fs.readFileSync(planPath)).records.map(row => row.uid));
    assert.equal((await auth.getUsers(owned.map(uid => ({ uid })))).users.length, 0);
    await prisma.user.update({ where: { id: users[0].id }, data: { timezone: 'UTC' } });
    await assert.rejects(migrateFrozenDatabase(prisma, auth, scope, { planPath, journalPath, apply: true }), /source changed/);
    await prisma.user.update({ where: { id: users[0].id }, data: { timezone: users[0].timezone } });
    const failing = { $transaction: (work, options) => prisma.$transaction(tx => work(new Proxy(tx, { get(target, key) {
      if (key !== 'firebaseIdentity') return target[key];
      return { create: async () => { throw new Error('Synthetic SQL mapping failure'); } };
    } })), options) };
    await assert.rejects(migrateFrozenDatabase(failing, auth, scope, { planPath, journalPath, apply: true }), /Synthetic SQL mapping failure/);
    assert.equal(await prisma.firebaseIdentity.count(), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(journalPath, 'utf8').trim().split('\n').at(-1)).states, ['imported', 'imported']);
    const resume = new Proxy(auth, { get(target, key) {
      if (key === 'importUsers') return async () => { assert.fail('Confirmed imports must never be upserted again'); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
    const result = await migrateFrozenDatabase(prisma, resume, scope, { planPath, journalPath, apply: true });
    assert.equal(result.preserved, true);
    assert.equal(await prisma.firebaseIdentity.count(), 2);
    assert.equal(await prisma.sessionStore.count(), 0);
    assert.equal(await prisma.legalAcceptance.count(), 0);
    assert.deepEqual(await prisma.foodLog.findMany({ orderBy: { id: 'asc' } }), beforeFood);
    for (const user of users) {
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert.deepEqual({ ...after, credential_security_version: user.credential_security_version }, user);
      assert.equal(after.credential_security_version, user.credential_security_version + 1);
    }
    await assert.rejects(migrateFrozenDatabase(prisma, resume, scope, { planPath, journalPath, apply: true }), /source changed/);
  } finally {
    if (auth) for (const uid of owned) await auth.deleteUser(uid).catch(() => {});
    if (app) await require('firebase-admin/app').deleteApp(app);
    if (database) await database.disconnectDatabase();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await admin.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
