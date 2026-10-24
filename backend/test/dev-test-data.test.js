/** @file Regression coverage for dev test data: dev seed marks onboarding complete only after baseline goal and metric writes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadDevTestDataService(prismaStub) {
  const databasePath = require.resolve('../src/config/database');
  const trendPath = require.resolve('../src/services/materializedWeightTrend');
  const servicePath = require.resolve('../src/services/devTestData');
  const previousDatabase = require.cache[databasePath];
  const previousTrend = require.cache[trendPath];

  delete require.cache[servicePath];
  stubModule(databasePath, { __esModule: true, default: prismaStub });
  stubModule(trendPath, {
    refreshMaterializedWeightTrendsBestEffort: async () => {}
  });
  const loaded = require('../src/services/devTestData');

  if (previousDatabase) require.cache[databasePath] = previousDatabase;
  else delete require.cache[databasePath];
  if (previousTrend) require.cache[trendPath] = previousTrend;
  else delete require.cache[trendPath];

  return loaded;
}

function createPrismaStub(events) {
  const record = (kind, data) => {
    events.push({ kind, data });
    return { count: 1 };
  };
  const tx = {
    caloriePlanRevision: {
      deleteMany: async ({ where }) => record('caloriePlanRevision.deleteMany', where)
    },
    calibrationRecommendation: {
      deleteMany: async ({ where }) => record('calibrationRecommendation.deleteMany', where)
    },
    goal: {
      deleteMany: async ({ where }) => record('goal.deleteMany', where)
    },
    foodLog: {
      deleteMany: async ({ where }) => record('foodLog.deleteMany', where)
    },
    foodLogDay: {
      deleteMany: async ({ where }) => record('foodLogDay.deleteMany', where)
    },
    foodTrackingPause: {
      deleteMany: async ({ where }) => record('foodTrackingPause.deleteMany', where)
    },
    bodyMetric: {
      deleteMany: async ({ where }) => record('bodyMetric.deleteMany', where)
    },
    user: {
      update: async ({ data }) => {
        record('user.update', data);
        return { id: 7 };
      }
    }
  };

  return {
    user: {
      upsert: async () => ({ id: 7 }),
      findUnique: async () => ({ id: 7 })
    },
    legalAcceptance: {
      upsert: async () => ({ id: 1 })
    },
    goal: {
      create: async ({ data }) => {
        record('goal.create', data);
        return { id: 41 };
      }
    },
    bodyMetric: {
      createMany: async ({ data }) => record('bodyMetric.createMany', data)
    },
    foodLog: {
      createMany: async ({ data }) => record('foodLog.createMany', data)
    },
    foodLogDay: {
      createMany: async ({ data }) => record('foodLogDay.createMany', data)
    },
    $transaction: async (callback) => callback(tx)
  };
}

test('dev seed marks onboarding complete only after baseline goal and metric writes', async () => {
  const events = [];
  const prismaStub = createPrismaStub(events);
  const { seedDevTestData } = loadDevTestDataService(prismaStub);

  await seedDevTestData();

  const goalIndex = events.findIndex(({ kind }) => kind === 'goal.create');
  const metricIndex = events.findIndex(({ kind }) => kind === 'bodyMetric.createMany');
  const completionIndex = events.findIndex(
    ({ kind, data }) => kind === 'user.update' && data.onboarding_completed_at instanceof Date
  );

  assert.ok(goalIndex >= 0);
  assert.ok(metricIndex > goalIndex);
  assert.ok(completionIndex > metricIndex);
  assert.equal(
    events.slice(0, completionIndex).some(
      ({ kind, data }) => kind === 'user.update' && data.onboarding_completed_at === null
    ),
    true
  );
});

test('pre-onboarding reset clears the completion marker', async () => {
  const events = [];
  const prismaStub = createPrismaStub(events);
  const { resetDevTestUserToPreOnboardingState } = loadDevTestDataService(prismaStub);

  const userId = await resetDevTestUserToPreOnboardingState();

  assert.equal(userId, 7);
  const reset = events.find(({ kind }) => kind === 'user.update');
  assert.equal(reset.data.onboarding_completed_at, null);
  assert.equal(reset.data.date_of_birth, null);
  assert.equal(reset.data.sex, null);
  assert.equal(reset.data.height_mm, null);
  assert.equal(reset.data.activity_level, null);
});
