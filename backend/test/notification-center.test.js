/** @file Regression coverage for notification center: notification pages use an owner-scoped stable tuple cursor and bind it to the view. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadInAppNotificationService(publish = () => undefined) {
  const dbPath = require.resolve('../src/config/database');
  const realtimePath = require.resolve('../src/services/notificationRealtime');
  const servicePath = require.resolve('../src/services/inAppNotifications');
  const previousDbModule = require.cache[dbPath];
  const previousRealtimeModule = require.cache[realtimePath];
  delete require.cache[servicePath];

  stubModule(dbPath, {});
  stubModule(realtimePath, { publishNotificationRealtimeUpdate: publish });
  const service = require('../src/services/inAppNotifications');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousRealtimeModule) require.cache[realtimePath] = previousRealtimeModule;
  else delete require.cache[realtimePath];
  return service;
}

function loadNotificationsRouter(service) {
  const dbPath = require.resolve('../src/config/database');
  const webPushPath = require.resolve('../src/services/webPush');
  const realtimePath = require.resolve('../src/services/notificationRealtime');
  const servicePath = require.resolve('../src/services/inAppNotifications');
  const routePath = require.resolve('../src/routes/notifications');
  const previous = new Map([
    [dbPath, require.cache[dbPath]],
    [webPushPath, require.cache[webPushPath]],
    [realtimePath, require.cache[realtimePath]],
    [servicePath, require.cache[servicePath]]
  ]);
  delete require.cache[routePath];

  stubModule(dbPath, {});
  stubModule(webPushPath, { getWebPushPublicKey: () => ({ publicKey: 'public-key' }) });
  stubModule(realtimePath, {
    NOTIFICATION_REALTIME_EVENT_NAME: 'notification-update',
    subscribeToNotificationRealtimeUpdates: () => () => undefined
  });
  stubModule(servicePath, service);
  const loaded = require('../src/routes/notifications');

  for (const [path, cached] of previous) {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
  return loaded.default ?? loaded;
}

function routeHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function row(id, createdAt, overrides = {}) {
  return {
    id,
    type: 'GENERIC',
    local_date: new Date('2026-08-09T00:00:00.000Z'),
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
    read_at: null,
    dismissed_at: null,
    resolved_at: null,
    title: `Notification ${id}`,
    body: null,
    action_url: '/today',
    ...overrides
  };
}

test('notification pages use an owner-scoped stable tuple cursor and bind it to the view', async () => {
  const service = loadInAppNotificationService();
  const firstFindCalls = [];
  const firstPage = await service.listInAppNotificationPageForUser({
    userId: 41,
    view: service.IN_APP_NOTIFICATION_VIEWS.HISTORY,
    limit: 2,
    cursor: null,
    db: {
      inAppNotification: {
        findMany: async (args) => {
          firstFindCalls.push(args);
          return [
            row(10, '2026-08-09T10:00:00.000Z'),
            row(9, '2026-08-09T09:00:00.000Z', { read_at: new Date('2026-08-09T09:30:00.000Z') }),
            row(8, '2026-08-09T08:00:00.000Z')
          ];
        },
        count: async (args) => {
          assert.deepEqual(args.where, {
            user_id: 41,
            read_at: null,
            dismissed_at: null,
            resolved_at: null
          });
          return 4;
        }
      }
    }
  });

  assert.deepEqual(firstFindCalls[0].where, { user_id: 41 });
  assert.equal(firstFindCalls[0].take, 3);
  assert.deepEqual(firstPage.notifications.map(({ id }) => id), [10, 9]);
  assert.equal(firstPage.notifications[1].read_at, '2026-08-09T09:30:00.000Z');
  assert.equal(firstPage.unreadCount, 4);
  assert.ok(firstPage.nextCursor);

  const parsed = service.parseInAppNotificationPageQuery({
    view: 'history',
    limit: '2',
    cursor: firstPage.nextCursor
  });
  assert.equal(parsed.ok, true);
  assert.equal(service.parseInAppNotificationPageQuery({
    view: 'active',
    cursor: firstPage.nextCursor
  }).ok, false);

  const secondFindCalls = [];
  await service.listInAppNotificationPageForUser({
    userId: 41,
    ...parsed.query,
    db: {
      inAppNotification: {
        findMany: async (args) => { secondFindCalls.push(args); return []; },
        count: async () => 4
      }
    }
  });
  assert.equal(secondFindCalls[0].where.user_id, 41);
  assert.deepEqual(secondFindCalls[0].where.OR, [
    { created_at: { lt: new Date('2026-08-09T09:00:00.000Z') } },
    { created_at: new Date('2026-08-09T09:00:00.000Z'), id: { lt: 9 } }
  ]);
});

test('active paging retains the legacy unread predicate and rejects malformed query values', async () => {
  const service = loadInAppNotificationService();
  const calls = [];
  await service.listInAppNotificationPageForUser({
    userId: 73,
    view: service.IN_APP_NOTIFICATION_VIEWS.ACTIVE,
    limit: 5,
    cursor: null,
    db: {
      inAppNotification: {
        findMany: async (args) => { calls.push(args); return []; },
        count: async () => 0
      }
    }
  });

  assert.deepEqual(calls[0].where, {
    user_id: 73,
    read_at: null,
    dismissed_at: null,
    resolved_at: null
  });
  for (const query of [
    { view: 'other' },
    { view: ['history'] },
    { limit: '0' },
    { limit: '101' },
    { cursor: 'not-a-cursor' },
    { unexpected: 'value' }
  ]) {
    assert.equal(service.parseInAppNotificationPageQuery(query).ok, false);
  }
});

test('mark all read is owner-scoped, idempotent, and publishes no private payload', async () => {
  const publications = [];
  const updateCalls = [];
  const counts = [3, 0];
  const service = loadInAppNotificationService((payload) => publications.push(payload));
  const db = {
    inAppNotification: {
      updateMany: async (args) => {
        updateCalls.push(args);
        return { count: counts.shift() };
      }
    }
  };
  const now = new Date('2026-08-09T12:00:00.000Z');

  assert.equal(await service.markAllInAppNotificationsRead({ userId: 91, now, db }), 3);
  assert.equal(await service.markAllInAppNotificationsRead({ userId: 91, now, db }), 0);
  assert.deepEqual(updateCalls[0], {
    where: { user_id: 91, read_at: null },
    data: { read_at: now }
  });
  assert.deepEqual(publications, [{ userId: 91, reason: 'read', now }]);
  assert.equal(JSON.stringify(publications).includes('token'), false);
});

test('route preserves no-query response and exposes paged history plus read-all', async () => {
  const calls = [];
  const router = loadNotificationsRouter({
    parseInAppNotificationPageQuery: (query) => {
      calls.push(['parse', query]);
      return { ok: true, query: { view: 'history', limit: 2, cursor: null } };
    },
    resolveInactiveReminderNotificationsForUser: async (args) => { calls.push(['resolve', args]); },
    listActiveInAppNotificationsForUser: async (args) => {
      calls.push(['legacy', args]);
      return { notifications: [{ id: 1 }], unreadCount: 1 };
    },
    listInAppNotificationPageForUser: async (args) => {
      calls.push(['page', args]);
      return { notifications: [{ id: 2 }], unreadCount: 1, nextCursor: 'next' };
    },
    markAllInAppNotificationsRead: async (args) => { calls.push(['read-all', args]); return 4; },
    markInAppNotificationRead: async () => 0,
    markInAppNotificationDismissed: async () => 0
  });
  const getHandler = routeHandler(router, 'get', '/in-app');

  const legacyResponse = createResponse();
  await getHandler({ user: { id: 51, timezone: 'UTC' }, query: {} }, legacyResponse);
  assert.deepEqual(legacyResponse.body, { notifications: [{ id: 1 }], unread_count: 1 });
  assert.equal(Object.hasOwn(legacyResponse.body, 'next_cursor'), false);
  assert.equal(calls.some(([name]) => name === 'parse'), false);

  const pageResponse = createResponse();
  await getHandler({ user: { id: 51, timezone: 'UTC' }, query: { view: 'history', limit: '2' } }, pageResponse);
  assert.deepEqual(pageResponse.body, {
    notifications: [{ id: 2 }],
    unread_count: 1,
    next_cursor: 'next'
  });
  assert.equal(calls.find(([name]) => name === 'page')[1].userId, 51);

  const readAllResponse = createResponse();
  await routeHandler(router, 'patch', '/in-app/read-all')({ user: { id: 51 } }, readAllResponse);
  assert.deepEqual(readAllResponse.body, { ok: true, updated_count: 4 });
  assert.deepEqual(calls.find(([name]) => name === 'read-all')[1], { userId: 51 });
});
