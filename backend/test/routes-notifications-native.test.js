/** @file Regression coverage for routes notifications native: notifications route: transfers a browser endpoint and updates the owning session in place. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadNotificationsRouter({ prismaStub }) {
  const dbPath = require.resolve('../src/config/database');
  const webPushPath = require.resolve('../src/services/webPush');
  const routePath = require.resolve('../src/routes/notifications');

  const previousDbModule = require.cache[dbPath];
  const previousWebPushModule = require.cache[webPushPath];
  delete require.cache[routePath];

  stubModule(dbPath, prismaStub);
  stubModule(webPushPath, {
    getWebPushPublicKey: () => ({ publicKey: 'public-key' })
  });

  const loaded = require('../src/routes/notifications');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousWebPushModule) require.cache[webPushPath] = previousWebPushModule;
  else delete require.cache[webPushPath];

  return loaded.default ?? loaded;
}

function createRes(locals = {
  mobileAuthSessionId: 41,
  mobileDeviceId: 'session-device',
  mobileDevicePlatform: 'android_phone'
}) {
  return {
    statusCode: 200,
    body: undefined,
    locals,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function getRouteHandlers(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack.map((stackLayer) => stackLayer.handle);
}

test('notifications route: transfers a browser endpoint and updates the owning session in place', async () => {
  const rowsByEndpoint = new Map();
  const router = loadNotificationsRouter({
    prismaStub: {
      pushSubscription: {
        upsert: async ({ where, update, create }) => {
          const current = rowsByEndpoint.get(where.endpoint);
          const saved = current ? { ...current, ...update } : { id: rowsByEndpoint.size + 1, ...create };
          rowsByEndpoint.set(where.endpoint, saved);
          return saved;
        }
      }
    }
  });
  const handler = getRouteHandlers(router, 'post', '/subscription').at(-1);
  assert.ok(handler);
  const endpoint = 'https://push.example.test/shared-browser';

  await handler({
    user: { id: 5 },
    sessionID: 'session-owner-5',
    body: { endpoint, keys: { p256dh: 'owner-5-key', auth: 'owner-5-auth' } }
  }, createRes());
  await handler({
    user: { id: 8 },
    sessionID: 'session-owner-8',
    body: { endpoint, keys: { p256dh: 'owner-8-key', auth: 'owner-8-auth' } }
  }, createRes());
  await handler({
    user: { id: 8 },
    sessionID: 'session-owner-8',
    body: {
      endpoint,
      expirationTime: 1_800_000_000_000,
      keys: { p256dh: 'owner-8-refreshed-key', auth: 'owner-8-refreshed-auth' }
    }
  }, createRes());

  assert.equal(rowsByEndpoint.size, 1);
  assert.deepEqual(rowsByEndpoint.get(endpoint), {
    id: 1,
    user_id: 8,
    session_sid: 'session-owner-8',
    endpoint,
    p256dh: 'owner-8-refreshed-key',
    auth: 'owner-8-refreshed-auth',
    expiration_time: new Date(1_800_000_000_000),
    last_sent_local_date: null,
    last_sent_weight_local_date: null,
    last_sent_food_local_date: null
  });
});

test('notifications route: rejects native bearer ownership for browser push', async () => {
  const router = loadNotificationsRouter({ prismaStub: { pushSubscription: {} } });
  const [browserSessionGuard] = getRouteHandlers(router, 'post', '/subscription');
  const res = createRes({ mobileAuthSessionId: 41, mobileDeviceId: 'native-device' });
  let continued = false;

  browserSessionGuard(
    { sessionID: 'unpersisted-bearer-session' },
    res,
    () => { continued = true; }
  );

  assert.equal(continued, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { message: 'Browser session required.' });
});

test('notifications route: browser unsubscribe remains idempotent and owner-scoped after transfer', async () => {
  const endpoint = 'https://push.example.test/transferred-browser';
  const row = { user_id: 8, endpoint };
  const deleteCalls = [];
  const router = loadNotificationsRouter({
    prismaStub: {
      pushSubscription: {
        deleteMany: async ({ where }) => {
          deleteCalls.push(where);
          return { count: row.user_id === where.user_id && row.endpoint === where.endpoint ? 1 : 0 };
        }
      }
    }
  });
  const handler = getRouteHandlers(router, 'delete', '/subscription').at(-1);
  assert.ok(handler);

  const staleOwnerRes = createRes();
  await handler({ user: { id: 5 }, sessionID: 'session-owner-5', body: { endpoint } }, staleOwnerRes);
  const currentOwnerRes = createRes();
  await handler({ user: { id: 8 }, sessionID: 'session-owner-8', body: { endpoint } }, currentOwnerRes);

  assert.deepEqual(deleteCalls, [
    { user_id: 5, session_sid: 'session-owner-5', endpoint },
    { user_id: 8, session_sid: 'session-owner-8', endpoint }
  ]);
  assert.deepEqual(staleOwnerRes.body, { ok: true });
  assert.deepEqual(currentOwnerRes.body, { ok: true });
});

test('notifications route: transfers an Expo token to the authenticated mobile session', async () => {
  const previousMode = process.env.NATIVE_PUSH_MODE;
  process.env.NATIVE_PUSH_MODE = 'expo';
  let upsertArgs = null;
  let retireArgs = null;
  const router = loadNotificationsRouter({
    prismaStub: {
      nativePushSubscription: {
        upsert: async (args) => {
          upsertArgs = args;
          return { id: 1 };
        },
        updateMany: async (args) => {
          retireArgs = args;
          return { count: 1 };
        }
      }
    }
  });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const req = {
    isAuthenticated: () => true,
    user: { id: 5 },
    body: {
      token: 'ExponentPushToken[test]',
      device_id: 'untrusted-body-device',
      platform: 'android',
      provider: 'expo'
    }
  };
  const res = createRes();

  await handler(req, res);

  if (previousMode === undefined) delete process.env.NATIVE_PUSH_MODE;
  else process.env.NATIVE_PUSH_MODE = previousMode;

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(upsertArgs.where.provider_token.provider, 'EXPO');
  assert.equal(upsertArgs.where.provider_token.token, 'ExponentPushToken[test]');
  assert.equal(upsertArgs.update.user_id, 5);
  assert.equal(upsertArgs.update.mobile_auth_session_id, 41);
  assert.equal(upsertArgs.update.device_id, 'session-device');
  assert.equal(upsertArgs.update.platform, 'ANDROID');
  assert.equal(upsertArgs.create.platform, 'ANDROID');
  assert.equal(upsertArgs.update.last_sent_local_date, null);
  assert.equal(upsertArgs.create.device_id, 'session-device');
  assert.deepEqual(retireArgs.where, {
    user_id: 5,
    mobile_auth_session_id: 41,
    provider: 'EXPO',
    token: { not: 'ExponentPushToken[test]' },
    revoked_at: null
  });
  assert.ok(retireArgs.data.revoked_at instanceof Date);
});

test('notifications route: stores an iOS Expo token for an authenticated iOS session', async () => {
  const previousMode = process.env.NATIVE_PUSH_MODE;
  process.env.NATIVE_PUSH_MODE = 'expo';
  let upsertArgs = null;
  const router = loadNotificationsRouter({
    prismaStub: {
      nativePushSubscription: {
        upsert: async (args) => {
          upsertArgs = args;
          return { id: 1 };
        },
        updateMany: async () => ({ count: 0 })
      }
    }
  });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes({
    mobileAuthSessionId: 42,
    mobileDeviceId: 'ios-device',
    mobileDevicePlatform: 'ios'
  });

  await handler({
    user: { id: 5 },
    body: { token: 'ExpoPushToken[ios-test]', platform: 'ios', provider: 'expo' }
  }, res);

  if (previousMode === undefined) delete process.env.NATIVE_PUSH_MODE;
  else process.env.NATIVE_PUSH_MODE = previousMode;

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(upsertArgs.update.platform, 'IOS');
  assert.equal(upsertArgs.create.platform, 'IOS');
});

test('notifications route: rejects a push platform that does not match the native session', async () => {
  const router = loadNotificationsRouter({ prismaStub: { nativePushSubscription: {} } });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes({
    mobileAuthSessionId: 42,
    mobileDeviceId: 'ios-device',
    mobileDevicePlatform: 'ios'
  });

  await handler({
    user: { id: 5 },
    body: { token: 'ExpoPushToken[test]', platform: 'android', provider: 'expo' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Native push platform does not match the authenticated device.'
  });
});
test('notifications route: rejects registration when native push is not explicitly enabled', async () => {
  const previousMode = process.env.NATIVE_PUSH_MODE;
  delete process.env.NATIVE_PUSH_MODE;
  const router = loadNotificationsRouter({ prismaStub: { nativePushSubscription: {} } });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes();

  await handler({
    user: { id: 5 },
    body: { token: 'ExponentPushToken[test]', platform: 'android', provider: 'expo' }
  }, res);

  if (previousMode !== undefined) process.env.NATIVE_PUSH_MODE = previousMode;
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    message: 'Native push is disabled by this server.',
    code: 'NATIVE_PUSH_DISABLED'
  });
});

test('notifications route: rejects native subscription without token', async () => {
  const router = loadNotificationsRouter({
    prismaStub: {
      nativePushSubscription: {
        upsert: async () => {
          throw new Error('should not be called');
        }
      }
    }
  });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes();

  await handler({ user: { id: 5 }, body: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'token is required.' });
});

test('notifications route: requires bearer-backed mobile session ownership', async () => {
  const router = loadNotificationsRouter({ prismaStub: { nativePushSubscription: {} } });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes({});

  await handler(
    { user: { id: 5 }, body: { token: 'ExponentPushToken[test]', provider: 'expo' } },
    res
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Mobile authentication required.' });
});

test('notifications route: rejects unsupported FCM registrations', async () => {
  const router = loadNotificationsRouter({ prismaStub: { nativePushSubscription: {} } });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes();

  await handler(
    { user: { id: 5 }, body: { token: 'fcm-token', provider: 'fcm' } },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid or unsupported native push provider.' });
});

test('notifications route: validates Expo provider token shape', async () => {
  const router = loadNotificationsRouter({ prismaStub: { nativePushSubscription: {} } });
  const [handler] = getRouteHandlers(router, 'post', '/native-subscription');
  const res = createRes();

  await handler(
    { user: { id: 5 }, body: { token: 'not-an-expo-token', provider: 'expo' } },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid Expo push token.' });
});

test('notifications route: revokes native push only for the authenticated user and mobile session', async () => {
  let updateArgs = null;
  const router = loadNotificationsRouter({
    prismaStub: {
      nativePushSubscription: {
        updateMany: async (args) => {
          updateArgs = args;
          return { count: 0 };
        }
      }
    }
  });
  const [handler] = getRouteHandlers(router, 'delete', '/native-subscription');
  const res = createRes({ mobileAuthSessionId: 41, mobileDeviceId: 'session-device' });

  await handler(
    { user: { id: 5 }, body: { token: 'ExponentPushToken[test]', provider: 'expo' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(updateArgs.where, {
    user_id: 5,
    mobile_auth_session_id: 41,
    provider: 'EXPO',
    token: 'ExponentPushToken[test]',
    revoked_at: null
  });
});
