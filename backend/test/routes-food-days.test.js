/** @file Regression coverage for routes food days: food-days route: rejects unauthenticated requests via router.use middleware. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadFoodDaysRouter(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const routePath = require.resolve('../src/routes/foodDays');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const foodTrackingPath = require.resolve('../src/services/foodTracking');

  const previousDbModule = require.cache[dbPath];
  const previousClientOperationsModule = require.cache[clientOperationsPath];
  const previousFoodTrackingModule = require.cache[foodTrackingPath];
  delete require.cache[routePath];
  delete require.cache[clientOperationsPath];
  delete require.cache[foodTrackingPath];

  const normalizedPrismaStub = {
    $executeRaw: async () => 1,
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    ...prismaStub,
    syncChange: {
      create: async () => ({ id: 1n }),
      ...(prismaStub.syncChange ?? {})
    }
  };
  normalizedPrismaStub.$transaction ??= async (callback) => callback(normalizedPrismaStub);
  stubModule(dbPath, normalizedPrismaStub);
  const loaded = require('../src/routes/foodDays');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

  if (previousClientOperationsModule) require.cache[clientOperationsPath] = previousClientOperationsModule;
  else delete require.cache[clientOperationsPath];
  if (previousFoodTrackingModule) require.cache[foodTrackingPath] = previousFoodTrackingModule;
  else delete require.cache[foodTrackingPath];

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

function getIsAuthenticatedMiddleware(router) {
  const layer = router.stack.find((candidate) => !candidate.route);
  assert.ok(layer, 'Expected router.use(isAuthenticated) middleware to exist');
  return layer.handle;
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  assert.equal(layer.route.stack.length, 1);
  return layer.route.stack[0].handle;
}

test('food-days route: rejects unauthenticated requests via router.use middleware', async () => {
  const router = loadFoodDaysRouter({ foodLogDay: {} });
  const isAuthenticated = getIsAuthenticatedMiddleware(router);

  const req = { isAuthenticated: () => false };
  const res = createRes();

  let nextCalled = false;
  await isAuthenticated(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Not authenticated' });
});

test('food-days route: GET / returns default incomplete status when no row exists', async () => {
  let receivedWhere = null;
  const prismaStub = {
    foodLogDay: {
      findUnique: async ({ where }) => {
        receivedWhere = where;
        return null;
      },
      findFirst: async () => null
    },
    user: { findUnique: async () => ({ created_at: new Date('2025-01-01T00:00:00Z'), timezone: 'UTC' }) },
    foodLog: { findFirst: async () => null, count: async () => 0 },
    bodyMetric: { findFirst: async () => null },
    foodTrackingPause: { findFirst: async () => null }
  };

  const router = loadFoodDaysRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');
  const req = { user: { id: 7 }, query: { date: '2025-01-02' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    date: '2025-01-02',
    status: 'INCOMPLETE',
    origin: null,
    source: 'INFERRED_EMPTY',
    is_representative: false,
    is_complete: false,
    completed_at: null,
    updated_at: null
  });
  assert.equal(receivedWhere.user_id_local_date.user_id, 7);
  assert.equal(receivedWhere.user_id_local_date.local_date.toISOString(), '2025-01-02T00:00:00.000Z');
});

test('food-days route: GET /range returns inclusive day statuses for start/end', async () => {
  let receivedWhere = null;
  const completedAt = new Date('2025-01-02T17:00:00Z');

  const prismaStub = {
    foodLogDay: {
      findFirst: async () => null,
      findMany: async ({ where }) => {
        receivedWhere = where;
        return [
          {
            local_date: new Date('2025-01-02T00:00:00Z'),
            status: 'COMPLETE',
            origin: 'USER',
            completed_at: completedAt,
            updated_at: completedAt
          }
        ];
      }
    },
    user: { findUnique: async () => ({ created_at: new Date('2025-01-01T00:00:00Z'), timezone: 'UTC' }) },
    foodLog: { findFirst: async () => null, findMany: async () => [] },
    bodyMetric: { findFirst: async () => null },
    foodTrackingPause: { findFirst: async () => null, findMany: async () => [] }
  };

  const router = loadFoodDaysRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/range');
  const req = { user: { id: 7 }, query: { start: '2025-01-01', end: '2025-01-03' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    start_date: '2025-01-01',
    end_date: '2025-01-03',
    days: [
      {
        date: '2025-01-01', status: 'INCOMPLETE', origin: null, source: 'INFERRED_EMPTY',
        is_representative: false, is_complete: false, completed_at: null, updated_at: null
      },
      {
        date: '2025-01-02', status: 'COMPLETE', origin: 'USER', source: 'STORED',
        is_representative: true, is_complete: true, completed_at: completedAt, updated_at: completedAt, calorie_comparison: null
      },
      {
        date: '2025-01-03', status: 'INCOMPLETE', origin: null, source: 'INFERRED_EMPTY',
        is_representative: false, is_complete: false, completed_at: null, updated_at: null
      }
    ]
  });

  assert.equal(receivedWhere.user_id, 7);
  assert.equal(receivedWhere.local_date.gte.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(receivedWhere.local_date.lte.toISOString(), '2025-01-03T00:00:00.000Z');
});

test('food-days route: GET /range supports month query', async () => {
  const prismaStub = {
    foodLogDay: {
      findFirst: async () => null,
      findMany: async () => []
    },
    user: { findUnique: async () => ({ created_at: new Date('2025-01-01T00:00:00Z'), timezone: 'UTC' }) },
    foodLog: { findFirst: async () => null, findMany: async () => [] },
    bodyMetric: { findFirst: async () => null },
    foodTrackingPause: { findFirst: async () => null, findMany: async () => [] }
  };

  const router = loadFoodDaysRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/range');
  const req = { user: { id: 7 }, query: { month: '2025-02' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.start_date, '2025-02-01');
  assert.equal(res.body.end_date, '2025-02-28');
  assert.equal(Array.isArray(res.body.days), true);
  assert.equal(res.body.days.length, 28);
  assert.equal(res.body.days[0].date, '2025-02-01');
  assert.equal(res.body.days[27].date, '2025-02-28');
});

test('food-days route: GET /range validates query shape', async () => {
  const prismaStub = {
    foodLogDay: {
      findMany: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const router = loadFoodDaysRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/range');

  const mixedReq = { user: { id: 7 }, query: { month: '2025-01', start: '2025-01-01', end: '2025-01-31' } };
  const mixedRes = createRes();
  await handler(mixedReq, mixedRes);
  assert.equal(mixedRes.statusCode, 400);
  assert.deepEqual(mixedRes.body, { message: 'Provide either month or start/end' });

  const invalidMonthReq = { user: { id: 7 }, query: { month: '2025-99' } };
  const invalidMonthRes = createRes();
  await handler(invalidMonthReq, invalidMonthRes);
  assert.equal(invalidMonthRes.statusCode, 400);
  assert.deepEqual(invalidMonthRes.body, { message: 'Invalid month' });

  const missingStartReq = { user: { id: 7 }, query: { end: '2025-01-10' } };
  const missingStartRes = createRes();
  await handler(missingStartReq, missingStartRes);
  assert.equal(missingStartRes.statusCode, 400);
  assert.deepEqual(missingStartRes.body, { message: 'Provide start and end dates' });
});


test('PATCH completion captures its local-day plan once and reopening/recompletion retains it', async () => {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  let stored = null;
  let syncPayload;
  const goal = { id: 1, user_id: 7, start_weight_grams: 90000, target_weight_grams: 80000, daily_deficit: 500, calorie_plan_review_status: 'CLEAR', created_at: now };
  const prismaStub = {
    foodLog: { findMany: async () => [{ calories: 1800 }] },
    syncChange: { create: async ({data}) => { syncPayload = data.payload; return { id: 1n }; } },
    user: { findUnique: async () => ({ id: 7, timezone: 'UTC', date_of_birth: new Date('1990-01-01Z'), sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM' }) },
    goal: { findFirst: async () => goal },
    bodyMetric: { findFirst: async () => ({ weight_grams: 90000 }) },
    caloriePlanRevision: { findFirst: async () => null, findMany: async () => [] },
    foodLogDay: {
      findUnique: async () => stored,
      upsert: async ({create, update}) => { stored = { id: 1, updated_at: now, ...(stored ?? create), ...(stored ? update : {}) }; return stored; },
      update: async ({data}) => { stored = { ...stored, ...data, updated_at: new Date(now.getTime() + 1) }; return stored; }
    }
  };
  const router = loadFoodDaysRouter(prismaStub);
  const handler = getRouteHandler(router, 'patch', '/');
  const change = async status => {
    const res = createRes();
    await handler({ user: { id: 7 }, headers: {}, body: { date: dateKey, status } }, res);
    assert.equal(res.statusCode, 200);
    return res.body;
  };
  const complete = await change('COMPLETE');
  assert.equal(complete.is_complete, true);
  assert.equal(complete.updated_at, stored.updated_at);
  assert.equal(stored.comparison_maintenance_kcal - stored.comparison_target_kcal, 500);
  assert.equal(complete.calorie_comparison.target_kcal, stored.comparison_target_kcal);
  assert.equal(complete.calorie_comparison.consumed_kcal, 1800);
  assert.deepEqual(syncPayload.calorie_comparison, complete.calorie_comparison);
  const fetched = createRes();
  await getRouteHandler(router, 'get', '/')({ user: {id: 7}, query: {date: dateKey} }, fetched);
  assert.deepEqual(fetched.body.calorie_comparison, complete.calorie_comparison);
  const snapshot = stored.comparison_target_kcal;
  const reopened = await change('OPEN');
  assert.equal(reopened.is_complete, false);
  assert.deepEqual(reopened.calorie_comparison, complete.calorie_comparison);
  goal.daily_deficit = -500;
  assert.deepEqual((await change('COMPLETE')).calorie_comparison, complete.calorie_comparison);
  assert.equal(stored.comparison_target_kcal, snapshot);
});
