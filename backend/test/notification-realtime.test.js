/** @file Regression coverage for notification realtime: notification realtime publisher fans out only to the subscribed user and cleans up. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const {
  NOTIFICATION_REALTIME_REASONS,
  isNotificationRealtimePayload
} = require('../../shared/notificationRealtime');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadInAppNotificationService({ publishNotificationRealtimeUpdateStub }) {
  const dbPath = require.resolve('../src/config/database');
  const realtimePath = require.resolve('../src/services/notificationRealtime');
  const servicePath = require.resolve('../src/services/inAppNotifications');

  const previousDbModule = require.cache[dbPath];
  const previousRealtimeModule = require.cache[realtimePath];
  delete require.cache[servicePath];

  stubModule(dbPath, {});
  stubModule(realtimePath, {
    publishNotificationRealtimeUpdate: publishNotificationRealtimeUpdateStub
  });

  const loaded = require('../src/services/inAppNotifications');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

  if (previousRealtimeModule) require.cache[realtimePath] = previousRealtimeModule;
  else delete require.cache[realtimePath];

  return loaded;
}

function loadNotificationsRouter() {
  const dbPath = require.resolve('../src/config/database');
  const routerPath = require.resolve('../src/routes/notifications');
  const previousDbModule = require.cache[dbPath];
  delete require.cache[routerPath];
  stubModule(dbPath, {});
  const router = require('../src/routes/notifications').default;
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  return router;
}

function routeHandler(router, path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path);
  assert.ok(layer, `Expected route ${path}`);
  return layer.route.stack[0].handle;
}

test('notification realtime publisher fans out only to the subscribed user and cleans up', () => {
  delete require.cache[require.resolve('../src/services/notificationRealtime')];
  const {
    getNotificationRealtimeSubscriberCount,
    publishNotificationRealtimeUpdate,
    subscribeToNotificationRealtimeUpdates
  } = require('../src/services/notificationRealtime');

  const userOnePayloads = [];
  const userTwoPayloads = [];
  const unsubscribeUserOne = subscribeToNotificationRealtimeUpdates({
    userId: 1,
    onUpdate: (payload) => userOnePayloads.push(payload)
  });
  const unsubscribeUserTwo = subscribeToNotificationRealtimeUpdates({
    userId: 2,
    onUpdate: (payload) => userTwoPayloads.push(payload)
  });

  assert.equal(getNotificationRealtimeSubscriberCount(1), 1);
  assert.equal(getNotificationRealtimeSubscriberCount(2), 1);

  publishNotificationRealtimeUpdate({
    userId: 1,
    reason: NOTIFICATION_REALTIME_REASONS.CREATED,
    now: new Date('2026-04-24T12:00:00.000Z')
  });

  assert.equal(userOnePayloads.length, 1);
  assert.equal(userOnePayloads[0].reason, NOTIFICATION_REALTIME_REASONS.CREATED);
  assert.equal(userOnePayloads[0].updated_at, '2026-04-24T12:00:00.000Z');
  assert.equal(userTwoPayloads.length, 0);

  unsubscribeUserOne();
  assert.equal(getNotificationRealtimeSubscriberCount(1), 0);

  publishNotificationRealtimeUpdate({
    userId: 1,
    reason: NOTIFICATION_REALTIME_REASONS.READ
  });

  assert.equal(userOnePayloads.length, 1);
  unsubscribeUserTwo();
});

test('notification realtime payload guard accepts the shared SSE wire shape', () => {
  assert.equal(
    isNotificationRealtimePayload({
      reason: NOTIFICATION_REALTIME_REASONS.DISMISSED,
      updated_at: '2026-04-24T12:00:00.000Z'
    }),
    true
  );
  assert.equal(isNotificationRealtimePayload({ reason: 'other', updated_at: '2026-04-24T12:00:00.000Z' }), false);
  assert.equal(isNotificationRealtimePayload({ reason: NOTIFICATION_REALTIME_REASONS.READ, updated_at: '' }), false);
});

test('notification stream middleware rejects unauthenticated browser sessions', () => {
  const router = loadNotificationsRouter();
  const authLayer = router.stack.find((layer) => !layer.route);
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };

  authLayer.handle({ isAuthenticated: () => false }, response, () => assert.fail('must not call next'));

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { message: 'Not authenticated' });
});

test('notification stream writes user-scoped events and releases its subscription on close', () => {
  delete require.cache[require.resolve('../src/services/notificationRealtime')];
  const realtime = require('../src/services/notificationRealtime');
  const router = loadNotificationsRouter();
  const response = new EventEmitter();
  const writes = [];
  response.status = () => response;
  response.set = () => response;
  response.flushHeaders = () => {};
  response.write = (chunk) => { writes.push(chunk); return true; };

  routeHandler(router, '/stream')({ user: { id: 91 } }, response);
  assert.equal(realtime.getNotificationRealtimeSubscriberCount(91), 1);

  realtime.publishNotificationRealtimeUpdate({
    userId: 91,
    reason: NOTIFICATION_REALTIME_REASONS.CREATED,
    now: new Date('2026-07-12T00:00:00.000Z')
  });
  realtime.publishNotificationRealtimeUpdate({
    userId: 92,
    reason: NOTIFICATION_REALTIME_REASONS.CREATED,
    now: new Date('2026-07-12T00:00:00.000Z')
  });

  assert.match(writes.join(''), /event: notification-update/);
  assert.match(writes.join(''), /2026-07-12T00:00:00.000Z/);
  assert.equal((writes.join('').match(/event: notification-update/g) ?? []).length, 1);

  response.emit('close');
  assert.equal(realtime.getNotificationRealtimeSubscriberCount(91), 0);
});

test('in-app notification mutations publish realtime updates when rows change', async () => {
  const publishCalls = [];
  const updateCalls = [];
  const { markInAppNotificationDismissed, markInAppNotificationRead } = loadInAppNotificationService({
    publishNotificationRealtimeUpdateStub: (args) => {
      publishCalls.push(args);
      return { reason: args.reason, updated_at: args.now.toISOString() };
    }
  });

  const now = new Date('2026-04-24T12:00:00.000Z');
  const db = {
    inAppNotification: {
      updateMany: async (args) => {
        updateCalls.push(args);
        return { count: 1 };
      }
    }
  };

  const readCount = await markInAppNotificationRead({
    userId: 7,
    notificationId: 10,
    now,
    db
  });
  const dismissCount = await markInAppNotificationDismissed({
    userId: 7,
    notificationId: 10,
    now,
    db
  });

  assert.equal(readCount, 1);
  assert.equal(dismissCount, 1);
  assert.deepEqual(updateCalls[0].where, {
    id: 10,
    user_id: 7,
    dismissed_at: null,
    resolved_at: null,
    read_at: null
  });
  assert.deepEqual(updateCalls[1].where, {
    id: 10,
    user_id: 7,
    dismissed_at: null,
    resolved_at: null,
    read_at: null
  });
  assert.equal(publishCalls.length, 2);
  assert.deepEqual(
    publishCalls.map((call) => call.reason),
    [NOTIFICATION_REALTIME_REASONS.READ, NOTIFICATION_REALTIME_REASONS.DISMISSED]
  );
  assert.equal(publishCalls[0].userId, 7);
});

test('dismissing a previously read notification preserves its original read timestamp', async () => {
  const updateCalls = [];
  const publishCalls = [];
  const { markInAppNotificationDismissed } = loadInAppNotificationService({
    publishNotificationRealtimeUpdateStub: (args) => publishCalls.push(args)
  });
  const now = new Date('2026-04-24T12:00:00.000Z');

  const count = await markInAppNotificationDismissed({
    userId: 7,
    notificationId: 10,
    now,
    db: {
      inAppNotification: {
        updateMany: async (args) => {
          updateCalls.push(args);
          return { count: args.where.read_at === null ? 0 : 1 };
        }
      }
    }
  });

  assert.equal(count, 1);
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(updateCalls[1].data, { dismissed_at: now });
  assert.equal(Object.hasOwn(updateCalls[1].data, 'read_at'), false);
  assert.equal(publishCalls.length, 1);
});

test('in-app notification mutations skip realtime publishing when nothing changed', async () => {
  let publishCount = 0;
  const { markInAppNotificationRead } = loadInAppNotificationService({
    publishNotificationRealtimeUpdateStub: () => {
      publishCount += 1;
    }
  });

  const result = await markInAppNotificationRead({
    userId: 7,
    notificationId: 10,
    db: {
      inAppNotification: {
        updateMany: async () => ({ count: 0 })
      }
    }
  });

  assert.equal(result, 0);
  assert.equal(publishCount, 0);
});
