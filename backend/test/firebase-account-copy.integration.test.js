/** @file Rehearse account-only snapshots with an active source, atomic target writes and Firebase receipt recovery on owned emulators. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

test('account copy preserves snapshot credentials/consent without touching an active source or importing history', { skip: process.env.CALIBRATE_FIREBASE_TEST_OWNED_DB !== 'true', timeout: 90000 }, async () => {
  const url = new URL(process.env.CALIBRATE_AUTH_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/calibrate_test_firebase');
  assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST, /^127\.0\.0\.1:\d+$/);
  assert.equal(process.env.FIREBASE_PROJECT_ID, 'demo-calibrate');
  const admin = new Pool({ connectionString: url.toString() });
  assert.equal((await admin.query("SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'")).rows[0].count, 0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-account-copy-test-'));
  process.env.DATABASE_URL = url.toString();
  let database, app, auth;
  const owned = [];
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: process.env, stdio: 'pipe', timeout: 45000 });
    database = require('../src/config/database');
    const prisma = database.default;
    app = require('firebase-admin/app').initializeApp({ projectId: 'demo-calibrate' }, 'account-copy-rehearsal');
    auth = require('firebase-admin/auth').getAuth(app);
    const { ACCOUNT_SNAPSHOT_SQL, copyAccountSnapshot } = require('../scripts/firebase-account-copy');
    const scope = { installationId: `copy-${randomUUID()}`, sourceId: 'active-synthetic-source', projectId: 'demo-calibrate' };
    const options = { planPath: path.join(directory, 'plan.json'), journalPath: path.join(directory, 'journal.jsonl') };
    const hash = await require('bcryptjs').hash('Synthetic-copy-password', 10);
    // Separate source tables deliberately include tracking/session/onboarding state which must not transfer.
    await admin.query('CREATE SCHEMA copy_source; CREATE TABLE copy_source."User" (LIKE public."User" INCLUDING ALL); CREATE TABLE copy_source."LegalAcceptance" (LIKE public."LegalAcceptance" INCLUDING ALL)');
    await admin.query('INSERT INTO copy_source."User" (id, email, password_hash, created_at, email_verified_at, date_of_birth, timezone, onboarding_completed_at, credential_security_version) VALUES (41, $1, $2, $3, $3, $4, $5, $3, 9), (42, $6, $2, $3, NULL, NULL, $5, NULL, 3)', [`${randomUUID()}@example.invalid`, hash, '2026-01-01T02:03:04Z', '1990-04-05', 'America/Los_Angeles', `${randomUUID()}@example.invalid`]);
    await admin.query('INSERT INTO copy_source."LegalAcceptance" (id, user_id, terms_version, privacy_version, accepted_at) VALUES (51, 41, $1, $2, $3)', ['recorded-terms', 'recorded-privacy', '2026-01-01T02:03:04Z']);
    const source = await admin.connect();
    let snapshot;
    try {
      await source.query('SET search_path = copy_source');
      const results = await source.query(ACCOUNT_SNAPSHOT_SQL);
      snapshot = results.find(result => result.rows.length)?.rows[0].json_build_object;
    } finally { await source.query('SET search_path = public'); source.release(); }
    assert.equal(snapshot.users.length, 2);
    assert.equal(snapshot.users[0].onboarding_completed_at, undefined);
    await admin.query('UPDATE copy_source."User" SET language = $1 WHERE id = 41', ['fr']);
    const beforeSource = (await admin.query('SELECT to_jsonb(u) AS data FROM copy_source."User" u ORDER BY id')).rows;
    const dryRun = await copyAccountSnapshot(prisma, auth, scope, snapshot, options);
    assert.equal(dryRun.eligible, 2);
    assert.equal(await prisma.user.count(), 0, 'Dry run must roll target inserts back');
    assert.equal(await prisma.legalAcceptance.count(), 0);
    owned.push(...JSON.parse(fs.readFileSync(options.planPath)).records.map(row => row.uid));
    const failing = { $transaction: (work, settings) => prisma.$transaction(tx => work(new Proxy(tx, { get(target, key) {
      if (key !== 'firebaseIdentity') return target[key];
      return { count: () => target.firebaseIdentity.count(), create: async () => { throw new Error('Synthetic mapping failure'); } };
    } })), settings) };
    await assert.rejects(copyAccountSnapshot(failing, auth, scope, snapshot, { ...options, apply: true }), /Synthetic mapping failure/);
    assert.equal(await prisma.user.count(), 0, 'Failed mapping must roll all account inserts back');
    const confirmed = new Proxy(auth, { get(target, key) {
      if (key === 'importUsers') return async () => { assert.fail('Never overwrite a confirmed Firebase password on retry'); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
    const result = await copyAccountSnapshot(prisma, confirmed, scope, snapshot, { ...options, apply: true });
    assert.equal(result.accounts, 2);
    assert.equal(result.consentRecords, 1);
    assert.equal(result.onboardingRequired, 2);
    assert.equal(await prisma.firebaseIdentity.count(), 2);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: 41 } });
    assert.equal(user.password_hash, hash);
    assert.equal(user.language, 'en', 'Later source writes must not mutate the snapshot');
    assert.equal(user.timezone, 'America/Los_Angeles');
    assert.equal(user.date_of_birth.toISOString(), '1990-04-05T00:00:00.000Z');
    assert.equal(user.email_verified_at.toISOString(), '2026-01-01T02:03:04.000Z');
    assert.equal(user.onboarding_completed_at, null);
    assert.equal(user.credential_security_version, 1);
    assert.equal((await prisma.legalAcceptance.findUniqueOrThrow({ where: { id: 51 } })).terms_version, 'recorded-terms');
    for (const model of ['foodLog', 'bodyMetric', 'goal', 'sessionStore', 'mobileAuthSession', 'accountActionToken']) assert.equal(await prisma[model].count(), 0);
    await assert.rejects(copyAccountSnapshot(prisma, confirmed, scope, snapshot, { ...options, apply: true }), /empty destination/);
    assert.deepEqual((await admin.query('SELECT to_jsonb(u) AS data FROM copy_source."User" u ORDER BY id')).rows, beforeSource);
    const next = await prisma.user.create({ data: { email: `${randomUUID()}@example.invalid`, password_hash: hash } });
    assert.ok(next.id > 42, 'Explicit copied IDs must advance the destination sequence');
  } finally {
    if (auth) for (const uid of owned) await auth.deleteUser(uid).catch(() => {});
    if (app) await require('firebase-admin/app').deleteApp(app);
    if (database) await database.disconnectDatabase();
    await admin.query('DROP SCHEMA IF EXISTS copy_source CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await admin.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
