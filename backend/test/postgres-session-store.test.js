/** @file Regression coverage for postgres session store: PostgresSessionStore.initialize verifies the session schema exists. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PostgresSessionStore } = require('../src/utils/postgresSessionStore');

/**
 * Build a minimal pg Pool stub with injectable query behavior.
 */
const createPoolStub = (responder) => {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return responder({ text, params });
    }
  };
};

/**
 * Wrap store.get in a Promise so tests can await callback results.
 */
const callStoreGet = (store, sid) =>
  new Promise((resolve) => {
    store.get(sid, (err, session) => resolve({ err, session }));
  });

/**
 * Wrap store.set in a Promise so tests can await callback completion.
 */
const callStoreSet = (store, sid, session) =>
  new Promise((resolve) => {
    store.set(sid, session, (err) => resolve(err));
  });

/**
 * Wrap store.touch in a Promise so tests can await callback completion.
 */
const callStoreTouch = (store, sid, session) =>
  new Promise((resolve) => {
    store.touch(sid, session, (err) => resolve(err));
  });

/**
 * Wrap store.destroy in a Promise so tests can await callback completion.
 */
const callStoreDestroy = (store, sid) =>
  new Promise((resolve) => {
    store.destroy(sid, (err) => resolve(err));
  });

test('PostgresSessionStore.initialize verifies the session schema exists', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  await store.initialize();

  assert.equal(pool.calls.length, 1);
  assert.equal(
    pool.calls[0].text,
    'SELECT public_id, created_at, last_used_at FROM session_store LIMIT 1'
  );
});

test('PostgresSessionStore.initialize throws a helpful error for missing tables', async () => {
  const pool = createPoolStub(() => {
    const error = new Error('relation does not exist');
    error.code = '42P01';
    throw error;
  });
  const store = new PostgresSessionStore(pool);

  await assert.rejects(
    () => store.initialize(),
    /Session store table is missing\. Apply database migrations/
  );
});

test('PostgresSessionStore.initialize surfaces unexpected database errors', async () => {
  const pool = createPoolStub(() => {
    const error = new Error('boom');
    error.code = '99999';
    throw error;
  });
  const store = new PostgresSessionStore(pool);

  await assert.rejects(() => store.initialize(), /boom/);
});

test('PostgresSessionStore.get returns null when no session exists', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  const result = await callStoreGet(store, 'missing');

  assert.equal(result.err, null);
  assert.equal(result.session, null);
});

test('PostgresSessionStore.get prunes expired sessions', async () => {
  const pool = createPoolStub(({ text }) => {
    if (text.startsWith('SELECT')) {
      return { rows: [{ sess: '{"userId":1}', expire: new Date(0).toISOString() }] };
    }
    return { rows: [] };
  });
  const store = new PostgresSessionStore(pool);

  const result = await callStoreGet(store, 'expired');

  assert.equal(result.err, null);
  assert.equal(result.session, null);
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[1].text, /DELETE FROM session_store/);
  assert.equal(pool.calls[1].params[0], 'expired');
});

test('PostgresSessionStore.get returns parsed JSON sessions', async () => {
  const pool = createPoolStub(() => ({
    rows: [
      {
        sess: '{"userId":123,"roles":["user"]}',
        expire: '2999-01-01T00:00:00.000Z'
      }
    ]
  }));
  const store = new PostgresSessionStore(pool);

  const result = await callStoreGet(store, 'active');

  assert.equal(result.err, null);
  assert.deepEqual(result.session, { userId: 123, roles: ['user'] });
});

test('PostgresSessionStore.get forwards query errors to the callback', async () => {
  const pool = createPoolStub(() => {
    throw new Error('select failed');
  });
  const store = new PostgresSessionStore(pool);

  const result = await callStoreGet(store, 'oops');

  assert.ok(result.err);
  assert.match(result.err.message, /select failed/);
});

test('PostgresSessionStore.set stores sessions using the cookie expiration when provided', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  const expires = new Date('2025-01-03T12:00:00.000Z');
  const session = { cookie: { expires }, userId: 42 };
  const error = await callStoreSet(store, 'sid-1', session);

  assert.equal(error, undefined);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /INSERT INTO session_store/);
  assert.equal(pool.calls[0].params[0], 'sid-1');
  assert.equal(pool.calls[0].params[1], JSON.stringify(session));
  assert.equal(pool.calls[0].params[2].toISOString(), expires.toISOString());
});

