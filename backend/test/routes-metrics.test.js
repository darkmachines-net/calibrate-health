/** @file Regression coverage for routes metrics: metrics baseline: same-day first weight and correction preserve the goal and synchronize its baseline. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const POUNDS_PER_KILOGRAM = 2.2046226218487757;
const FLOAT_TOLERANCE = 1e-9;
const {
  addUtcDays,
  addUtcYearsClamped,
  getUtcTodayDateOnly
} = require('../src/utils/date');
const { computeWeightTrend } = require('../../shared/weightTrend.ts');
const {
  computeWeightTrendSourceRevision
} = require('../src/services/weightTrendSourceRevision');

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadMetricsRouter(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const metricsPath = require.resolve('../src/routes/metrics');
  const materializedTrendPath = require.resolve('../src/services/materializedWeightTrend');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const caloriePlanningPath = require.resolve('../src/services/caloriePlanning');
  const caloriePlanReviewPath = require.resolve('../src/services/caloriePlanReview');

  const previousDbModule = require.cache[dbPath];
  const previousMaterializedTrendModule = require.cache[materializedTrendPath];
  const previousClientOperationsModule = require.cache[clientOperationsPath];
  const previousCaloriePlanningModule = require.cache[caloriePlanningPath];
  const previousCaloriePlanReviewModule = require.cache[caloriePlanReviewPath];
  delete require.cache[metricsPath];
  delete require.cache[materializedTrendPath];
  delete require.cache[clientOperationsPath];
  delete require.cache[caloriePlanningPath];
  delete require.cache[caloriePlanReviewPath];

  const normalizedPrismaStub = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    ...prismaStub,
    $queryRaw: prismaStub.$queryRaw ?? (async () => []),
    $transaction: prismaStub.$transaction ?? (async (callback) => callback(normalizedPrismaStub)),
    bodyMetric: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      ...(prismaStub.bodyMetric ?? {})
    },
    goal: {
      findFirst: async () => null,
      ...(prismaStub.goal ?? {})
    },
    bodyMetricTrend: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => ({ count: data.length }),
      ...(prismaStub.bodyMetricTrend ?? {})
    },
    user: {
      findUnique: async () => ({
        id: 7, timezone: 'UTC', date_of_birth: new Date('1990-01-01T00:00:00.000Z'),
        sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM'
      }),
      ...(prismaStub.user ?? {})
    },
    caloriePlanRevision: {
      findFirst: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      ...(prismaStub.caloriePlanRevision ?? {})
    },
    calibrationRecommendation: {
      updateMany: async () => ({ count: 0 }),
      ...(prismaStub.calibrationRecommendation ?? {})
    },
    syncChange: {
      create: async () => ({ id: 1n }),
      ...(prismaStub.syncChange ?? {})
    }
  };

  stubModule(dbPath, normalizedPrismaStub);
  const loaded = require('../src/routes/metrics');

  if (previousMaterializedTrendModule) {
    require.cache[materializedTrendPath] = previousMaterializedTrendModule;
  } else {
    delete require.cache[materializedTrendPath];
  }

  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }

  if (previousClientOperationsModule) {
    require.cache[clientOperationsPath] = previousClientOperationsModule;
  } else {
    delete require.cache[clientOperationsPath];
  }
  if (previousCaloriePlanningModule) require.cache[caloriePlanningPath] = previousCaloriePlanningModule;
  else delete require.cache[caloriePlanningPath];
  if (previousCaloriePlanReviewModule) require.cache[caloriePlanReviewPath] = previousCaloriePlanReviewModule;
  else delete require.cache[caloriePlanReviewPath];

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
    },
    send(payload) {
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

function assertNearlyEqual(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= FLOAT_TOLERANCE, `Expected ${actual} to be within ${FLOAT_TOLERANCE} of ${expected}`);
}

function baselineFixture({ goalDate, timeZone = 'UTC', initialWeight = 90000, onLock } = {}) {
  let goal = {
    id: 46, user_id: 7, created_at: goalDate ?? new Date(), start_weight_grams: initialWeight,
    target_weight_grams: 75000, target_date: null, daily_deficit: 500,
    calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
  };
  let metric = null;
  const changes = [];
  const events = [];
  const receipts = new Map();
  let failSync = false;
  const user = { id: 7, timezone: timeZone, weight_unit: 'KG', date_of_birth: new Date('1990-01-01'),
    sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', height_unit: 'CM' };
  const stub = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => { events.push('lock'); await onLock?.(); return 1; },
    user: { findUnique: async () => user },
    goal: {
      findFirst: async ({ where }) => { assert.equal(where.user_id, 7); events.push('read-goal'); return goal; },
      findUniqueOrThrow: async ({ where }) => { assert.equal(where.id, goal.id); return goal; },
      update: async ({ where, data }) => {
        assert.equal(where.id, goal.id);
        goal = { ...goal, ...data };
        return goal;
      }
    },
    bodyMetric: {
      findUnique: async () => { events.push('read-metric'); return metric; },
      findFirst: async () => metric,
      findMany: async () => metric ? [metric] : [],
      upsert: async ({ create, update }) => {
        metric = metric ? { ...metric, ...update } : { id: 12, ...create };
        return metric;
      },
      update: async ({ data }) => { metric = { ...metric, ...data }; return metric; }
    },
    syncChange: { create: async ({ data }) => {
      if (failSync) throw new Error('Synthetic sync write failure');
      changes.push(data); return { id: BigInt(changes.length) };
    } },
    clientOperation: {
      create: async ({ data }) => {
        if (receipts.has(data.operation_id)) {
          const { Prisma } = require('@prisma/client');
          throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
        }
        receipts.set(data.operation_id, { ...data, response_status: null, completed_at: null });
      },
      update: async ({ where, data }) => {
        const id = where.user_id_operation_id.operation_id;
        receipts.set(id, { ...receipts.get(id), ...data });
      },
      findUnique: async ({ where }) => receipts.get(where.user_id_operation_id.operation_id)
    }
  };
  // Model transaction rollback while using the real route and idempotency implementation.
  stub.$transaction = async callback => {
    const before = { goal: structuredClone(goal), metric: structuredClone(metric), changes: changes.length, receipts: new Map(receipts) };
    try {
      return await callback({
        ...stub, $queryRaw: async () => [],
        caloriePlanRevision: { findFirst: async () => null, findMany: async () => [], updateMany: async () => ({ count: 0 }) },
        calibrationRecommendation: { updateMany: async () => ({ count: 0 }) }
      });
    } catch (error) {
      goal = before.goal; metric = before.metric; changes.length = before.changes;
      receipts.clear(); before.receipts.forEach((value, key) => receipts.set(key, value));
      throw error;
    }
  };
  const handler = getRouteHandler(loadMetricsRouter(stub), 'post', '/');
  return { get goal() { return goal; }, get metric() { return metric; }, user, changes, events,
    startNewGoal() { goal = { ...goal, id: goal.id + 1, created_at: new Date() }; },
    failNextSync() { failSync = true; },
    async save(body, overrides = {}, operationId) {
      const res = createRes();
      await handler({ user: { ...user, ...overrides }, body, headers: operationId ? { 'x-client-operation-id': operationId } : {} }, res);
      return res;
    }
  };
}

test('metrics baseline: same-day first weight and correction preserve the goal and synchronize its baseline', async () => {
  const fixture = baselineFixture();
  const original = { ...fixture.goal };
  const first = await fixture.save({ weight: 85.123 });
  assert.equal(first.statusCode, 200);
  assert.equal(fixture.goal.start_weight_grams, 85100);
  assert.deepEqual(fixture.goal, { ...original, start_weight_grams: 85100 });
  assert.equal(first.body.progress_update.goal.current_progress_percent, 0);
  assert.ok(fixture.events.indexOf('lock') < fixture.events.indexOf('read-metric'));
  const correction = await fixture.save({ weight: 86.125 });
  assert.equal(correction.statusCode, 200);
  assert.equal(fixture.goal.start_weight_grams, 86100);
  assert.deepEqual(fixture.changes.filter(change => change.entity_type === 'goal').map(change => change.payload.start_weight_grams), [85100, 86100]);
  await fixture.save({ body_fat_percent: 18 });
  assert.equal(fixture.goal.start_weight_grams, 86100);
  assert.equal(fixture.changes.filter(change => change.entity_type === 'goal').length, 2);
});

test('metrics baseline: an older goal or historical metric never changes the baseline', async () => {
  const yesterday = addUtcDays(getUtcTodayDateOnly(), -1);
  const older = baselineFixture({ goalDate: yesterday });
  assert.equal((await older.save({ weight: 85 })).statusCode, 200);
  assert.equal(older.goal.start_weight_grams, 90000);
  const historical = baselineFixture();
  assert.equal((await historical.save({ weight: 85, date: formatDateOnly(yesterday) })).statusCode, 200);
  assert.equal(historical.goal.start_weight_grams, 90000);
});

test('metrics baseline: uses the account day rather than UTC and preserves canonical pounds precision', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:59:00Z') });
  const fixture = baselineFixture({ goalDate: new Date('2026-10-08T19:00:00Z'), timeZone: 'America/Los_Angeles' });
  const res = await fixture.save({ weight: 180.125, date: '2026-10-08' }, { weight_unit: 'LB' });
  assert.equal(res.statusCode, 200);
  assert.equal(fixture.goal.start_weight_grams, fixture.metric.weight_grams);
  assert.equal(fixture.goal.start_weight_grams, 81692);
  assert.equal(res.body.progress_update.is_current_day, true);
});

test('metrics baseline: late first replay preserves history; committed retry cannot overwrite a newer correction', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:59:00Z') });
  const fixture = baselineFixture({ goalDate: new Date('2026-10-08T19:00:00Z'), timeZone: 'America/Los_Angeles' });
  const body = { weight: 85, date: '2026-10-08' };
  const first = await fixture.save(body, {}, 'baseline-operation-1');
  assert.equal(first.statusCode, 200);
  await fixture.save({ ...body, weight: 86 }, {}, 'baseline-operation-2');
  t.mock.timers.setTime(new Date('2026-10-09T07:01:00Z').getTime());
  const retry = await fixture.save(body, {}, 'baseline-operation-1');
  assert.deepEqual(retry.body, first.body);
  assert.equal(fixture.goal.start_weight_grams, 86000);
  assert.equal(fixture.metric.weight_grams, 86000);
  const late = await fixture.save({ ...body, weight: 87 }, {}, 'baseline-operation-3');
  assert.equal(late.statusCode, 200);
  assert.equal(fixture.metric.weight_grams, 87000);
  assert.equal(fixture.goal.start_weight_grams, 86000);
  assert.equal(fixture.changes.filter(change => change.entity_type === 'goal').length, 2);
});

test('metrics baseline: evaluates eligibility after waiting for the planning lock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T23:59:00Z') });
  const fixture = baselineFixture({ onLock: () => t.mock.timers.setTime(new Date('2026-10-09T00:01:00Z').getTime()) });
  assert.equal((await fixture.save({ weight: 85, date: '2026-10-08' })).statusCode, 200);
  assert.equal(fixture.goal.start_weight_grams, 90000);
});

test('metrics baseline: a sync failure rolls back metric, goal and operation receipt together', async () => {
  const fixture = baselineFixture();
  fixture.failNextSync();
  const res = await fixture.save({ weight: 85 }, {}, 'baseline-rollback-1');
  assert.equal(res.statusCode, 500);
  assert.equal(fixture.goal.start_weight_grams, 90000);
  assert.equal(fixture.metric, null);
  assert.deepEqual(fixture.changes, []);
});

test('metrics baseline: timezone committed while waiting determines eligibility and default date', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:59:00Z') });
  const fixture = baselineFixture({ goalDate: new Date('2026-10-08T19:00:00Z'), timeZone: 'America/Los_Angeles',
    onLock: () => { fixture.user.timezone = 'UTC'; } });
  assert.equal((await fixture.save({ weight: 85, date: '2026-10-08' })).statusCode, 200);
  assert.equal(fixture.goal.start_weight_grams, 90000);
  const implicit = baselineFixture({ goalDate: new Date('2026-10-08T19:00:00Z'), timeZone: 'America/Los_Angeles',
    onLock: () => { implicit.user.timezone = 'UTC'; } });
  assert.equal((await implicit.save({ weight: 85 })).statusCode, 200);
  assert.equal(implicit.metric.date.toISOString().slice(0, 10), '2026-10-09');
  assert.equal(implicit.goal.start_weight_grams, 90000);
});

test('metrics baseline: reads the goal created by a writer that held the planning guard first', async () => {
  let firstLock = true;
  const fixture = baselineFixture({ goalDate: addUtcDays(getUtcTodayDateOnly(), -3), onLock: () => {
    if (firstLock) { firstLock = false; fixture.startNewGoal(); }
  } });
  assert.equal((await fixture.save({ weight: 85 })).statusCode, 200);
  assert.equal(fixture.goal.id, 47);
  assert.equal(fixture.goal.start_weight_grams, 85000);
  assert.equal(fixture.changes.find(change => change.entity_type === 'goal').entity_id, '47');
});

test('metrics baseline: weight-first baseline is unchanged and unsafe correction synchronizes final safety state', async () => {
  const fixture = baselineFixture({ initialWeight: 85000 });
  assert.equal((await fixture.save({ weight: 85 })).statusCode, 200);
  assert.equal(fixture.changes.filter(change => change.entity_type === 'goal').length, 0);
  const correction = await fixture.save({ weight: 70 });
  assert.equal(correction.statusCode, 200);
  assert.equal(fixture.goal.start_weight_grams, 70000);
  assert.equal(fixture.goal.target_weight_grams, 75000);
  assert.equal(fixture.goal.daily_deficit, 500);
  assert.equal(fixture.goal.calorie_plan_review_status, 'REQUIRES_REVIEW');
  assert.equal(fixture.changes.find(change => change.entity_type === 'goal').payload.calorie_plan_review_status, 'REQUIRES_REVIEW');
  assert.equal('progress_update' in correction.body, false);
});

test('metrics route: rejects unauthenticated requests via router.use middleware', async () => {
  const prismaStub = { bodyMetric: {} };
  const router = loadMetricsRouter(prismaStub);
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

test('metrics route: GET / validates start/end query params when provided', async () => {
  const prismaStub = {
    bodyMetric: {
      findMany: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    query: { start: 'not-a-date' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid date range' });

  const impossibleDateRes = createRes();
  await handler(
    {
      user: { id: 7, weight_unit: 'KG' },
      query: { start: '2025-02-31' }
    },
    impossibleDateRes
  );
  assert.equal(impossibleDateRes.statusCode, 400);
  assert.deepEqual(impossibleDateRes.body, { message: 'Invalid date range' });
});

test('metrics route: GET / validates include_trend query values', async () => {
  const prismaStub = {
    bodyMetric: {
      findMany: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    query: { include_trend: 'maybe' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid include_trend option' });
});

test('metrics route: GET / validates range query values', async () => {
  const prismaStub = {
    bodyMetric: {
      findMany: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    query: { range: 'quarter' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid range option' });
});

test('metrics route: GET / uses inclusive comparison endpoints for relative ranges', async () => {
  const today = getUtcTodayDateOnly();
  const cases = [
    {
      range: 'week',
      includedDate: addUtcDays(today, -7)
    },
    {
      range: 'month',
      includedDate: addUtcDays(today, -28)
    },
    {
      range: 'year',
      includedDate: addUtcYearsClamped(today, -1)
    }
  ];

  for (const rangeCase of cases) {
    const rows = [
      addUtcDays(rangeCase.includedDate, -1),
      rangeCase.includedDate,
      today,
      addUtcDays(today, 1)
    ].map((date, index) => ({
      id: index + 1,
      user_id: 7,
      date,
      weight_grams: 80000 + index,
      body_fat_percent: null
    }));
    const router = loadMetricsRouter({
      bodyMetric: {
        findMany: async () => rows
      }
    });
    const handler = getRouteHandler(router, 'get', '/');
    const res = createRes();

    await handler({
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      query: { range: rangeCase.range }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.map((metric) => metric.date.toISOString().slice(0, 10)),
      [formatDateOnly(today), formatDateOnly(rangeCase.includedDate)],
      `${rangeCase.range} should include its comparison endpoint`
    );
  }
});

test('metrics route: GET / anchors a relative trend range to an explicit historical end date', async () => {
  const endDate = new Date('2025-02-28T00:00:00Z');
  const includedDate = addUtcDays(endDate, -28);
  const rows = [
    addUtcDays(includedDate, -1),
    includedDate,
    endDate,
    addUtcDays(endDate, 1)
  ].map((date, index) => ({
    id: index + 1,
    user_id: 7,
    date,
    weight_grams: 80000 + index,
    body_fat_percent: null,
    trend: {
      trend_weight_grams: 80000 + index,
      trend_ci_lower_grams: 79800 + index,
      trend_ci_upper_grams: 80200 + index,
      trend_std_grams: 100
    }
  }));
  const router = loadMetricsRouter({
    bodyMetric: {
      findFirst: async () => null,
      findMany: async () => rows
    }
  });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: {
      include_trend: 'true',
      range: 'month',
      end: formatDateOnly(endDate)
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.metrics.map((metric) => metric.date.toISOString().slice(0, 10)),
    [formatDateOnly(endDate), formatDateOnly(includedDate)]
  );
});

test('metrics route: GET / returns metrics with weight converted to the user unit', async () => {
  const rows = [
    {
      id: 2,
      user_id: 7,
      date: new Date('2025-01-01T00:00:00Z'),
      weight_grams: 1000,
      body_fat_percent: 20.5
    },
    {
      id: 1,
      user_id: 7,
      date: new Date('2025-01-02T00:00:00Z'),
      weight_grams: 68039,
      body_fat_percent: null
    }
  ];

  const prismaStub = {
    bodyMetric: {
      findFirst: async () => null,
      findMany: async () => rows
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'LB' },
    query: {}
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  // Query order is ascending; response should remain newest-first.
  assert.deepEqual(res.body, [
    {
      id: 1,
      user_id: 7,
      date: rows[1].date,
      body_fat_percent: null,
      weight: 150
    },
    {
      id: 2,
      user_id: 7,
      date: rows[0].date,
      body_fat_percent: 20.5,
      weight: 2.2
    }
  ]);
});

test('metrics route: GET / returns trend-augmented payload when include_trend=true', async () => {
  const rows = [
    {
      id: 1,
      user_id: 7,
      date: new Date('2025-01-01T00:00:00Z'),
      weight_grams: 80000,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80000,
        trend_ci_lower_grams: 79600,
        trend_ci_upper_grams: 80400,
        trend_std_grams: 200
      }
    },
    {
      id: 2,
      user_id: 7,
      date: new Date('2025-01-02T00:00:00Z'),
      weight_grams: 79800,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 79850,
        trend_ci_lower_grams: 79450,
        trend_ci_upper_grams: 80250,
        trend_std_grams: 200
      }
    },
    {
      id: 3,
      user_id: 7,
      date: new Date('2025-01-03T00:00:00Z'),
      weight_grams: 79600,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 79700,
        trend_ci_lower_grams: 79300,
        trend_ci_upper_grams: 80100,
        trend_std_grams: 200
      }
    }
  ];

  const prismaStub = {
    bodyMetric: {
      findFirst: async () => null,
      findMany: async () => rows
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    query: { include_trend: 'true', range: 'all' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(Array.isArray(res.body.metrics), true);
  assert.equal(res.body.metrics.length, 3);
  assert.deepEqual(res.body.meta.total_points, 3);
  assert.equal(typeof res.body.meta.weekly_rate, 'number');
  assert.equal(typeof res.body.meta.total_span_days, 'number');
  assert.ok(['low', 'medium', 'high'].includes(res.body.meta.volatility));

  const newest = res.body.metrics[0];
  assert.equal(typeof newest.weight, 'number');
  assert.equal(newest.trend_is_materialized, true);
  assert.equal(typeof newest.trend_weight, 'number');
  assert.equal(typeof newest.trend_ci_lower, 'number');
  assert.equal(typeof newest.trend_ci_upper, 'number');
  assert.equal(typeof newest.trend_std, 'number');
});

test('metrics route: GET / adds scoped v2 evidence and freshness metadata', async () => {
  const today = getUtcTodayDateOnly();
  const rows = Array.from({ length: 10 }, (_unused, index) => {
    const date = addUtcDays(today, index - 9);
    const weightGrams = 81000 - index * 80;
    return {
      id: index + 1,
      user_id: 7,
      date,
      weight_grams: weightGrams,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: weightGrams,
        trend_ci_lower_grams: weightGrams - 250,
        trend_ci_upper_grams: weightGrams + 250,
        trend_std_grams: 125,
        trend_rate_grams_per_day: -80,
        trend_rate_std_grams_per_day: 15,
        model_version: 2
      }
    };
  });
  const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: { include_trend: 'true', range: 'month' }
  }, res);

  assert.equal(res.statusCode, 200);
  const summary = res.body.meta.trend_summary;
  assert.equal(summary.model_version, 2);
  assert.equal(summary.as_of_date, formatDateOnly(today));
  assert.equal(summary.scope_start_date, formatDateOnly(rows[0].date));
  assert.equal(summary.scope_end_date, formatDateOnly(today));
  assert.equal(summary.latest_observation_date, formatDateOnly(today));
  assert.equal(summary.days_since_latest, 0);
  assert.equal(summary.modeled_start_date, formatDateOnly(addUtcDays(today, -119)));
  assert.equal(summary.returned_points, 10);
  assert.equal(summary.evidence, 'sufficient');
  assert.equal(summary.freshness, 'current');
  assert.equal(summary.status, 'sufficient');
  assert.equal(summary.modeled_observations, 10);
  assert.equal(summary.returned_modeled_points, 10);
  assert.equal(summary.modeled_points, 10, 'legacy count aliases returned modeled points');
  assert.equal(summary.observation_span_days, 9);
  assert.equal(summary.segment_start_date, formatDateOnly(rows[0].date));
  assert.equal(summary.interval_kind, 'latent_weight_model_uncertainty');
  assert.equal(summary.confidence_level, 0.95);
  assert.ok(summary.latest_trend);
  assert.ok(summary.weekly_rate);
  const expectedCurrentRate = computeWeightTrend(rows.map((row) => ({
    date: row.date,
    weight: row.weight_grams / 1000
  }))).currentRate;
  assertNearlyEqual(summary.weekly_rate.estimate, expectedCurrentRate.estimateKgPerWeek);
  assertNearlyEqual(summary.weekly_rate.std, expectedCurrentRate.stdKgPerWeek);
  assertNearlyEqual(summary.weekly_rate.lower, expectedCurrentRate.lower95KgPerWeek);
  assertNearlyEqual(summary.weekly_rate.upper, expectedCurrentRate.upper95KgPerWeek);
  assert.equal(summary.weekly_rate.point_count, 10);
  assert.equal(summary.weekly_rate.span_days, 9);
  assert.equal(summary.weekly_rate.evidence, 'sufficient');
  assert.equal(summary.weekly_rate.interval_kind, 'local_velocity_state_model_uncertainty');
  assert.ok(summary.short_term_variation.standard_deviation > 0);
  assert.equal(res.body.metrics[res.body.metrics.length - 1].trend_segment_start, true);
});

test('metrics route: GET / derives point bands and summary from one raw source revision', async () => {
  const today = getUtcTodayDateOnly();
  const rows = Array.from({ length: 10 }, (_unused, index) => ({
    id: index + 1,
    user_id: 7,
    date: addUtcDays(today, index - 9),
    weight_grams: 81000 - index * 100,
    body_fat_percent: null,
    // Simulate stored materialization from an incompatible source revision.
    trend: {
      trend_weight_grams: 200000 + index * 1000,
      trend_ci_lower_grams: 199000 + index * 1000,
      trend_ci_upper_grams: 201000 + index * 1000,
      trend_std_grams: 500,
      trend_rate_grams_per_day: 1000,
      trend_rate_std_grams_per_day: 500,
      model_version: 2
    }
  }));
  const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: { include_trend: 'true', range: 'all' }
  }, res);

  const expected = computeWeightTrend(rows.map((row) => ({
    date: row.date,
    weight: row.weight_grams / 1000
  })));
  const newest = res.body.metrics[0];
  assert.equal(res.statusCode, 200);
  assert.equal(newest.trend_weight, Math.round(expected.points.at(-1).trendWeight * 1000) / 1000);
  assertNearlyEqual(res.body.meta.trend_summary.latest_trend.weight, expected.points.at(-1).trendWeight);
  assert.ok(newest.trend_weight < 100, 'stored revision A must not leak into raw revision B');
  assert.equal(res.body.meta.trend_summary.modeled_observations, rows.length);
  assert.equal(res.body.meta.trend_summary.returned_modeled_points, rows.length);
});

test('metrics route: GET / preserves raw measurements and marks trend unavailable after refresh failure', async () => {
  const today = getUtcTodayDateOnly();
  const rows = [
    {
      id: 1,
      user_id: 7,
      date: addUtcDays(today, -1),
      weight_grams: 80100,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 150000,
        trend_ci_lower_grams: 149000,
        trend_ci_upper_grams: 151000,
        trend_std_grams: 500,
        trend_rate_grams_per_day: 1000,
        trend_rate_std_grams_per_day: 500,
        model_version: 2
      }
    },
    {
      id: 2,
      user_id: 7,
      date: today,
      weight_grams: 80000,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 149000,
        trend_ci_lower_grams: 148000,
        trend_ci_upper_grams: 150000,
        trend_std_grams: 500,
        trend_rate_grams_per_day: 1000,
        trend_rate_std_grams_per_day: 500,
        model_version: 2
      }
    }
  ];
  const sourceRevision = computeWeightTrendSourceRevision(rows);
  for (const row of rows) {
    if (row.trend) row.trend.source_revision = sourceRevision;
  }
  const router = loadMetricsRouter({
    bodyMetric: {
      findFirst: async () => { throw new Error('simulated refresh failure'); },
      findMany: async () => rows
    }
  });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    await handler({
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      query: { include_trend: 'true', range: 'all' }
    }, res);
  } finally {
    console.warn = previousWarn;
  }

  const summary = res.body.meta.trend_summary;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.metrics.map((metric) => metric.weight), [80, 80.1]);
  assert.ok(res.body.metrics.every((metric) => metric.trend_is_materialized === false));
  assert.ok(res.body.metrics.every((metric) => metric.trend_weight === metric.weight));
  assert.ok(res.body.metrics.every((metric) => metric.trend_ci_lower === metric.weight));
  assert.ok(res.body.metrics.every((metric) => metric.trend_ci_upper === metric.weight));
  assert.ok(res.body.metrics.every((metric) => metric.trend_std === 0));
  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.evidence, 'insufficient');
  assert.equal(summary.freshness, 'unavailable');
  assert.equal(summary.model_version, null);
  assert.equal(summary.latest_observation_date, formatDateOnly(today));
  assert.equal(summary.days_since_latest, 0);
  assert.equal(summary.modeled_start_date, null);
  assert.equal(summary.modeled_observations, 0);
  assert.equal(summary.returned_modeled_points, 0);
  assert.equal(summary.modeled_points, 0);
  assert.equal(summary.observation_span_days, 0);
  assert.equal(summary.segment_start_date, null);
  assert.equal(summary.latest_trend, null);
  assert.equal(summary.weekly_rate, null);
  assert.equal(summary.short_term_variation, null);
  assert.equal(res.body.meta.weekly_rate, -7);
  assert.equal(res.body.meta.volatility, 'low');
});

test('metrics route: GET / degrades after a same-day source edit when read-time refitting still fails', async () => {
  const today = getUtcTodayDateOnly();
  const oldMetric = {
    id: 1,
    user_id: 7,
    date: today,
    weight_grams: 80000
  };
  const oldRevision = computeWeightTrendSourceRevision([oldMetric]);
  const rows = [{
    ...oldMetric,
    weight_grams: 81234,
    body_fat_percent: null,
    trend: {
      trend_weight_grams: 79000,
      trend_ci_lower_grams: 78500,
      trend_ci_upper_grams: 79500,
      trend_std_grams: 250,
      trend_rate_grams_per_day: -100,
      trend_rate_std_grams_per_day: 50,
      model_version: 2,
      source_revision: oldRevision
    }
  }];
  const updatedRevision = computeWeightTrendSourceRevision(rows);
  let modelWindowReads = 0;
  const router = loadMetricsRouter({
    bodyMetric: {
      findFirst: async (args) => (
        args.where.OR ? { id: rows[0].id } : { date: today }
      ),
      findMany: async () => {
        modelWindowReads += 1;
        if (modelWindowReads === 2) {
          throw new Error('persistent same-day refit failure for weight_grams=81234');
        }
        return rows;
      }
    }
  });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));

  try {
    await handler({
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      query: { include_trend: 'true', range: 'all' }
    }, res);
  } finally {
    console.warn = previousWarn;
  }

  assert.notEqual(updatedRevision, oldRevision);
  assert.equal(modelWindowReads, 3, 'ensure inspection, failed locked refit, and response snapshot are distinct reads');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics[0].weight, 81.2);
  assert.equal(res.body.metrics[0].trend_is_materialized, false);
  assert.equal(res.body.metrics[0].trend_weight, 81.2);
  assert.equal(res.body.meta.trend_summary.status, 'unavailable');
  assert.equal(res.body.meta.trend_summary.freshness, 'unavailable');
  assert.equal(res.body.meta.trend_summary.latest_trend, null);
  assert.equal(res.body.meta.trend_summary.weekly_rate, null);
  assert.equal(res.body.meta.weekly_rate, 0, 'stale same-date LKG metadata must not be reused');
  assert.equal(res.body.meta.volatility, 'low');
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.every((warning) => !warning.includes('81234') && !warning.includes('weight_grams')));
});

test('metrics route: GET / catches a fitting race and still returns raw measurements', async () => {
  const today = getUtcTodayDateOnly();
  let weightReads = 0;
  const row = {
    id: 1,
    user_id: 7,
    date: today,
    body_fat_percent: null,
    trend: null,
    get weight_grams() {
      weightReads += 1;
      if (weightReads === 2) throw new Error('simulated fitting race for weight_grams=80000');
      return 80000;
    }
  };
  const router = loadMetricsRouter({
    bodyMetric: {
      findFirst: async () => null,
      findMany: async () => [row]
    }
  });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));

  try {
    await handler({
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      query: { include_trend: 'true', range: 'all' }
    }, res);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics[0].weight, 80);
  assert.equal(res.body.metrics[0].trend_is_materialized, false);
  assert.equal(res.body.meta.trend_summary.status, 'unavailable');
  assert.equal(res.body.meta.trend_summary.weekly_rate, null);
  assert.deepEqual(warnings, [
    'Unable to fit the requested weight trend snapshot. Returning raw measurements with trend status unavailable.'
  ]);
});

test('metrics route: GET / keeps legacy fallback when last-known-good trends do not cover newest raw data', async () => {
  const today = getUtcTodayDateOnly();
  const rows = [
    {
      id: 1,
      user_id: 7,
      date: addUtcDays(today, -1),
      weight_grams: 80100,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80100,
        trend_ci_lower_grams: 79600,
        trend_ci_upper_grams: 80600,
        trend_std_grams: 250,
        trend_rate_grams_per_day: -100,
        trend_rate_std_grams_per_day: 50,
        model_version: 2
      }
    },
    {
      id: 2,
      user_id: 7,
      date: today,
      weight_grams: 80000,
      body_fat_percent: null,
      trend: null
    }
  ];
  const sourceRevision = computeWeightTrendSourceRevision(rows);
  for (const row of rows) {
    if (row.trend) row.trend.source_revision = sourceRevision;
  }
  const router = loadMetricsRouter({
    bodyMetric: {
      findFirst: async () => { throw new Error('simulated refresh failure'); },
      findMany: async () => rows
    }
  });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    await handler({
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      query: { include_trend: 'true', range: 'all' }
    }, res);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.meta.trend_summary.status, 'unavailable');
  assert.equal(res.body.meta.trend_summary.latest_trend, null);
  assert.equal(res.body.meta.trend_summary.weekly_rate, null);
  assert.ok(res.body.metrics.every((metric) => metric.trend_is_materialized === false));
  assert.equal(res.body.meta.weekly_rate, 0);
  assert.equal(res.body.meta.volatility, 'low');
});

test('metrics route: GET / excludes future rows and suppresses outdated pace', async () => {
  const today = getUtcTodayDateOnly();
  const oldEnd = addUtcDays(today, -20);
  const rows = [
    ...Array.from({ length: 5 }, (_unused, index) => ({
      id: index + 1,
      user_id: 7,
      date: addUtcDays(oldEnd, index - 4),
      weight_grams: 80000 - index * 50,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80000 - index * 50,
        trend_ci_lower_grams: 79750 - index * 50,
        trend_ci_upper_grams: 80250 - index * 50,
        trend_std_grams: 125,
        trend_rate_grams_per_day: -50,
        trend_rate_std_grams_per_day: 20,
        model_version: 2
      }
    })),
    {
      id: 99,
      user_id: 7,
      date: addUtcDays(today, 1),
      weight_grams: 120000,
      body_fat_percent: null,
      trend: null
    }
  ];
  const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: { include_trend: 'true', range: 'all' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics.some((metric) => metric.id === 99), false);
  assert.equal(res.body.meta.total_points, 5);
  assert.equal(res.body.meta.trend_summary.freshness, 'outdated');
  assert.equal(res.body.meta.trend_summary.status, 'stale');
  assert.equal(res.body.meta.trend_summary.weekly_rate, null);
});

test('metrics route: GET / applies current, stale, and outdated freshness boundaries', async () => {
  const today = getUtcTodayDateOnly();
  const cases = [
    { ageDays: 7, freshness: 'current', hasRate: true },
    { ageDays: 8, freshness: 'stale', hasRate: true },
    { ageDays: 14, freshness: 'stale', hasRate: true },
    { ageDays: 15, freshness: 'outdated', hasRate: false }
  ];

  for (const freshnessCase of cases) {
    const latestDate = addUtcDays(today, -freshnessCase.ageDays);
    const rows = Array.from({ length: 8 }, (_unused, index) => {
      const weightGrams = 80000 - index * 60;
      return {
        id: index + 1,
        user_id: 7,
        date: addUtcDays(latestDate, index - 7),
        weight_grams: weightGrams,
        body_fat_percent: null,
        trend: {
          trend_weight_grams: weightGrams,
          trend_ci_lower_grams: weightGrams - 250,
          trend_ci_upper_grams: weightGrams + 250,
          trend_std_grams: 125,
          trend_rate_grams_per_day: -60,
          trend_rate_std_grams_per_day: 15,
          model_version: 2
        }
      };
    });
    const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
    const handler = getRouteHandler(router, 'get', '/');
    const res = createRes();

    await handler({
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      query: { include_trend: 'true', range: 'all' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.trend_summary.days_since_latest, freshnessCase.ageDays);
    assert.equal(res.body.meta.trend_summary.freshness, freshnessCase.freshness);
    assert.equal(Boolean(res.body.meta.trend_summary.weekly_rate), freshnessCase.hasRate);
  }
});

test('metrics route: GET / keeps stale as-of metadata when a narrow range has no returned weigh-ins', async () => {
  const today = getUtcTodayDateOnly();
  const latestDate = addUtcDays(today, -8);
  const rows = Array.from({ length: 8 }, (_unused, index) => {
    const weightGrams = 80000 - index * 60;
    return {
      id: index + 1,
      user_id: 7,
      date: addUtcDays(latestDate, index - 7),
      weight_grams: weightGrams,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: weightGrams,
        trend_ci_lower_grams: weightGrams - 250,
        trend_ci_upper_grams: weightGrams + 250,
        trend_std_grams: 125,
        trend_rate_grams_per_day: -60,
        trend_rate_std_grams_per_day: 15,
        model_version: 2
      }
    };
  });
  const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: { include_trend: 'true', range: 'week' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics.length, 0);
  assert.equal(res.body.meta.trend_summary.returned_points, 0);
  assert.equal(res.body.meta.trend_summary.modeled_observations, 8);
  assert.equal(res.body.meta.trend_summary.returned_modeled_points, 0);
  assert.equal(res.body.meta.trend_summary.modeled_points, 0);
  assert.equal(res.body.meta.trend_summary.latest_observation_date, formatDateOnly(latestDate));
  assert.equal(res.body.meta.trend_summary.days_since_latest, 8);
  assert.equal(res.body.meta.trend_summary.freshness, 'stale');
  assert.ok(res.body.meta.trend_summary.latest_trend);
  assert.ok(res.body.meta.trend_summary.weekly_rate);
});

test('metrics route: GET / recomputes a bounded historical trend as of the requested end date', async () => {
  const start = new Date('2025-02-01T00:00:00Z');
  const historicalEnd = addUtcDays(start, 9);
  const rows = Array.from({ length: 20 }, (_unused, index) => ({
    id: index + 1,
    user_id: 7,
    date: addUtcDays(start, index),
    weight_grams: 90000 - index * 100,
    body_fat_percent: null,
    // Deliberately invalid current materialization: historical reads must not reuse it.
    trend: {
      trend_weight_grams: 200000,
      trend_ci_lower_grams: 199000,
      trend_ci_upper_grams: 201000,
      trend_std_grams: 500,
      trend_rate_grams_per_day: null,
      trend_rate_std_grams_per_day: null,
      model_version: 2
    }
  }));
  const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: { include_trend: 'true', range: 'all', end: formatDateOnly(historicalEnd) }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics.length, 10);
  assert.equal(formatDateOnly(res.body.metrics[0].date), formatDateOnly(historicalEnd));
  assert.ok(res.body.metrics[0].trend_weight < 100, 'historical trend should be recomputed from bounded raw history');
  assert.equal(res.body.meta.total_points, 10);
  assert.equal(res.body.meta.trend_summary.as_of_date, formatDateOnly(historicalEnd));
  assert.equal(res.body.meta.trend_summary.latest_observation_date, formatDateOnly(historicalEnd));
  assert.equal(res.body.meta.trend_summary.freshness, 'current');
  assert.equal(res.body.meta.trend_summary.modeled_observations, 10);
  assert.equal(res.body.meta.trend_summary.returned_modeled_points, 10);
  assert.equal(res.body.meta.trend_summary.modeled_points, 10);
  assert.equal(res.body.meta.trend_summary.returned_points, 10);
  assert.equal(res.body.meta.trend_summary.observation_span_days, 9);
});

test('metrics route: GET / legacy weekly rate ignores a pre-gap reversal', async () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const beforeGap = Array.from({ length: 14 }, (_unused, index) => ({
    id: index + 1,
    user_id: 7,
    date: addUtcDays(start, index),
    weight_grams: 80000 + index * 200,
    body_fat_percent: null,
    trend: null
  }));
  const afterGapStart = addUtcDays(start, 29);
  const afterGap = Array.from({ length: 8 }, (_unused, index) => ({
    id: index + 15,
    user_id: 7,
    date: addUtcDays(afterGapStart, index),
    weight_grams: 83000 - index * 200,
    body_fat_percent: null,
    trend: null
  }));
  const rows = [...beforeGap, ...afterGap];
  const end = rows.at(-1).date;
  const router = loadMetricsRouter({ bodyMetric: { findMany: async () => rows } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    query: { include_trend: 'true', range: 'all', end: formatDateOnly(end) }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.meta.weekly_rate < 0, 'pre-gap gain must not invert post-gap legacy pace');
  assert.equal(res.body.meta.trend_summary.modeled_observations, rows.length);
  assert.equal(res.body.metrics.filter((metric) => metric.trend_segment_start).length, 2);
});
test('metrics route: GET / trend payload stays unit-invariant across KG and LB preferences', async () => {
  const rows = [
    {
      id: 1,
      user_id: 7,
      date: new Date('2025-01-01T00:00:00Z'),
      weight_grams: 81200,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 81200,
        trend_ci_lower_grams: 80950,
        trend_ci_upper_grams: 81450,
        trend_std_grams: 125
      }
    },
    {
      id: 2,
      user_id: 7,
      date: new Date('2025-01-03T00:00:00Z'),
      weight_grams: 80850,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80950,
        trend_ci_lower_grams: 80650,
        trend_ci_upper_grams: 81250,
        trend_std_grams: 150
      }
    },
    {
      id: 3,
      user_id: 7,
      date: new Date('2025-01-06T00:00:00Z'),
      weight_grams: 80650,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80720,
        trend_ci_lower_grams: 80350,
        trend_ci_upper_grams: 81090,
        trend_std_grams: 185
      }
    },
    {
      id: 4,
      user_id: 7,
      date: new Date('2025-01-10T00:00:00Z'),
      weight_grams: 80400,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80500,
        trend_ci_lower_grams: 80100,
        trend_ci_upper_grams: 80900,
        trend_std_grams: 200
      }
    }
  ];

  const prismaStub = {
    bodyMetric: {
      findFirst: async () => null,
      findMany: async () => rows
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const kgReq = {
    user: { id: 7, weight_unit: 'KG' },
    query: { include_trend: 'true', range: 'all', end: '2025-01-10' }
  };
  const kgRes = createRes();
  await handler(kgReq, kgRes);
  assert.equal(kgRes.statusCode, 200);

  const lbReq = {
    user: { id: 7, weight_unit: 'LB' },
    query: { include_trend: 'true', range: 'all', end: '2025-01-10' }
  };
  const lbRes = createRes();
  await handler(lbReq, lbRes);
  assert.equal(lbRes.statusCode, 200);

  assert.equal(lbRes.body.metrics.length, kgRes.body.metrics.length);
  assert.equal(lbRes.body.meta.total_points, kgRes.body.meta.total_points);
  assert.equal(lbRes.body.meta.total_span_days, kgRes.body.meta.total_span_days);
  assert.equal(lbRes.body.meta.volatility, kgRes.body.meta.volatility);
  assertNearlyEqual(lbRes.body.meta.weekly_rate, kgRes.body.meta.weekly_rate * POUNDS_PER_KILOGRAM);
  assertNearlyEqual(
    lbRes.body.meta.trend_summary.weekly_rate.estimate,
    kgRes.body.meta.trend_summary.weekly_rate.estimate * POUNDS_PER_KILOGRAM
  );
  assertNearlyEqual(
    lbRes.body.meta.trend_summary.weekly_rate.std,
    kgRes.body.meta.trend_summary.weekly_rate.std * POUNDS_PER_KILOGRAM
  );

  for (let i = 0; i < kgRes.body.metrics.length; i += 1) {
    const kgMetric = kgRes.body.metrics[i];
    const lbMetric = lbRes.body.metrics[i];

    assert.equal(lbMetric.id, kgMetric.id);
    assert.equal(lbMetric.date.getTime(), kgMetric.date.getTime());
    assertNearlyEqual(lbMetric.trend_weight, kgMetric.trend_weight * POUNDS_PER_KILOGRAM);
    assertNearlyEqual(lbMetric.trend_ci_lower, kgMetric.trend_ci_lower * POUNDS_PER_KILOGRAM);
    assertNearlyEqual(lbMetric.trend_ci_upper, kgMetric.trend_ci_upper * POUNDS_PER_KILOGRAM);
    assertNearlyEqual(lbMetric.trend_std, kgMetric.trend_std * POUNDS_PER_KILOGRAM);
  }
});

test('metrics route: GET / ignores trend rows older than the active trend horizon', async () => {
  const oldDate = new Date('2024-01-01T00:00:00Z');
  const latestDate = new Date('2025-01-10T00:00:00Z');
  const rows = [
    {
      id: 1,
      user_id: 7,
      date: oldDate,
      weight_grams: 92000,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 88000,
        trend_ci_lower_grams: 87500,
        trend_ci_upper_grams: 88500,
        trend_std_grams: 250
      }
    },
    {
      id: 2,
      user_id: 7,
      date: latestDate,
      weight_grams: 80500,
      body_fat_percent: null,
      trend: {
        trend_weight_grams: 80450,
        trend_ci_lower_grams: 80100,
        trend_ci_upper_grams: 80800,
        trend_std_grams: 180
      }
    }
  ];

  const prismaStub = {
    bodyMetric: {
      findFirst: async () => null,
      findMany: async () => rows
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    query: { include_trend: 'true', range: 'all' }
  };
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.metrics.length, 2);
  // Response is newest-first, so the old point is index 1.
  const oldMetric = res.body.metrics[1];
  assert.equal(oldMetric.date.getTime(), oldDate.getTime());
  assert.equal(oldMetric.trend_is_materialized, false);
  assert.equal(oldMetric.trend_weight, oldMetric.weight);
  assert.equal(oldMetric.trend_ci_lower, oldMetric.weight);
  assert.equal(oldMetric.trend_ci_upper, oldMetric.weight);
  assert.equal(oldMetric.trend_std, 0);

  const newestMetric = res.body.metrics[0];
  assert.equal(newestMetric.date.getTime(), latestDate.getTime());
  assert.equal(newestMetric.trend_is_materialized, true);
});

test('metrics route: POST / rejects invalid date values', async () => {
  const prismaStub = { bodyMetric: {} };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    body: { date: 'bad-date', weight: 70 }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid date' });

  const impossibleDateRes = createRes();
  await handler(
    {
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      body: { date: '2025-02-31', weight: 70 }
    },
    impossibleDateRes
  );
  assert.equal(impossibleDateRes.statusCode, 400);
  assert.deepEqual(impossibleDateRes.body, { message: 'Invalid date' });
});

test('metrics route: POST / rejects future account-local weight dates', async () => {
  const prismaStub = { bodyMetric: {} };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');
  const futureDate = formatDateOnly(addUtcDays(getUtcTodayDateOnly(), 1));
  const res = createRes();

  await handler(
    {
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      body: { date: futureDate, weight: 70 }
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Weight date cannot be in the future' });
});

test('metrics route: POST / rejects malformed or out-of-range body fat percentages', async () => {
  const prismaStub = { bodyMetric: {} };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const malformedRes = createRes();
  await handler(
    {
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      body: { date: '2025-01-01', weight: 70, body_fat_percent: '12abc' }
    },
    malformedRes
  );
  assert.equal(malformedRes.statusCode, 400);
  assert.deepEqual(malformedRes.body, { message: 'Invalid body_fat_percent' });

  const outOfRangeRes = createRes();
  await handler(
    {
      user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
      body: { date: '2025-01-01', weight: 70, body_fat_percent: 101 }
    },
    outOfRangeRes
  );
  assert.equal(outOfRangeRes.statusCode, 400);
  assert.deepEqual(outOfRangeRes.body, { message: 'Invalid body_fat_percent' });
});

test('metrics route: POST / rejects empty updates', async () => {
  const prismaStub = { bodyMetric: {} };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    body: { date: '2025-01-01' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'No fields to update' });
});

test('metrics route: POST / requires weight when creating a new day via body_fat_percent-only update', async () => {
  const prismaStub = {
    bodyMetric: {
      findUnique: async () => null
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    body: { date: '2025-01-01', body_fat_percent: 20 }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Weight is required for a new day' });
});

test('metrics route: POST / updates existing metrics when weight is omitted', async () => {
  const updatedRow = {
    id: 5,
    user_id: 7,
    date: new Date('2025-01-01T00:00:00Z'),
    weight_grams: 82000,
    body_fat_percent: 18.2
  };

  const prismaStub = {
    bodyMetric: {
      findUnique: async () => ({ id: 5 }),
      update: async () => updatedRow
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG', timezone: 'UTC' },
    body: { date: '2025-01-01', body_fat_percent: 18.2 }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    id: 5,
    user_id: 7,
    date: updatedRow.date,
    body_fat_percent: 18.2,
    weight: 82
  });
});

test('metrics route: POST / upserts metrics when weight is provided', async () => {
  const upsertedRow = {
    id: 9,
    user_id: 7,
    date: new Date('2025-01-01T00:00:00Z'),
    weight_grams: 68039,
    body_fat_percent: null
  };

  const prismaStub = {
    bodyMetric: {
      upsert: async () => upsertedRow
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'LB', timezone: 'UTC' },
    body: { date: '2025-01-01', weight: 150 }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    id: upsertedRow.id,
    user_id: upsertedRow.user_id,
    date: upsertedRow.date,
    body_fat_percent: upsertedRow.body_fat_percent,
    weight: 150,
    progress_update: {
      save_kind: 'created',
      local_date: '2025-01-01',
      is_current_day: false,
      current_weight_grams: 68039,
      goal: null,
      recognitions: []
    }
  });
});

test('metrics route: POST / evaluates goal recognition from pre-save history inside the transaction', async () => {
  const today = getUtcTodayDateOnly();
  const todayKey = formatDateOnly(today);
  const priorDate = addUtcDays(today, -1);
  let historyWhere = null;
  const upsertedRow = {
    id: 12,
    user_id: 7,
    date: today,
    weight_grams: 79000,
    body_fat_percent: null
  };
  const prismaStub = {
    bodyMetric: {
      findUnique: async () => null,
      findFirst: async () => ({ id: 8, weight_grams: 79_000 }),
      findMany: async ({ where }) => {
        historyWhere = where;
        return [{ date: priorDate, weight_grams: 85000 }];
      },
      upsert: async () => upsertedRow
    },
    goal: {
      findFirst: async () => ({
        id: 4,
        user_id: 7,
        start_weight_grams: 100000,
        target_weight_grams: 80000,
        daily_deficit: 500,
        created_at: addUtcDays(today, -30),
        target_date: null,
        calorie_plan_review_status: 'CLEAR',
        calorie_plan_review_reason: null
      })
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');
  const res = createRes();

  await handler(
    { user: { id: 7, weight_unit: 'KG', timezone: 'UTC' }, body: { date: todayKey, weight: 79 } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(historyWhere, {
    user_id: 7,
    date: { gte: addUtcDays(today, -30), lte: today }
  });
  assert.deepEqual(res.body.progress_update, {
    save_kind: 'created',
    local_date: todayKey,
    is_current_day: true,
    current_weight_grams: 79000,
    goal: {
      id: 4,
      mode: 'lose',
      previous_progress_percent: 75,
      current_progress_percent: 100,
      remaining_weight_grams: 0,
      is_complete: true,
      reached_local_date: todayKey
    },
    recognitions: [{ type: 'goal_reached' }]
  });
});

test('metrics route: DELETE /:id validates ids and handles not-found deletes', async () => {
  let receivedDeleteWhere = null;
  const prismaStub = {
    bodyMetric: {
      deleteMany: async ({ where }) => {
        receivedDeleteWhere = where;
        return { count: 0 };
      }
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'delete', '/:id');

  const invalidReq = { user: { id: 7 }, params: { id: 'abc' } };
  const invalidRes = createRes();
  await handler(invalidReq, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.deepEqual(invalidRes.body, { message: 'Invalid metric id' });

  const missingReq = { user: { id: 7 }, params: { id: '123' } };
  const missingRes = createRes();
  await handler(missingReq, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.deepEqual(missingRes.body, { message: 'Metric not found' });
  assert.deepEqual(receivedDeleteWhere, { id: 123, user_id: 7 });
});

test('metrics route: DELETE /:id returns 204 when a row is deleted', async () => {
  const prismaStub = {
    bodyMetric: {
      deleteMany: async () => ({ count: 1 })
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'delete', '/:id');

  const req = { user: { id: 7 }, params: { id: '123' } };
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 204);
});

test('metrics route: POST / saves a bounded weight but suppresses an unsafe goal progress receipt and marks review', async () => {
  const today = getUtcTodayDateOnly();
  const todayKey = formatDateOnly(today);
  let goalReview = null;
  const goal = {
    id: 4, user_id: 7, start_weight_grams: 80_000, target_weight_grams: 70_000, daily_deficit: 500,
    created_at: addUtcDays(today, -30), target_date: null,
    calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
  };
  const metric = { id: 15, user_id: 7, date: today, weight_grams: 25_000, body_fat_percent: null };
  const prismaStub = {
    user: { findUnique: async () => ({
      id: 7, timezone: 'UTC', date_of_birth: new Date('1906-08-08T00:00:00.000Z'), sex: 'MALE',
      height_mm: 1_000, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM'
    }) },
    bodyMetric: {
      findUnique: async () => null,
      findFirst: async () => metric,
      findMany: async () => [],
      upsert: async () => metric
    },
    goal: {
      findFirst: async () => goal,
      update: async ({ data }) => { goalReview = data; return { ...goal, ...data }; }
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');
  const res = createRes();

  await handler({ user: { id: 7, weight_unit: 'KG', timezone: 'UTC' }, body: { date: todayKey, weight: 25 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.weight, 25);
  assert.equal('progress_update' in res.body, false);
  assert.deepEqual(goalReview, {
    calorie_plan_review_status: 'REQUIRES_REVIEW',
    calorie_plan_review_reason: 'TARGET_BELOW_MINIMUM'
  });
});

test('metrics route: DELETE /:id marks the current plan when deleting the latest weight makes it unsafe', async () => {
  let goalReview = null;
  const goal = {
    id: 4, user_id: 7, start_weight_grams: 80_000, target_weight_grams: 70_000, daily_deficit: 250,
    created_at: new Date('2026-01-01T00:00:00.000Z'), target_date: null,
    calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
  };
  const prismaStub = {
    bodyMetric: {
      deleteMany: async () => ({ count: 1 }),
      findFirst: async () => null
    },
    goal: {
      findFirst: async () => goal,
      update: async ({ data }) => { goalReview = data; return { ...goal, ...data }; }
    }
  };
  const router = loadMetricsRouter(prismaStub);
  const handler = getRouteHandler(router, 'delete', '/:id');
  const res = createRes();

  await handler({ user: { id: 7 }, params: { id: '123' } }, res);

  assert.equal(res.statusCode, 204);
  assert.deepEqual(goalReview, {
    calorie_plan_review_status: 'REQUIRES_REVIEW',
    calorie_plan_review_reason: 'LATEST_WEIGHT_REQUIRED'
  });
});
