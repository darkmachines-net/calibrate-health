/** @file Regression coverage for routes dev notifications: dev notifications: test endpoint defaults to push + in-app delivery. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  NOTIFICATION_DELIVERY_CHANNELS,
  DEFAULT_NOTIFICATION_DELIVERY_CHANNELS
} = require('../../shared/notificationDelivery');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadDevRouter({ deliverUserNotificationStub, buildReminderPayloadStub, prismaStub }) {
  const databasePath = require.resolve('../src/config/database');
  const foodDataPath = require.resolve('../src/services/foodData');
  const notificationDeliveryPath = require.resolve('../src/services/notificationDelivery');
  const pushPayloadPath = require.resolve('../src/services/pushNotificationPayloads');
  const inAppNotificationsPath = require.resolve('../src/services/inAppNotifications');
  const devRoutePath = require.resolve('../src/routes/dev');

  const previousDatabaseModule = require.cache[databasePath];
  const previousFoodDataModule = require.cache[foodDataPath];
  const previousNotificationDeliveryModule = require.cache[notificationDeliveryPath];
  const previousPushPayloadModule = require.cache[pushPayloadPath];
  const previousInAppNotificationsModule = require.cache[inAppNotificationsPath];
  delete require.cache[devRoutePath];

  stubModule(databasePath, prismaStub || {
    pushSubscription: {
      count: async () => 0,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 })
    },
    inAppNotification: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 })
    }
  });

  stubModule(foodDataPath, {
    listFoodDataProviders: () => [],
    getFoodDataProviderByName: () => ({ provider: null, error: 'Provider is not available.' })
  });

  stubModule(notificationDeliveryPath, {
    deliverUserNotification: deliverUserNotificationStub
  });

  stubModule(pushPayloadPath, {
    buildReminderPayload:
      buildReminderPayloadStub ||
      (() => ({
        title: 'calibrate',
        body: 'Log your progress for today.',
        url: '/log'
      }))
  });

  stubModule(inAppNotificationsPath, {
    buildReminderInAppDedupeKey: (type, localDate) => `reminder:${type}:${localDate.toISOString().slice(0, 10)}`,
    buildDevReminderInAppDedupeKey: (type, localDate) => `dev:reminder:${type}:${localDate.toISOString().slice(0, 10)}`
  });

  const loaded = require('../src/routes/dev');

  if (previousDatabaseModule) require.cache[databasePath] = previousDatabaseModule;
  else delete require.cache[databasePath];

  if (previousFoodDataModule) require.cache[foodDataPath] = previousFoodDataModule;
  else delete require.cache[foodDataPath];

  if (previousNotificationDeliveryModule) require.cache[notificationDeliveryPath] = previousNotificationDeliveryModule;
  else delete require.cache[notificationDeliveryPath];

  if (previousPushPayloadModule) require.cache[pushPayloadPath] = previousPushPayloadModule;
  else delete require.cache[pushPayloadPath];

  if (previousInAppNotificationsModule) require.cache[inAppNotificationsPath] = previousInAppNotificationsModule;
  else delete require.cache[inAppNotificationsPath];

  return loaded.default ?? loaded;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
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

test('dev notifications: test endpoint defaults to push + in-app delivery', async () => {
  const deliveryCalls = [];
  const router = loadDevRouter({
    deliverUserNotificationStub: async (args) => {
      deliveryCalls.push(args);
      return {
        channels: args.channels,
        inApp: { attempted: true, created: 1, skipped: false, deduped: false },
        push: { attempted: true, sent: 1, failed: 0, skipped: false, deduped: false }
      };
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/test');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      endpoint: 'https://example.test/browser-endpoint'
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(deliveryCalls.length, 1);
  assert.deepEqual(deliveryCalls[0].channels, [...DEFAULT_NOTIFICATION_DELIVERY_CHANNELS]);
  assert.equal(deliveryCalls[0].push.endpoint, 'https://example.test/browser-endpoint');
  assert.equal(deliveryCalls[0].inApp.type, 'GENERIC');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test('dev notifications: in-app only delivery does not require a push endpoint', async () => {
  const deliveryCalls = [];
  const router = loadDevRouter({
    deliverUserNotificationStub: async (args) => {
      deliveryCalls.push(args);
      return {
        channels: args.channels,
        inApp: { attempted: true, created: 1, skipped: false, deduped: false },
        push: { attempted: false, sent: 0, failed: 0, skipped: true, deduped: false }
      };
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/log-food');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      channels: [NOTIFICATION_DELIVERY_CHANNELS.IN_APP]
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(deliveryCalls.length, 1);
  assert.deepEqual(deliveryCalls[0].channels, [NOTIFICATION_DELIVERY_CHANNELS.IN_APP]);
  assert.equal(deliveryCalls[0].inApp.type, 'LOG_FOOD_REMINDER');
  const localDate = deliveryCalls[0].inApp.localDate;
  assert.equal(
    deliveryCalls[0].inApp.dedupeKey,
    `dev:reminder:LOG_FOOD_REMINDER:${localDate.toISOString().slice(0, 10)}`
  );
  assert.equal(deliveryCalls[0].push.skipIfLastSentLocalDate.getTime(), localDate.getTime());
  assert.equal(deliveryCalls[0].push.markSentLocalDate.getTime(), localDate.getTime());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test('dev notifications: deduped reminder skips still report success', async () => {
  const router = loadDevRouter({
    deliverUserNotificationStub: async (args) => {
      return {
        channels: args.channels,
        inApp: { attempted: true, created: 0, skipped: true, deduped: true },
        push: { attempted: true, sent: 0, failed: 0, skipped: true, deduped: true }
      };
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/log-weight');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      endpoint: 'https://example.test/browser-endpoint',
      channels: [...DEFAULT_NOTIFICATION_DELIVERY_CHANNELS]
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.partial, false);
});

test('dev notifications: status endpoint reports push and in-app state for selected type', async () => {
  const localDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const localDateLabel = localDate.toISOString().slice(0, 10);
  const prismaStub = {
    pushSubscription: {
      count: async () => 2,
      findMany: async (args) => {
        assert.equal(args.where.endpoint, 'https://example.test/browser-endpoint');
        return [
          {
            endpoint: 'https://example.test/browser-endpoint',
            last_sent_local_date: localDate
          }
        ];
      },
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 })
    },
    inAppNotification: {
      findMany: async (args) => {
        const statusLocalDate = args.where.local_date.toISOString().slice(0, 10);
        return [
          {
            dedupe_key: `dev:reminder:LOG_WEIGHT_REMINDER:${statusLocalDate}`,
            read_at: null,
            dismissed_at: null,
            resolved_at: null
          }
        ];
      },
      deleteMany: async () => ({ count: 0 })
    }
  };

  const router = loadDevRouter({
    prismaStub,
    deliverUserNotificationStub: async () => {
      throw new Error('should not be called');
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'get', '/notifications/status');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    query: {
      type: 'log_weight',
      endpoint: 'https://example.test/browser-endpoint'
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.notification_type, 'log_weight');
  assert.equal(res.body.local_date, localDateLabel);
  assert.equal(res.body.push.total_subscription_count, 2);
  assert.equal(res.body.push.matching_subscription_count, 1);
  assert.equal(res.body.push.delivered_for_local_day, true);
  assert.equal(res.body.in_app.type, 'LOG_WEIGHT_REMINDER');
  assert.equal(res.body.in_app.dedupe_key, `dev:reminder:LOG_WEIGHT_REMINDER:${localDateLabel}`);
  assert.equal(res.body.in_app.deduped_for_local_day, true);
  assert.equal(res.body.in_app.today_total_count, 1);
});

test('dev notifications: clear endpoint resets selected push and in-app state', async () => {
  const pushUpdateCalls = [];
  const inAppDeleteCalls = [];
  const prismaStub = {
    pushSubscription: {
      count: async () => 0,
      findMany: async () => [],
      updateMany: async (args) => {
        pushUpdateCalls.push(args);
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 0 })
    },
    inAppNotification: {
      findMany: async () => [],
      deleteMany: async (args) => {
        inAppDeleteCalls.push(args);
        return { count: 2 };
      }
    }
  };

  const router = loadDevRouter({
    prismaStub,
    deliverUserNotificationStub: async () => {
      throw new Error('should not be called');
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/clear');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      type: 'log_food',
      endpoint: 'https://example.test/browser-endpoint',
      clear_push_delivery: true,
      clear_in_app: true
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(pushUpdateCalls.length, 1);
  assert.equal(pushUpdateCalls[0].where.user_id, 3);
  assert.equal(pushUpdateCalls[0].where.endpoint, 'https://example.test/browser-endpoint');
  assert.equal(pushUpdateCalls[0].data.last_sent_local_date, null);
  assert.equal(inAppDeleteCalls.length, 1);
  assert.equal(inAppDeleteCalls[0].where.user_id, 3);
  assert.ok(Array.isArray(inAppDeleteCalls[0].where.OR));
  assert.equal(inAppDeleteCalls[0].where.OR[0].dedupe_key.startsWith('dev:reminder:LOG_FOOD_REMINDER:'), true);
  assert.equal(inAppDeleteCalls[0].where.OR[1].type, 'LOG_FOOD_REMINDER');
  assert.equal(res.body.cleared.push_delivery, 1);
  assert.equal(res.body.cleared.in_app, 2);
});

test('dev notifications: clear endpoint requires at least one clear action', async () => {
  const router = loadDevRouter({
    deliverUserNotificationStub: async () => {
      throw new Error('should not be called');
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/clear');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      type: 'log_food'
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Select at least one notification state to clear.'
  });
});

test('dev notifications: returns 400 when push is selected without endpoint', async () => {
  let callCount = 0;
  const router = loadDevRouter({
    deliverUserNotificationStub: async () => {
      callCount += 1;
      return {
        channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
        inApp: { attempted: false, created: 0, skipped: true, deduped: false },
        push: { attempted: true, sent: 0, failed: 0, skipped: true, deduped: false }
      };
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/log-weight');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH]
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(callCount, 0);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Endpoint is required when push delivery is selected.'
  });
});

test('dev notifications: returns 400 when channel selection is empty', async () => {
  let callCount = 0;
  const router = loadDevRouter({
    deliverUserNotificationStub: async () => {
      callCount += 1;
      return {
        channels: [],
        inApp: { attempted: false, created: 0, skipped: true, deduped: false },
        push: { attempted: false, sent: 0, failed: 0, skipped: true, deduped: false }
      };
    }
  });

  const [authMiddleware, handler] = getRouteHandlers(router, 'post', '/notifications/test');
  const req = {
    isAuthenticated: () => true,
    user: { id: 3, timezone: 'UTC' },
    body: {
      channels: []
    }
  };
  const res = createRes();

  let nextCalled = false;
  await authMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);

  assert.equal(callCount, 0);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Select at least one notification channel.'
  });
});
