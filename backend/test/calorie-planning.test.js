/** @file Regression coverage for calorie planning: stored planning marks a current-safe but scheduled-unsafe revision and fails all reads closed. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadPlanningServices() {
  const databasePath = require.resolve('../src/config/database');
  const planningPath = require.resolve('../src/services/caloriePlanning');
  const reviewPath = require.resolve('../src/services/caloriePlanReview');
  const previous = new Map([
    [databasePath, require.cache[databasePath]],
    [planningPath, require.cache[planningPath]],
    [reviewPath, require.cache[reviewPath]]
  ]);

  delete require.cache[planningPath];
  delete require.cache[reviewPath];
  stubModule(databasePath, {});
  const loaded = {
    ...require('../src/services/caloriePlanning'),
    ...require('../src/services/caloriePlanReview')
  };

  for (const [resolvedPath, cached] of previous) {
    if (cached) require.cache[resolvedPath] = cached;
    else delete require.cache[resolvedPath];
  }
  return loaded;
}

const { buildStoredCaloriePlanningSnapshot, markCurrentCaloriePlanForReviewIfUnsafe } =
  loadPlanningServices();

test('stored planning marks a current-safe but scheduled-unsafe revision and fails all reads closed', async () => {
  const goalUpdates = [];
  const revisionUpdates = [];
  const goal = {
    id: 41, user_id: 7, start_weight_grams: 82_000, target_weight_grams: 72_000, daily_deficit: 250,
    target_date: null, created_at: new Date('2026-01-01T00:00:00.000Z'),
    calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
  };
  const scheduled = {
    id: 12, recommendation_id: 9, target_adjustment_kcal: -200,
    effective_local_date: new Date('2026-08-09T00:00:00.000Z'),
    calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
  };
  const database = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    user: { findUnique: async () => ({
      id: 7, timezone: 'UTC', date_of_birth: new Date('1990-01-01T00:00:00.000Z'), sex: 'MALE',
      height_mm: 1750, activity_level: 'SEDENTARY', weight_unit: 'KG', height_unit: 'CM'
    }) },
    goal: {
      findFirst: async () => goal,
      update: async (args) => { goalUpdates.push(args); return { ...goal, ...args.data }; }
    },
    bodyMetric: { findFirst: async () => ({ weight_grams: 82_000 }) },
    caloriePlanRevision: {
      findFirst: async () => null,
      findMany: async () => [scheduled],
      updateMany: async (args) => { revisionUpdates.push(args); return { count: 1 }; }
    },
    calibrationRecommendation: { updateMany: async () => ({ count: 1 }) }
  };

  const snapshot = await buildStoredCaloriePlanningSnapshot(database, 7, new Date('2026-08-08T12:00:00.000Z'));
  assert.equal(snapshot.evaluation.status, 'requires_review');
  assert.equal(snapshot.evaluation.reasonCode, 'PLAN_REVISION_UNSAFE');
  assert.equal(snapshot.evaluation.dailyCalorieTarget, null);
  assert.deepEqual(snapshot.unsafeRevisionIds, [12]);
  assert.equal(snapshot.nextRevision.id, 12);

  await markCurrentCaloriePlanForReviewIfUnsafe(database, 7, new Date('2026-08-08T12:00:00.000Z'));
  assert.deepEqual(goalUpdates[0].data, {
    calorie_plan_review_status: 'REQUIRES_REVIEW', calorie_plan_review_reason: 'PLAN_REVISION_UNSAFE'
  });
  assert.deepEqual(revisionUpdates[0].where, {
    id: { in: [12] }, calorie_plan_review_status: 'CLEAR'
  });
});

test('a resolved stored prerequisite marker becomes historical review instead of looping to the old repair action', async () => {
  const goalUpdates = [];
  const goal = {
    id: 41, user_id: 7, start_weight_grams: 82_000, target_weight_grams: 72_000, daily_deficit: 250,
    target_date: null, created_at: new Date('2026-01-01T00:00:00.000Z'),
    calorie_plan_review_status: 'REQUIRES_REVIEW', calorie_plan_review_reason: 'LATEST_WEIGHT_REQUIRED'
  };
  const database = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    user: { findUnique: async () => ({
      id: 7, timezone: 'UTC', date_of_birth: new Date('1990-01-01T00:00:00.000Z'), sex: 'MALE',
      height_mm: 1750, activity_level: 'SEDENTARY', weight_unit: 'KG', height_unit: 'CM'
    }) },
    goal: {
      findFirst: async () => goal,
      update: async (args) => { goalUpdates.push(args); return { ...goal, ...args.data }; }
    },
    bodyMetric: { findFirst: async () => ({ weight_grams: 82_000 }) },
    caloriePlanRevision: {
      findFirst: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 })
    },
    calibrationRecommendation: { updateMany: async () => ({ count: 0 }) }
  };

  const snapshot = await buildStoredCaloriePlanningSnapshot(database, 7, new Date('2026-08-08T12:00:00.000Z'));
  assert.equal(snapshot.evaluation.status, 'requires_review');
  assert.equal(snapshot.evaluation.reasonCode, 'HISTORICAL_PLAN_REQUIRES_REVIEW');
  assert.deepEqual(snapshot.evaluation.missing, []);

  await markCurrentCaloriePlanForReviewIfUnsafe(database, 7, new Date('2026-08-08T12:00:00.000Z'));
  assert.deepEqual(goalUpdates[0], {
    where: { id: 41 },
    data: {
      calorie_plan_review_status: 'REQUIRES_REVIEW',
      calorie_plan_review_reason: 'HISTORICAL_PLAN_REQUIRES_REVIEW'
    }
  });
});
