/** @file Regression coverage for mobile session issuance postgres: PostgreSQL orders verified native issuance against credential changes and deletion. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const databaseUrl = process.env.CALIBRATE_AUTH_TEST_DATABASE_URL;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('PostgreSQL orders verified native issuance against credential changes and deletion', { skip: !databaseUrl, timeout: 90000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'disposable local PostgreSQL only');
  assert.match(url.pathname, /^\/(calibrate_ci|calibrate_test[^/]*)$/);
  const schema = `auth_issuance_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  let database;
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: process.env, stdio: 'pipe', timeout: 45000 });
    database = require('../src/config/database');
    const prisma = database.default;
    const { issueVerifiedMobileAuthPayload } = require('../src/services/mobileAuth');
    const originalTransaction = prisma.$transaction.bind(prisma);
    const device = { deviceId: 'synthetic-phone', devicePlatform: 'ANDROID_PHONE', deviceName: null };
    const createUser = () => prisma.user.create({ data: { email: `${randomUUID()}@example.invalid`, password_hash: 'synthetic-old', email_verified_at: null } });
    const issue = user => issueVerifiedMobileAuthPayload({ userId: user.id, credentialSecurityVersion: user.credential_security_version, device });
    const waitForLock = async pid => {
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('expected competing transaction to wait on a PostgreSQL lock');
    };
    // Exercise the same User update + session revocation ordering as local password writers.
    const mutation = async (tx, user, kind) => {
      if (kind === 'delete') return tx.user.delete({ where: { id: user.id } });
      await tx.user.update({ where: { id: user.id }, data: { password_hash: 'synthetic-new' } });
      await tx.mobileAuthSession.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } });
    };
    for (const kind of ['password', 'delete']) {
      await t.test(`${kind} commits first: stale verified login creates no session`, async () => {
        const user = await createUser();
        const changed = deferred(), release = deferred(), issuerPid = deferred();
        const writer = originalTransaction(async tx => { await mutation(tx, user, kind); changed.resolve(); await release.promise; }, { timeout: 15000 });
        await changed.promise;
        prisma.$transaction = action => originalTransaction(async tx => {
          issuerPid.resolve((await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
          return action(tx);
        }, { timeout: 15000 });
        const pending = issue(user);
        try { await waitForLock(await issuerPid.promise); } finally { release.resolve(); }
        await writer;
        assert.equal(await pending, null);
        assert.equal(await prisma.mobileAuthSession.count({ where: { user_id: user.id } }), 0);
        prisma.$transaction = originalTransaction;
      });
      await t.test(`issuance commits first: later ${kind} revokes or cascades its session`, async () => {
        const user = await createUser();
        const locked = deferred(), release = deferred(), writerPid = deferred();
        prisma.$transaction = action => originalTransaction(async tx => {
          const wrapped = new Proxy(tx, { get(target, key) {
            if (key !== 'user') return target[key];
            return new Proxy(target.user, { get(model, operation) {
              if (operation !== 'updateMany') return model[operation];
              return async args => { const result = await model.updateMany(args); locked.resolve(); await release.promise; return result; };
            } });
          } });
          return action(wrapped);
        }, { timeout: 15000 });
        const pending = issue(user);
        await locked.promise;
        const writer = originalTransaction(async tx => {
          writerPid.resolve((await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
          await mutation(tx, user, kind);
        }, { timeout: 15000 });
        try { await waitForLock(await writerPid.promise); } finally { release.resolve(); }
        const payload = await pending;
        assert.equal(payload.user.id, user.id);
        assert.equal(payload.user.account_access.state, 'email_verification_required');
        await writer;
        const sessions = await prisma.mobileAuthSession.findMany({ where: { user_id: user.id } });
        if (kind === 'delete') assert.equal(sessions.length, 0);
        else { assert.equal(sessions.length, 1); assert.ok(sessions[0].revoked_at); }
        prisma.$transaction = originalTransaction;
      });
    }
    await t.test('commit failure rolls back the session without returning tokens', async () => {
      const user = await createUser();
      prisma.$transaction = action => originalTransaction(async tx => { await action(tx); throw Error('synthetic rollback'); });
      await assert.rejects(issue(user), /synthetic rollback/);
      assert.equal(await prisma.mobileAuthSession.count({ where: { user_id: user.id } }), 0);
      prisma.$transaction = originalTransaction;
    });
  } finally {
    if (database) await database.disconnectDatabase();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