test('PostgresSessionStore.set falls back to the store TTL when no cookie timing is set', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const ttlMs = 60000;
  const store = new PostgresSessionStore(pool, ttlMs);

  const session = { cookie: {}, userId: 7 };
  const before = Date.now();
  await callStoreSet(store, 'sid-ttl', session);
  const after = Date.now();

  const expire = pool.calls[0].params[2];
  assert.ok(expire instanceof Date);
  assert.ok(expire.getTime() >= before + ttlMs);
  assert.ok(expire.getTime() <= after + ttlMs);
});

test('PostgresSessionStore links authenticated Passport sessions to their user', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  await callStoreSet(store, 'sid-user', { cookie: {}, passport: { user: 42 } });

  assert.match(pool.calls[0].text, /user_id/);
  assert.equal(pool.calls[0].params[3], 42);
});

test('PostgresSessionStore leaves unauthenticated session ownership null', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  await callStoreSet(store, 'sid-anonymous', { cookie: {} });

  assert.equal(pool.calls[0].params[3], null);
});

test('PostgresSessionStore.touch updates expiry using cookie maxAge', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  const session = { cookie: { maxAge: 120000 }, userId: 99 };
  const before = Date.now();
  const error = await callStoreTouch(store, 'sid-touch', session);
  const after = Date.now();

  assert.equal(error, undefined);
  assert.match(pool.calls[0].text, /UPDATE session_store/);
  assert.equal(pool.calls[0].params[0], 'sid-touch');

  const expire = pool.calls[0].params[1];
  assert.ok(expire instanceof Date);
  assert.ok(expire.getTime() >= before + session.cookie.maxAge);
  assert.ok(expire.getTime() <= after + session.cookie.maxAge);
  assert.equal(pool.calls[0].params[3], null);
});

test('PostgresSessionStore.touch refreshes Passport session ownership', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  await callStoreTouch(store, 'sid-touch-user', { cookie: {}, passport: { user: '17' } });

  assert.equal(pool.calls[0].params[3], 17);
});

test('PostgresSessionStore.destroy deletes stored sessions', async () => {
  const pool = createPoolStub(() => ({ rows: [] }));
  const store = new PostgresSessionStore(pool);

  const error = await callStoreDestroy(store, 'sid-remove');

  assert.equal(error, undefined);
  assert.match(pool.calls[0].text, /DELETE FROM session_store/);
  assert.equal(pool.calls[0].params[0], 'sid-remove');
});
const { markVerifiedBrowserLogin, serializeBrowserLoginUser, BrowserLoginRejected } = require('../src/utils/browserLoginCredentials');

function verifiedSession(version = 2) {
  const principal = { id: 42 };
  const sess = { cookie: {}, passport: { user: 42 } };
  markVerifiedBrowserLogin(principal, 42, version);
  serializeBrowserLoginUser({ session: sess }, principal, (err, id) => { assert.equal(err, null); assert.equal(id, 42); });
  assert.deepEqual(Object.keys(sess).sort(), ['cookie', 'passport']);
  return sess;
}

test('verified browser save rejects stale identity and cannot retry as an unguarded upsert', async () => {
  const queries = [];
  const client = { query: async text => { queries.push(text); return { rowCount: text.startsWith('UPDATE "User"') ? 0 : 1 }; }, release() {} };
  const pool = { connect: async () => client, query: async () => { throw Error('unguarded write'); } };
  const store = new PostgresSessionStore(pool);
  const sess = verifiedSession();
  assert.ok(await callStoreSet(store, 'guarded', sess) instanceof BrowserLoginRejected);
  const count = queries.length;
  assert.ok(await callStoreSet(store, 'guarded', sess) instanceof BrowserLoginRejected);
  assert.equal(queries.length, count);
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.some(q => q.startsWith('INSERT')), false);
});

test('verified browser save commits once and later saves only update the existing session', async () => {
  const queries = [];
  const client = { query: async text => { queries.push(text); return { rowCount: 1 }; }, release() {} };
  let exists = true;
  const pool = { connect: async () => client, query: async text => { queries.push(text); return { rowCount: exists ? 1 : 0 }; } };
  const store = new PostgresSessionStore(pool);
  const sess = verifiedSession();
  assert.equal(await callStoreSet(store, 'guarded', sess), undefined);
  assert.ok(queries.includes('COMMIT'));
  assert.equal(await callStoreSet(store, 'guarded', sess), undefined);
  assert.match(queries.at(-1), /^UPDATE session_store/);
  exists = false;
  assert.ok(await callStoreSet(store, 'guarded', sess) instanceof BrowserLoginRejected);
  assert.equal(queries.filter(q => q.startsWith('INSERT')).length, 1);
});
