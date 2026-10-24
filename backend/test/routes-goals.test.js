/** @file Regression coverage for routes goals: goals route: rejects unauthenticated requests via router.use middleware. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadGoalsRouter(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const goalsPath = require.resolve('../src/routes/goals');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const caloriePlanningPath = require.resolve('../src/services/caloriePlanning');

  const previousDbModule = require.cache[dbPath];
  const previousClientOperationsModule = require.cache[clientOperationsPath];
  const previousCaloriePlanningModule = require.cache[caloriePlanningPath];
  delete require.cache[goalsPath];
  delete require.cache[clientOperationsPath];
  delete require.cache[caloriePlanningPath];

  const normalizedPrismaStub = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    ...prismaStub,
    user: {
      findUnique: async () => ({
        id: 7, timezone: 'UTC', date_of_birth: new Date('1990-01-01T00:00:00.000Z'),
        sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM'
      }),
      ...(prismaStub.user ?? {})
    },
    goal: {
      findFirst: async () => null,
      ...(prismaStub.goal ?? {})
    },
    bodyMetric: {
      findFirst: async () => ({ weight_grams: 82_000 }),
      ...(prismaStub.bodyMetric ?? {})
    },
    caloriePlanRevision: {
      findFirst: async () => null,
      findMany: async () => [],
      ...(prismaStub.caloriePlanRevision ?? {})
    },
    syncChange: {
      create: async () => ({ id: 1n }),
      ...(prismaStub.syncChange ?? {})
    }
  };
  normalizedPrismaStub.$transaction ??= async (callback) => callback(normalizedPrismaStub);
  stubModule(dbPath, normalizedPrismaStub);
  const loaded = require('../src/routes/goals');

  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }

  if (previousClientOperationsModule) require.cache[clientOperationsPath] = previousClientOperationsModule;
  else delete require.cache[clientOperationsPath];
  if (previousCaloriePlanningModule) require.cache[caloriePlanningPath] = previousCaloriePlanningModule;
  else delete require.cache[caloriePlanningPath];

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

test('goals route: rejects unauthenticated requests via router.use middleware', async () => {
  const prismaStub = { goal: {} };
  const router = loadGoalsRouter(prismaStub);
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

test('goals route: GET / returns null when the user has no goal', async () => {
  let findFirstArgs = null;
  const prismaStub = {
    goal: {
      findFirst: async (args) => {
        findFirstArgs = args;
        return null;
      }
    }
  };
  const router = loadGoalsRouter(prismaStub);
  const isAuthenticated = getIsAuthenticatedMiddleware(router);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    isAuthenticated: () => true,
    user: { id: 7, weight_unit: 'KG' }
  };
  const res = createRes();

  let nextCalled = false;
  await isAuthenticated(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
  assert.deepEqual(findFirstArgs.where, { user_id: 7 });
  assert.deepEqual(findFirstArgs.orderBy, [{ created_at: 'desc' }, { id: 'desc' }]);
});

test('goals route: GET / maps stored gram weights into the user unit', async () => {
  const goalRow = {
    id: 1,
    user_id: 7,
    created_at: new Date('2025-01-01T00:00:00Z'),
    start_weight_grams: 82000,
    target_weight_grams: 76000,
    target_date: null,
    daily_deficit: 500,
    calorie_plan_review_status: 'CLEAR',
    calorie_plan_review_reason: null
  };

  const prismaStub = {
    goal: {
      findFirst: async () => goalRow
    }
  };
  const router = loadGoalsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, goalRow.id);
  assert.equal(res.body.user_id, goalRow.user_id);
  assert.equal(res.body.start_weight, 82);
  assert.equal(res.body.target_weight, 76);
  assert.equal(res.body.plan_status, 'available');
  assert.equal(res.body.plan_reason_code, null);
  assert.equal(res.body.projection.status, 'projected');
});

test('goals route: GET / preserves an unsafe historical daily deficit and marks it for review', async () => {
  const goalRow = {
    id: 2,
    user_id: 7,
    created_at: new Date('2025-01-01T00:00:00Z'),
    start_weight_grams: 82000,
    target_weight_grams: 76000,
    target_date: null,
    daily_deficit: 123,
    calorie_plan_review_status: 'CLEAR',
    calorie_plan_review_reason: null
  };
  const router = loadGoalsRouter({ goal: { findFirst: async () => goalRow } });
  const handler = getRouteHandler(router, 'get', '/');
  const res = createRes();

  await handler({ user: { id: 7, weight_unit: 'KG' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.daily_deficit, 123);
  assert.equal(res.body.plan_status, 'requires_review');
  assert.equal(res.body.plan_reason_code, 'DAILY_DEFICIT_INVALID');
  assert.deepEqual(res.body.projection, {
    status: 'unavailable', projected_end_date: null, reason_code: 'DAILY_DEFICIT_INVALID'
  });
});

test('goals route: POST / validates daily_deficit and weight inputs before writing', async () => {
  const prismaStub = {
    goal: {
      create: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const router = loadGoalsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    body: { start_weight: 82, target_weight: 76, daily_deficit: 123 }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'That calorie plan option is unavailable.',
    code: 'CALORIE_PLAN_OPTION_UNAVAILABLE',
    retryable: false,
    field_errors: { daily_deficit: ['Choose an available calorie plan option.'] }
  });
});

test('goals route: POST / rejects incoherent start/target weights for loss goals', async () => {
  const prismaStub = {
    goal: {
      create: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const router = loadGoalsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    body: { start_weight: 70, target_weight: 80, daily_deficit: 500 }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'For a weight loss goal, target weight must be less than start weight.',
    code: 'CALORIE_PLAN_OPTION_UNAVAILABLE',
    retryable: false,
    field_errors: { target_weight: ['For a weight loss goal, target weight must be less than start weight.'] }
  });
});

test('goals route: POST / creates a goal and returns weights in user units', async () => {
  const createdGoalRow = {
    id: 99,
    user_id: 7,
    created_at: new Date('2025-01-01T00:00:00Z'),
    start_weight_grams: 82000,
    target_weight_grams: 76000,
    target_date: null,
    daily_deficit: 500,
    calorie_plan_review_status: 'CLEAR',
    calorie_plan_review_reason: null
  };

  const prismaStub = {
    goal: {
      create: async () => createdGoalRow
    }
  };
  const router = loadGoalsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, weight_unit: 'KG' },
    body: { start_weight: 82, target_weight: 76, daily_deficit: 500, target_date: null }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, createdGoalRow.id);
  assert.equal(res.body.user_id, createdGoalRow.user_id);
  assert.equal(res.body.start_weight, 82);
  assert.equal(res.body.target_weight, 76);
  assert.equal(res.body.plan_status, 'available');
  assert.equal(res.body.plan_reason_code, null);
  assert.equal(res.body.projection.status, 'projected');
});
