/** @file Regression coverage for watch service: watch mutation parser accepts canonical grams and rejects unknown fields. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(path, exports) {
  const stub = new Module(path);
  stub.exports = exports;
  stub.loaded = true;
  require.cache[path] = stub;
}

function loadWatchService({ prismaStub, recentItems = [] }) {
  if (prismaStub.$transaction) {
    const transaction = prismaStub.$transaction;
    prismaStub.$transaction = (callback, options) => transaction(tx => {
      tx.$executeRaw ??= async () => 1;
      tx.dailyCaloriePlan ??= require('./helpers/dailyCaloriePlanStore')();
      return callback(tx);
    }, options);
  }
  const dbPath = require.resolve('../src/config/database');
  const recentPath = require.resolve('../src/services/recentFoods');
  const caloriePlanningPath = require.resolve('../src/services/caloriePlanning');
  const caloriePlanReviewPath = require.resolve('../src/services/caloriePlanReview');
  const servicePath = require.resolve('../src/services/watch');
  const previousDb = require.cache[dbPath];
  const previousRecent = require.cache[recentPath];
  const previousCaloriePlanning = require.cache[caloriePlanningPath];
  const previousCaloriePlanReview = require.cache[caloriePlanReviewPath];
  delete require.cache[servicePath];
  delete require.cache[caloriePlanningPath];
  delete require.cache[caloriePlanReviewPath];
  stubModule(dbPath, prismaStub);
  stubModule(recentPath, { getRecentFoodSuggestions: async () => recentItems });
  const loaded = require('../src/services/watch');
  if (previousDb) require.cache[dbPath] = previousDb; else delete require.cache[dbPath];
  if (previousRecent) require.cache[recentPath] = previousRecent; else delete require.cache[recentPath];
  if (previousCaloriePlanning) require.cache[caloriePlanningPath] = previousCaloriePlanning; else delete require.cache[caloriePlanningPath];
  if (previousCaloriePlanReview) require.cache[caloriePlanReviewPath] = previousCaloriePlanReview; else delete require.cache[caloriePlanReviewPath];
  return loaded;
}

function loadWatchMutationService(tx) {
  tx.dailyCaloriePlan ??= require('./helpers/dailyCaloriePlanStore')();
  tx.$executeRaw ??= async () => 1;
  const dbPath = require.resolve('../src/config/database');
  const recentPath = require.resolve('../src/services/recentFoods');
  const operationsPath = require.resolve('../src/services/clientOperations');
  const trendPath = require.resolve('../src/services/materializedWeightTrend');
  const caloriePlanningPath = require.resolve('../src/services/caloriePlanning');
  const caloriePlanReviewPath = require.resolve('../src/services/caloriePlanReview');
  const servicePath = require.resolve('../src/services/watch');
  const previous = new Map([
    [dbPath, require.cache[dbPath]], [recentPath, require.cache[recentPath]],
    [operationsPath, require.cache[operationsPath]], [trendPath, require.cache[trendPath]],
    [caloriePlanningPath, require.cache[caloriePlanningPath]], [caloriePlanReviewPath, require.cache[caloriePlanReviewPath]]
  ]);
  tx.user ??= { findUnique: async () => ({
    id: 9, timezone: 'UTC', date_of_birth: new Date('1990-01-01T00:00:00.000Z'), sex: 'MALE',
    height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM'
  }) };
  tx.goal ??= { findFirst: async () => null };
  tx.bodyMetric ??= {};
  tx.bodyMetric.findFirst ??= async () => null;
  tx.foodLogDay ??= {
    findUnique: async ({ where }) => ({
      id: 7,
      local_date: where.user_id_local_date.local_date,
      status: 'OPEN',
      origin: 'USER',
      completed_at: null,
      updated_at: new Date('2026-07-11T19:00:00.000Z')
    })
  };
  delete require.cache[servicePath];
  delete require.cache[caloriePlanningPath];
  delete require.cache[caloriePlanReviewPath];
  const captured = { options: null, syncChanges: [], trendRefreshes: 0 };
  stubModule(dbPath, {});
  stubModule(recentPath, { getRecentFoodSuggestions: async () => [] });
  stubModule(operationsPath, {
    executeIdempotentMutation: async (options) => {
      captured.options = options;
      return options.mutate(tx, options.operationId);
    },
    recordSyncChange: async (options) => { captured.syncChanges.push(options); }
  });
  stubModule(trendPath, {
    refreshMaterializedWeightTrendsBestEffort: async () => { captured.trendRefreshes += 1; }
  });
  const loaded = require('../src/services/watch');
  for (const [path, cached] of previous) {
    if (cached) require.cache[path] = cached; else delete require.cache[path];
  }
  return { ...loaded, captured };
}

test('watch mutation parser accepts canonical grams and rejects unknown fields', () => {
  const { parseWatchMutation } = loadWatchService({ prismaStub: {} });
  const parsed = parseWatchMutation({
    type: 'metric.upsert', payload: { local_date: '2026-07-11', weight_grams: 81234, expected_revision: null }
  }, { timezone: 'UTC', now: new Date('2026-07-11T12:00:00.000Z') });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.weight_grams, 81234);
  assert.equal(parseWatchMutation({
    type: 'metric.upsert', payload: { local_date: '2026-07-11', weight_grams: 81234, expected_revision: null }
  }, { timezone: 'Not/A_Zone', now: new Date('2026-07-11T12:00:00.000Z') }).code, 'TIMEZONE_INVALID');
  assert.equal(parseWatchMutation({
    type: 'metric.upsert', payload: { local_date: '2026-07-11', weight_grams: 24999, expected_revision: null }
  }, { timezone: 'UTC', now: new Date('2026-07-11T12:00:00.000Z') }).code, 'WEIGHT_OUT_OF_RANGE');
  assert.equal(parseWatchMutation({
    type: 'metric.upsert', payload: { local_date: '2026-07-11', weight_grams: 400001, expected_revision: null }
  }, { timezone: 'UTC', now: new Date('2026-07-11T12:00:00.000Z') }).code, 'WEIGHT_OUT_OF_RANGE');
  assert.equal(parseWatchMutation({
    type: 'metric.upsert', payload: { local_date: '2026-07-11', weight_grams: 81234, expected_revision: null, user_id: 99 }
  }, { timezone: 'UTC', now: new Date('2026-07-11T12:00:00.000Z') }).ok, false);
  assert.equal(parseWatchMutation({
    type: 'metric.upsert', payload: { local_date: '2026-07-12', weight_grams: 81234, expected_revision: null }
  }, { timezone: 'America/Los_Angeles', now: new Date('2026-07-12T06:59:59.000Z') }).ok, true);
});

test('watch snapshot rejects an invalid stored timezone before reading any guessed local day', async () => {
  let goalRead = false;
  const tx = {
    user: { findUnique: async () => ({ id: 9, timezone: 'Not/A_Zone' }) },
    goal: { findFirst: async () => { goalRead = true; return null; } }
  };
  const { buildWatchSnapshot, WatchTimezoneInvalidError } = loadWatchService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  await assert.rejects(
    buildWatchSnapshot({ userId: 9, mobileAuthSessionId: 73, now: new Date('2026-07-11T12:00:00.000Z') }),
    WatchTimezoneInvalidError
  );
  assert.equal(goalRead, false);
});
test('watch snapshot is bounded, timezone-local, and derives current-session undo', async () => {
  let isolationLevel;
  let revisionFindFirstArgs = null;
  let futureRevisions = [];
  let latestWeight = { id: 4, date: new Date('2026-07-10T00:00:00.000Z'), weight_grams: 80000 };
  let todayWeight = null;
  const tx = {
    user: { findUnique: async () => ({
      id: 9, timezone: 'America/Los_Angeles', language: 'en', weight_unit: 'KG', height_unit: 'CM',
      sex: 'MALE', date_of_birth: new Date('1990-01-01T00:00:00.000Z'), height_mm: 1800, activity_level: 'SEDENTARY'
    }) },
    goal: { findFirst: async () => ({
      id: 41, user_id: 9, start_weight_grams: 90000, target_weight_grams: 75000, daily_deficit: 250,
      target_date: null, created_at: new Date('2026-01-01T00:00:00.000Z'),
      calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
    }) },
    caloriePlanRevision: {
      findFirst: async (args) => {
        revisionFindFirstArgs = args;
        return null;
      },
      findMany: async () => futureRevisions
    },
    bodyMetric: {
      findFirst: async () => latestWeight,
      findUnique: async () => todayWeight
    },
    foodLog: {
      aggregate: async () => ({ _sum: { calories: 1200 } }),
      findFirst: async ({ where }) => where.id === 88
        ? { id: 88, name: 'Oats', calories: 300, created_at: new Date('2026-07-11T15:00:00.000Z') }
        : null
    },
    foodLogDay: { findUnique: async () => ({
      id: 7,
      local_date: new Date('2026-07-11T00:00:00.000Z'),
      status: 'OPEN',
      origin: 'USER',
      completed_at: null,
      updated_at: new Date('2026-07-11T19:00:00.000Z')
    }) },
    myFood: { findMany: async ({ where, take }) => {
      if (where.is_pinned) {
        assert.equal(take, 6);
        return [{ id: 12, name: 'Pinned oats', calories_per_serving: 300 }];
      }
      assert.deepEqual(where.id.in, [12, 13]);
      return [
        { id: 12, name: 'Pinned oats', calories_per_serving: 300 },
        { id: 13, name: 'Current recipe', calories_per_serving: 350 }
      ];
    } },
    clientOperation: { findFirst: async ({ where }) => {
      assert.equal(where.mobile_auth_session_id, 73);
      return {
        operation_id: 'watch-food-0001',
        response_body: { type: 'food.create', food_log: { id: 88 } },
      };
    } },
    syncChange: { findFirst: async ({ where }) => where.operation_id
      ? { id: 10n }
      : null },
    inAppNotification: { findMany: async () => [
      { id: 41, type: 'LOG_FOOD_REMINDER', local_date: new Date('2026-07-11T00:00:00.000Z'), created_at: new Date('2026-07-11T17:00:00.000Z') },
      { id: 42, type: 'LOG_WEIGHT_REMINDER', local_date: new Date('2026-07-11T00:00:00.000Z'), created_at: new Date('2026-07-11T17:00:00.000Z') },
      { id: 40, type: 'LOG_FOOD_REMINDER', local_date: new Date('2026-07-11T00:00:00.000Z'), created_at: new Date('2026-07-11T16:00:00.000Z') }
    ] }
  };
  const prismaStub = { $transaction: async (callback, options) => {
    isolationLevel = options.isolationLevel;
    return callback(tx);
  } };
  const recentItems = [
    { id: 'my-food:12', name: 'Pinned oats', meal_period: 'BREAKFAST', calories: 300, my_food_id: 12, servings_consumed: 1 },
    { id: 'my-food:13', name: 'Old recipe', meal_period: 'LUNCH', calories: 200, my_food_id: 13, servings_consumed: 2 },
    { id: 'manual:banana', name: 'Banana', meal_period: 'MORNING_SNACK', calories: 100, my_food_id: null, servings_consumed: null,
      serving_size_quantity_snapshot: null, serving_unit_label_snapshot: null, calories_per_serving_snapshot: null }
  ];
  const { buildWatchSnapshot, watchSnapshotEtag } = loadWatchService({ prismaStub, recentItems });
  const snapshot = await buildWatchSnapshot({ userId: 9, mobileAuthSessionId: 73, now: new Date('2026-07-11T20:00:00.000Z') });

  assert.equal(isolationLevel, 'RepeatableRead');
  assert.equal(revisionFindFirstArgs.where.source_goal_id, 41);
  assert.equal(snapshot.local_date, '2026-07-11');
  assert.equal(snapshot.weight_unit, 'KG');
  assert.equal(snapshot.calories.consumed, 1200);
  assert.equal(snapshot.calories.target, 1850);
  assert.equal(snapshot.calories.remaining, 650);
  assert.deepEqual(snapshot.plan, { status: 'available', reason_code: null, minimum_daily_calorie_target: 1750 });
  assert.equal(snapshot.weight.today_grams, null);
  assert.equal(snapshot.weight.latest_grams, 80000);
  assert.match(snapshot.weight.latest_revision, /^[a-f0-9]{24}$/);
  assert.equal(snapshot.weight.latest_date, '2026-07-10');
  assert.deepEqual(snapshot.goal, {
    start_weight_grams: 90000,
    target_weight_grams: 75000,
    current_weight_grams: 80000,
    daily_deficit: 250,
    progress_percent: 66.7,
    remaining_weight_grams: 5000,
    is_complete: false,
    projection: { status: 'projected', projected_end_date: '2026-12-12', reason_code: null }
  });
  assert.equal('activity' in snapshot, false);
  assert.equal('staleness' in snapshot, false);
  assert.equal(snapshot.food_day.status, 'OPEN');
  assert.equal(snapshot.food_day.is_complete, false);
  assert.equal(snapshot.food_day.completed_at, null);
  assert.equal(snapshot.quick_add.length, 3);
  assert.deepEqual(snapshot.reminders.map((reminder) => reminder.type).sort(), ['food', 'weight']);
  assert.equal(snapshot.reminders.find((reminder) => reminder.type === 'food').id, 41);
  assert.equal(snapshot.quick_add.filter((item) => item.id === 'my-food:12').length, 1);
  const refreshedRecipe = snapshot.quick_add.find((item) => item.id === 'my-food:13');
  assert.equal(refreshedRecipe.label, 'Current recipe');
  assert.equal(refreshedRecipe.calories, 700);
  assert.equal(refreshedRecipe.draft.my_food_id, 13);
  assert.equal(snapshot.undo_candidate.food_log_id, 88);
  assert.equal(snapshot.undo_candidate.name, 'Oats');
  assert.equal(snapshot.undo_candidate.calories, 300);
  assert.equal(snapshot.undo_candidate.created_at, '2026-07-11T15:00:00.000Z');
  assert.ok(snapshot.food_day.revision);
  assert.equal(snapshot.weight.today_revision, null);
  assert.match(watchSnapshotEtag(snapshot.revision), /^W\/"watch-/);

  futureRevisions = [{
    id: 52,
    recommendation_id: 18,
    target_adjustment_kcal: -125,
    effective_local_date: new Date('2026-07-12T00:00:00.000Z'),
    calorie_plan_review_status: 'CLEAR',
    calorie_plan_review_reason: null
  }];
  const unsafeSnapshot = await buildWatchSnapshot({
    userId: 9, mobileAuthSessionId: 73, now: new Date('2026-07-11T20:00:00.000Z')
  });
  assert.deepEqual(unsafeSnapshot.plan, {
    status: 'requires_review',
    reason_code: 'PLAN_REVISION_UNSAFE',
    minimum_daily_calorie_target: 1750
  });
  assert.equal(unsafeSnapshot.calories.target, null);
  assert.equal(unsafeSnapshot.calories.remaining, null);
  assert.equal(unsafeSnapshot.goal, null);

  futureRevisions = [];
  latestWeight = { id: 5, date: new Date('2026-07-11T00:00:00.000Z'), weight_grams: 24000 };
  todayWeight = latestWeight;
  const invalidWeightSnapshot = await buildWatchSnapshot({
    userId: 9, mobileAuthSessionId: 73, now: new Date('2026-07-11T20:00:00.000Z')
  });
  assert.deepEqual(invalidWeightSnapshot.plan, {
    status: 'requires_review', reason_code: 'WEIGHT_OUT_OF_RANGE', minimum_daily_calorie_target: null
  });
  assert.deepEqual(invalidWeightSnapshot.weight, {
    today_grams: null, today_revision: null, latest_grams: null, latest_revision: null, latest_date: null
  });
  assert.equal(invalidWeightSnapshot.calories.target, null);
  assert.equal(invalidWeightSnapshot.goal, null);
  assert.equal(invalidWeightSnapshot.food_day.status, 'OPEN');
  assert.ok(invalidWeightSnapshot.quick_add.length > 0);
  assert.ok(invalidWeightSnapshot.reminders.length > 0);
});

test('watch goal progress covers loss, gain, maintenance, missing goals, and completed targets', () => {
  const { buildWatchGoalSnapshot } = loadWatchService({ prismaStub: {} });
  assert.equal(buildWatchGoalSnapshot(null, 80000), null);
  const serialized = buildWatchGoalSnapshot({
    id: 99, user_id: 9, start_weight_grams: 90000, target_weight_grams: 80000,
    daily_deficit: 500, target_date: new Date(), created_at: new Date()
  }, 85000);
  assert.deepEqual(Object.keys(serialized).sort(), [
    'current_weight_grams', 'daily_deficit', 'is_complete', 'progress_percent',
    'remaining_weight_grams', 'start_weight_grams', 'target_weight_grams'
  ]);
  assert.deepEqual(
    buildWatchGoalSnapshot({ start_weight_grams: 90000, target_weight_grams: 80000, daily_deficit: 500 }, 85000),
    {
      start_weight_grams: 90000, target_weight_grams: 80000, current_weight_grams: 85000,
      daily_deficit: 500, progress_percent: 50, remaining_weight_grams: 5000, is_complete: false
    }
  );
  assert.deepEqual(
    buildWatchGoalSnapshot({ start_weight_grams: 70000, target_weight_grams: 80000, daily_deficit: -500 }, 75000),
    {
      start_weight_grams: 70000, target_weight_grams: 80000, current_weight_grams: 75000,
      daily_deficit: -500, progress_percent: 50, remaining_weight_grams: 5000, is_complete: false
    }
  );
  assert.deepEqual(
    buildWatchGoalSnapshot({ start_weight_grams: 75000, target_weight_grams: 75000, daily_deficit: 0 }, 75090),
    {
      start_weight_grams: 75000, target_weight_grams: 75000, current_weight_grams: 75090,
      daily_deficit: 0, progress_percent: null, remaining_weight_grams: 90, is_complete: false
    }
  );
  assert.deepEqual(
    buildWatchGoalSnapshot({ start_weight_grams: 90000, target_weight_grams: 80000, daily_deficit: 500 }, 79000),
    {
      start_weight_grams: 90000, target_weight_grams: 80000, current_weight_grams: 79000,
      daily_deficit: 500, progress_percent: 100, remaining_weight_grams: 0, is_complete: true
    }
  );
  assert.deepEqual(
    buildWatchGoalSnapshot({ start_weight_grams: 90000, target_weight_grams: 80000, daily_deficit: 500 }, null),
    {
      start_weight_grams: 90000, target_weight_grams: 80000, current_weight_grams: null,
      daily_deficit: 500, progress_percent: null, remaining_weight_grams: 10000, is_complete: false
    }
  );
});

test('watch food creation snapshots My Food and records trusted session provenance', async () => {
  const tx = {
    myFood: { findFirst: async ({ where }) => {
      assert.equal(where.user_id, 9);
      return { id: 12, name: 'Oats', calories_per_serving: 300, serving_size_quantity: 1, serving_unit_label: 'bowl' };
    } },
    foodLog: { create: async ({ data }) => ({ id: 88, created_at: new Date('2026-07-11T18:00:00.000Z'), ...data }) }
  };
  const service = loadWatchMutationService(tx);
  const mutation = service.parseWatchMutation({
    type: 'food.create',
    payload: { date: '2026-07-11', meal_period: 'BREAKFAST', my_food_id: 12, servings_consumed: 1.5 }
  }, { timezone: 'UTC', now: new Date('2026-07-11T18:00:00.000Z') });
  const result = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-food-0001', mutation });

  assert.equal(result.status, 200);
  assert.equal(result.body.food_log.calories, 450);
  assert.equal(service.captured.options.mobileAuthSessionId, 73);
  assert.equal(service.captured.options.operationKind, 'watch.food.create');
  assert.equal(service.captured.syncChanges[0].entityType, 'food_log');
});

test('watch food creation rejects paused days before inserting', async () => {
  let createCalled = false;
  const tx = {
    foodLogDay: {
      findUnique: async ({ where }) => ({
        id: 7,
        local_date: where.user_id_local_date.local_date,
        status: 'PAUSED',
        origin: 'PAUSE',
        completed_at: null,
        updated_at: new Date('2026-07-11T19:00:00.000Z')
      })
    },
    foodLog: {
      create: async () => {
        createCalled = true;
        throw new Error('Paused day must not write');
      }
    }
  };
  const service = loadWatchMutationService(tx);
  const mutation = service.parseWatchMutation({
    type: 'food.create',
    payload: { date: '2026-07-11', meal_period: 'BREAKFAST', name: 'Oats', calories: 300 }
  }, { timezone: 'UTC', now: new Date('2026-07-11T18:00:00.000Z') });
  const result = await service.executeWatchMutation({
    userId: 9,
    mobileAuthSessionId: 73,
    operationId: 'watch-food-paused-01',
    mutation
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'FOOD_DAY_NOT_OPEN');
  assert.equal(result.body.food_day.status, 'PAUSED');
  assert.equal(createCalled, false);
  assert.equal(service.captured.syncChanges.length, 0);
});

test('watch food deletion is limited to the current session undo candidate', async () => {
  let deleted = 0;
  const tx = {
    clientOperation: { findFirst: async () => ({
      operation_id: 'watch-food-0001',
      response_body: { food_log: { id: 88 } },
    }) },
    syncChange: { findFirst: async ({ where }) => where.operation_id
      ? { id: 10n }
      : deleted > 0 ? { id: 99n } : null },
    foodLog: {
      findFirst: async () => ({ id: 88, name: 'Oats', calories: 300, local_date: new Date('2026-07-11T00:00:00Z'), created_at: new Date('2026-07-11T18:00:00.000Z') }),
      deleteMany: async () => { deleted += 1; return { count: 1 }; }
    }
  };
  const service = loadWatchMutationService(tx);
  const allowed = service.parseWatchMutation({ type: 'food.delete', payload: { food_log_id: 88 } }, { timezone: 'UTC' });
  const allowedResult = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-delete-01', mutation: allowed });
  assert.equal(allowedResult.status, 200);
  assert.equal(deleted, 1);

  const denied = service.parseWatchMutation({ type: 'food.delete', payload: { food_log_id: 88 } }, { timezone: 'UTC' });
  const deniedResult = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-delete-02', mutation: denied });
  assert.equal(deniedResult.status, 409);
  assert.equal(deniedResult.body.code, 'WATCH_UNDO_NOT_ALLOWED');
  assert.equal(deleted, 1);
});

test('watch undo is invalidated by a later phone edit and never walks to an older create', async () => {
  let receiptReads = 0;
  const tx = {
    clientOperation: { findFirst: async () => {
      receiptReads += 1;
      return {
        operation_id: 'watch-food-0001',
        response_body: { food_log: { id: 88 } },
      };
    } },
    syncChange: { findFirst: async ({ where }) => {
      assert.equal(where.entity_id, '88');
      if (where.operation_id) return { id: 10n };
      assert.deepEqual(where.id, { gt: 10n });
      return { id: 100n, action: 'upsert' };
    } },
    foodLog: {
      findFirst: async () => {
        throw new Error('Later phone edit should invalidate before loading the entity');
      },
      deleteMany: async () => {
        throw new Error('Edited food must not be deleted');
      }
    }
  };
  const service = loadWatchMutationService(tx);
  const mutation = service.parseWatchMutation({ type: 'food.delete', payload: { food_log_id: 88 } }, { timezone: 'UTC' });
  const result = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-delete-03', mutation });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'WATCH_UNDO_NOT_ALLOWED');
  assert.equal(receiptReads, 1);
});

test('watch metric revalidates the date against the locked timezone before reading a metric', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T06:59:00Z') });
  const service = loadWatchMutationService({
    user: { findUnique: async () => ({ timezone: 'America/Los_Angeles' }) },
    bodyMetric: { findUnique: async () => { throw new Error('Future metric must not be read or written'); } }
  });
  const mutation = service.parseWatchMutation({ type: 'metric.upsert', payload: {
    local_date: '2026-10-09', weight_grams: 85000, expected_revision: null
  } }, { timezone: 'UTC' });
  assert.equal(mutation.ok, true);
  const result = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-future-date', mutation });
  assert.equal(result.status, 400);
  assert.equal(result.body.message, 'Weight date cannot be in the future');
});

test('watch metric and completion mutations use canonical date-only upserts', async () => {
  let metricArgs;
  let dayArgs;
  let storedDay;
  const tx = {
    bodyMetric: {
      findUnique: async () => null,
      upsert: async (args) => {
        metricArgs = args;
        return { id: 5, date: args.create.date, weight_grams: args.create.weight_grams, body_fat_percent: null };
      }
    },
    foodLogDay: {
      update: async ({ data }) => Object.assign(storedDay, data),
      findUnique: async () => null,
      upsert: async (args) => {
        dayArgs = args;
        storedDay = {
          id: 6,
          user_id: args.create.user_id,
          local_date: args.create.local_date,
          status: args.create.status,
          origin: args.create.origin,
          completed_at: args.create.completed_at,
          updated_at: new Date('2026-07-11T20:00:00.000Z')
        };
        return storedDay;
      }
    }
  };
  const service = loadWatchMutationService(tx);
  const metric = service.parseWatchMutation({
    type: 'metric.upsert',
    payload: { local_date: '2026-07-11', weight_grams: 81234, expected_revision: null }
  }, { timezone: 'UTC' });
  const metricResult = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-metric-01', mutation: metric });
  assert.equal(metricResult.body.metric.weight_grams, 81234);
  assert.match(metricResult.body.metric.revision, /^[a-f0-9]{24}$/);
  assert.equal(metricArgs.where.user_id_date.date.toISOString(), '2026-07-11T00:00:00.000Z');
  assert.equal(service.captured.trendRefreshes, 1);

  const completion = service.parseWatchMutation({
    type: 'food_day.set_complete',
    payload: { local_date: '2026-07-11', is_complete: true, expected_revision: null }
  }, { timezone: 'UTC' });
  const dayResult = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-day-0001', mutation: completion });
  assert.equal(dayResult.body.food_day.is_complete, true);
  assert.match(dayResult.body.food_day.revision, /^[a-f0-9]{24}$/);
  assert.equal(dayArgs.where.user_id_local_date.local_date.toISOString(), '2026-07-11T00:00:00.000Z');
});

test('watch completion publishes saved comparison in its acknowledgement and sync change', async () => {
  const capturedAt = new Date('2026-07-11T19:00:00Z');
  const service = loadWatchMutationService({
    foodLogDay: {
      findUnique: async () => null,
      upsert: async ({create}) => ({ id: 6, ...create, updated_at: capturedAt,
        comparison_target_kcal: 2000, comparison_maintenance_kcal: 2500, comparison_captured_at: capturedAt })
    },
    foodLog: { findMany: async ({where}) => {
      assert.equal(where.user_id, 9);
      assert.equal(where.local_date.toISOString(), '2026-07-11T00:00:00.000Z');
      return [{calories: 1800}];
    } }
  });
  const mutation = service.parseWatchMutation({ type: 'food_day.set_complete',
    payload: { local_date: '2026-07-11', is_complete: true, expected_revision: null }
  }, { timezone: 'UTC' });
  const result = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-saved-plan', mutation });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.food_day.calorie_comparison, {
    consumed_kcal: 1800, target_kcal: 2000, maintenance_kcal: 2500, captured_at: capturedAt.toISOString()
  });
  assert.deepEqual(service.captured.syncChanges[0].payload.calorie_comparison, result.body.food_day.calorie_comparison);
});

test('watch metric and completion mutations reject stale snapshot revisions', async () => {
  const metricRow = {
    id: 5,
    date: new Date('2026-07-11T00:00:00.000Z'),
    weight_grams: 81000,
    body_fat_percent: null
  };
  const dayRow = {
    id: 6,
    local_date: new Date('2026-07-11T00:00:00.000Z'),
    status: 'OPEN',
    origin: 'USER',
    completed_at: null,
    updated_at: new Date('2026-07-11T19:00:00.000Z')
  };
  const tx = {
    bodyMetric: {
      findUnique: async () => metricRow,
      upsert: async () => { throw new Error('Stale metric must not write'); }
    },
    foodLogDay: {
      findUnique: async () => dayRow,
      upsert: async () => { throw new Error('Stale completion must not write'); }
    }
  };
  const service = loadWatchMutationService(tx);
  const staleRevision = '000000000000000000000000';
  const metric = service.parseWatchMutation({
    type: 'metric.upsert',
    payload: { local_date: '2026-07-11', weight_grams: 81234, expected_revision: staleRevision }
  }, { timezone: 'UTC' });
  const metricResult = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-metric-02', mutation: metric });
  assert.equal(metricResult.status, 409);
  assert.equal(metricResult.body.code, 'ENTITY_CONFLICT');
  assert.equal(metricResult.body.current.weight_grams, 81000);

  const completion = service.parseWatchMutation({
    type: 'food_day.set_complete',
    payload: { local_date: '2026-07-11', is_complete: true, expected_revision: staleRevision }
  }, { timezone: 'UTC' });
  const dayResult = await service.executeWatchMutation({ userId: 9, mobileAuthSessionId: 73, operationId: 'watch-day-0002', mutation: completion });
  assert.equal(dayResult.status, 409);
  assert.equal(dayResult.body.code, 'ENTITY_CONFLICT');
  assert.equal(dayResult.body.current.is_complete, false);
});
