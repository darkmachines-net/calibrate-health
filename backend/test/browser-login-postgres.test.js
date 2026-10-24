/** @file Regression coverage for browser login postgres: real Passport browser login persists atomically and cannot resurrect a rejected session. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const databaseUrl = process.env.CALIBRATE_AUTH_TEST_DATABASE_URL;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('real Passport browser login persists atomically and cannot resurrect a rejected session', { skip: !databaseUrl, timeout: 90000 }, async t => {
  const url = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/(calibrate_ci|calibrate_test[^/]*)$/);
  const schema = `browser_login_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  let database, storePool, server;
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: process.env, stdio: 'pipe', timeout: 45000 });
    database = require('../src/config/database');
    const prisma = database.default;
    const originalTransaction = prisma.$transaction.bind(prisma);
    const express = require('express');
    const session = require('express-session');
    const passport = require('passport');
    const { Strategy } = require('passport-local');
    const bcrypt = require('bcryptjs');
    const { USER_CLIENT_SELECT } = require('../src/utils/userSerialization');
    const { verifyLocalPassword } = require('../src/services/credentialVerification');
    const { markVerifiedBrowserLogin, serializeBrowserLoginUser } = require('../src/utils/browserLoginCredentials');
    const { PostgresSessionStore } = require('../src/utils/postgresSessionStore');
    const { issueAccountActionToken, resetPasswordWithToken } = require('../src/services/accountTokens');
    storePool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    let afterVerified = async () => {}, afterLock = async () => {}, beforeGuard = () => {}, failCommit = false;
    const wrappedPool = {
      query: (...args) => storePool.query(...args),
      connect: async () => {
        const client = await storePool.connect();
        return { release: () => client.release(), query: async (sql, args) => {
          if (sql.startsWith('UPDATE "User"')) beforeGuard(client.processID);
          if (sql === 'COMMIT' && failCommit) throw Error('synthetic commit failure');
          const result = await client.query(sql, args);
          if (sql.startsWith('UPDATE "User"') && result.rowCount === 1) await afterLock();
          return result;
        } };
      }
    };
    const store = new PostgresSessionStore(wrappedPool);
    let saved;
    const originalSet = store.set.bind(store);
    store.set = (sid, sess, callback) => { saved = { sid, sess }; return originalSet(sid, sess, callback); };
    const resave = () => new Promise(resolve => originalSet(saved.sid, saved.sess, resolve));
    passport.use(new Strategy({ usernameField: 'email' }, async (email, password, done) => {
      try {
        const user = await prisma.user.findFirst({ where: { email }, select: { ...USER_CLIENT_SELECT, password_hash: true, credential_security_version: true } });
        if (!await verifyLocalPassword(password, user?.password_hash) || !user) return done(null, false);
        const { password_hash, credential_security_version, ...principal } = user;
        markVerifiedBrowserLogin(principal, user.id, credential_security_version);
        await afterVerified();
        done(null, principal);
      } catch (error) { done(error); }
    }));
    passport.serializeUser(serializeBrowserLoginUser);
    passport.deserializeUser(async (id, done) => {
      try { done(null, await prisma.user.findUnique({ where: { id }, select: USER_CLIENT_SELECT })); }
      catch (error) { done(error); }
    });
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'synthetic-browser-login-test-secret', store, resave: false, saveUninitialized: false, name: 'cal.sid', cookie: { httpOnly: true, sameSite: 'lax', maxAge: 60000 } }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use('/auth', require('../src/routes/auth').default);
    app.get('/probe', (req, res) => res.json({ authenticated: req.isAuthenticated() }));
    app.use((error, _req, res, _next) => res.status(500).json({ message: 'Server error' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const password = 'Synthetic-password-123';
    const hash = await bcrypt.hash(password, 10);
    const createUser = () => prisma.user.create({ data: { email: `${randomUUID()}@example.invalid`, password_hash: hash, email_verified_at: null } });
    const login = user => fetch(origin + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
    const count = user => prisma.sessionStore.count({ where: { user_id: user.id } });
    const waitForLock = async pid => {
      for (let i = 0; i < 150; i++) {
        const { rows } = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('competing database operation did not wait on a lock');
    };
    const resetHooks = () => {
      afterVerified = async () => {}; afterLock = async () => {}; beforeGuard = () => {}; failCommit = false;
      prisma.$transaction = originalTransaction;
    };
    for (const kind of ['reset', 'delete']) {
      await t.test(`${kind} first rejects the already-verified browser login and later saves`, async () => {
        resetHooks();
        const user = await createUser();
        const token = kind === 'reset' ? await issueAccountActionToken(user.id, 'PASSWORD_RESET') : null;
        const verified = deferred(), releaseVerification = deferred(), changed = deferred(), releaseMutation = deferred(), browserPid = deferred();
        afterVerified = async () => { verified.resolve(); await releaseVerification.promise; };
        beforeGuard = pid => browserPid.resolve(pid);
        const pending = login(user);
        await verified.promise;
        let mutation;
        if (kind === 'reset') {
          prisma.$transaction = action => originalTransaction(tx => action(new Proxy(tx, { get(target, key) {
            if (key !== 'user') return target[key];
            return new Proxy(target.user, { get(model, operation) {
              if (operation !== 'update') return model[operation];
              return async args => { const result = await model.update(args); changed.resolve(); await releaseMutation.promise; return result; };
            } });
          } })), { timeout: 15000 });
          mutation = resetPasswordWithToken(token, 'Replacement-password-123');
        } else {
          mutation = originalTransaction(async tx => { await tx.user.delete({ where: { id: user.id } }); changed.resolve(); await releaseMutation.promise; }, { timeout: 15000 });
        }
        await changed.promise;
        releaseVerification.resolve();
        try { await waitForLock(await browserPid.promise); } finally { releaseMutation.resolve(); }
        await mutation;
        const response = await pending;
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { message: 'Invalid email or password' });
        assert.ok(!response.headers.get('set-cookie') || response.headers.get('set-cookie').includes('Expires=Thu, 01 Jan 1970'));
        assert.equal(await count(user), 0);
        assert.ok(await resave());
        assert.equal(await count(user), 0);
      });
      await t.test(`browser issuance first is removed by later ${kind} and cannot be saved again`, async () => {
        resetHooks();
        const user = await createUser();
        const token = kind === 'reset' ? await issueAccountActionToken(user.id, 'PASSWORD_RESET') : null;
        const locked = deferred(), releaseIssuance = deferred(), writerPid = deferred();
        afterLock = async () => { locked.resolve(); await releaseIssuance.promise; };
        const pending = login(user);
        await locked.promise;
        prisma.$transaction = action => originalTransaction(async tx => {
          writerPid.resolve((await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
          return action(tx);
        }, { timeout: 15000 });
        const mutation = kind === 'reset' ? resetPasswordWithToken(token, 'Replacement-password-123') : prisma.$transaction(tx => tx.user.delete({ where: { id: user.id } }));
        try { await waitForLock(await writerPid.promise); } finally { releaseIssuance.resolve(); }
        const response = await pending;
        assert.equal(response.status, 200);
        assert.equal((await response.json()).user.id, user.id);
        await mutation;
        assert.equal(await count(user), 0);
        assert.ok(await resave());
        assert.equal(await count(user), 0);
        const cookie = response.headers.get('set-cookie').split(';')[0];
        assert.equal((await (await fetch(origin + '/probe', { headers: { cookie } })).json()).authenticated, false);
      });
    }
    await t.test('rollback after insertion returns no usable cookie and blocks a later save', async () => {
      resetHooks(); failCommit = true;
      const user = await createUser();
      const response = await login(user);
      assert.equal(response.status, 500);
      assert.equal(await count(user), 0);
      failCommit = false;
      assert.ok(await resave());
      assert.equal(await count(user), 0);
    });
    await t.test('restricted login preserves integer identity and current-session password-change behavior', async () => {
      resetHooks();
      const user = await createUser();
      const response = await login(user);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.user.account_access.state, 'email_verification_required');
      assert.equal('credential_security_version' in payload.user, false);
      const row = await prisma.sessionStore.findFirst({ where: { user_id: user.id } });
      assert.equal(row.sess.passport.user, user.id);
      assert.deepEqual(Object.keys(row.sess).sort(), ['cookie', 'passport']);
      await prisma.user.update({ where: { id: user.id }, data: { password_hash: 'synthetic-current-session-change' } });
      assert.equal(await resave(), undefined);
      assert.equal(await count(user), 1);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      assert.equal((await (await fetch(origin + '/probe', { headers: { cookie } })).json()).authenticated, true);
    });
    await t.test('local registration still creates an unguarded integer-principal session', async () => {
      resetHooks();
      const response = await fetch(origin + '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${randomUUID()}@example.invalid`, password }) });
      assert.equal(response.status, 200);
      const { user } = await response.json();
      const row = await prisma.sessionStore.findFirst({ where: { user_id: user.id } });
      assert.equal(row.sess.passport.user, user.id);
      assert.deepEqual(Object.keys(row.sess).sort(), ['cookie', 'passport']);
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (storePool) await storePool.end();
    if (database) await database.disconnectDatabase();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
