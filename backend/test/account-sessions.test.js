/** @file Regression coverage for account sessions: account session listing is owner-scoped, privacy-safe, and places current first. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { MobileDevicePlatform, Prisma } = require('@prisma/client');

const BROWSER_PUBLIC_ID = '11111111-1111-4111-8111-111111111111';
const MOBILE_PUBLIC_ID = '22222222-2222-4222-8222-222222222222';

function loadAccountSessionsService() {
  const dbPath = require.resolve('../src/config/database');
  const servicePath = require.resolve('../src/services/accountSessions');
  const previousDbModule = require.cache[dbPath];
  const moduleInstance = new Module(dbPath);
  moduleInstance.exports = {};
  moduleInstance.loaded = true;
  require.cache[dbPath] = moduleInstance;
  delete require.cache[servicePath];

  const service = require('../src/services/accountSessions');
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  return service;
}

test('account session listing is owner-scoped, privacy-safe, and places current first', async () => {
  const { listAccountSessionsForUser } = loadAccountSessionsService();
  const observedWhere = [];
  const db = {
    sessionStore: {
      findMany: async ({ where }) => {
        observedWhere.push(where);
        return [{
          sid: 'current-browser-secret',
          public_id: BROWSER_PUBLIC_ID,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          last_used_at: new Date('2026-01-02T00:00:00.000Z')
        }];
      }
    },
    mobileAuthSession: {
      findMany: async ({ where }) => {
        observedWhere.push(where);
        return [{
          id: 92,
          public_id: MOBILE_PUBLIC_ID,
          device_platform: MobileDevicePlatform.ANDROID_PHONE,
          device_name: '  Pixel 9  ',
          created_at: new Date('2026-02-01T00:00:00.000Z'),
          last_used_at: new Date('2026-02-02T00:00:00.000Z')
        }];
      }
    }
  };

  const sessions = await listAccountSessionsForUser({
    userId: 7,
    currentBrowserSessionId: 'current-browser-secret',
    now: new Date('2026-03-01T00:00:00.000Z'),
    db
  });

  assert.equal(observedWhere.every((where) => where.user_id === 7), true);
  assert.deepEqual(sessions, [
    {
      id: `browser_${BROWSER_PUBLIC_ID}`,
      kind: 'browser',
      device_label: null,
      created_at: '2026-01-01T00:00:00.000Z',
      last_activity_at: '2026-01-02T00:00:00.000Z',
      current: true
    },
    {
      id: `mobile_${MOBILE_PUBLIC_ID}`,
      kind: 'android_phone',
      device_label: 'Pixel 9',
      created_at: '2026-02-01T00:00:00.000Z',
      last_activity_at: '2026-02-02T00:00:00.000Z',
      current: false
    }
  ]);
  assert.doesNotMatch(JSON.stringify(sessions), /current-browser-secret/);
});
test('account session listing labels iOS phone and tablet sessions distinctly', async () => {
  const { listAccountSessionsForUser } = loadAccountSessionsService();
  const db = {
    sessionStore: {
      findMany: async () => []
    },
    mobileAuthSession: {
      findMany: async () => [{
        id: 93,
        public_id: MOBILE_PUBLIC_ID,
        device_platform: MobileDevicePlatform.IOS,
        device_name: 'iPad',
        created_at: new Date('2026-02-01T00:00:00.000Z'),
        last_used_at: null
      }]
    }
  };

  const sessions = await listAccountSessionsForUser({
    userId: 7,
    currentMobileSessionId: 93,
    now: new Date('2026-03-01T00:00:00.000Z'),
    db
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].kind, 'ios');
  assert.equal(sessions[0].device_label, 'iPad');
  assert.equal(sessions[0].current, true);
});


test('single-session revocation hides ownership and preserves the current session', async () => {
  const { revokeAccountSessionForUser } = loadAccountSessionsService();
  let active = true;
  let deleteCount = 0;
  const db = {
    sessionStore: {
      findFirst: async ({ where }) => where.user_id === 7 && active ? { sid: 'remote-browser' } : null,
      deleteMany: async ({ where }) => {
        assert.equal(where.user_id, 7);
        active = false;
        deleteCount += 1;
        return { count: 1 };
      }
    }
  };

  assert.deepEqual(await revokeAccountSessionForUser({
    userId: 8,
    sessionId: `browser_${BROWSER_PUBLIC_ID}`,
    currentBrowserSessionId: 'other',
    db
  }), { revoked: false, current: false });
  assert.deepEqual(await revokeAccountSessionForUser({
    userId: 7,
    sessionId: `browser_${BROWSER_PUBLIC_ID}`,
    currentBrowserSessionId: 'remote-browser',
    db
  }), { revoked: false, current: true });
  assert.deepEqual(await revokeAccountSessionForUser({
    userId: 7,
    sessionId: `browser_${BROWSER_PUBLIC_ID}`,
    currentBrowserSessionId: 'current-browser',
    db
  }), { revoked: true, current: false });
  assert.deepEqual(await revokeAccountSessionForUser({
    userId: 7,
    sessionId: `browser_${BROWSER_PUBLIC_ID}`,
    currentBrowserSessionId: 'current-browser',
    db
  }), { revoked: false, current: false });
  assert.equal(deleteCount, 1);
});

test('revoke others retries one serialization conflict and preserves both current-session predicates', async () => {
  const { revokeOtherAccountSessionsForUser } = loadAccountSessionsService();
  const calls = { transaction: 0, browserWhere: null, mobileWhere: null, pushWhere: null };
  const tx = {
    mobileAuthSession: {
      findMany: async ({ where }) => {
        calls.mobileWhere = where;
        return [{ id: 31 }];
      },
      updateMany: async () => ({ count: 1 })
    },
    sessionStore: {
      deleteMany: async ({ where }) => {
        calls.browserWhere = where;
        return { count: 2 };
      }
    },
    nativePushSubscription: {
      updateMany: async ({ where }) => {
        calls.pushWhere = where;
        return { count: 1 };
      }
    }
  };
  const db = {
    $transaction: async (work, options) => {
      calls.transaction += 1;
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      if (calls.transaction === 1) throw Object.assign(new Error('retry'), { code: 'P2034' });
      return work(tx);
    }
  };

  const revoked = await revokeOtherAccountSessionsForUser({
    userId: 7,
    currentBrowserSessionId: 'current-browser',
    currentMobileSessionId: 30,
    db
  });

  assert.equal(revoked, 3);
  assert.equal(calls.transaction, 2);
  assert.deepEqual(calls.browserWhere, { user_id: 7, sid: { not: 'current-browser' } });
  assert.deepEqual(calls.mobileWhere, { user_id: 7, revoked_at: null, id: { not: 30 } });
  assert.deepEqual(calls.pushWhere.mobile_auth_session_id, { in: [31] });
});
