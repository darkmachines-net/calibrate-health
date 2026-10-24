/** @file Regression coverage for calibration service: calibration status materializes a deterministic model-scoped recommendation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const { CALIBRATION_MODEL_VERSION } = require('../../shared/calibration');
const { CALORIE_POLICY_VERSION } = require('../../shared/caloriePolicy');
const { getCalibrationScenario } = require('../../shared/calibrationScenarios');

function stubModule(path, exports) {
  const stub = new Module(path);
  stub.exports = exports;
  stub.loaded = true;
  require.cache[path] = stub;
}

function loadCalibrationService({ prisma, planning, operations = {}, trendModelVersion = 2 }) {
  const paths = {
    database: require.resolve('../src/config/database'),
    caloriePlanning: require.resolve('../src/services/caloriePlanning'),
    profile: require.resolve('../src/utils/profile'),
    operations: require.resolve('../src/services/clientOperations'),
    weightTrend: require.resolve('../src/services/weightTrend'),
    dailyPlans: require.resolve('../src/services/dailyCaloriePlans'),
    service: require.resolve('../src/services/calibration')
  };
  const previous = new Map(Object.values(paths).map((path) => [path, require.cache[path]]));
  delete require.cache[paths.service];
  delete require.cache[paths.dailyPlans];
  stubModule(paths.database, prisma);
  stubModule(paths.caloriePlanning, {
    getStoredCaloriePlanningSnapshot: async () => planning.current,
    buildStoredCaloriePlanningSnapshot: async () => planning.transactional ?? planning.current
  });
  stubModule(paths.profile, {
    calculateAge: () => 38,
    buildCalorieSummary: () => ({ bmr: 1650, tdee: 2400, missing: [] })
  });
  stubModule(paths.operations, {
    ClientOperationConflictError: class ClientOperationConflictError extends Error {},
    executeIdempotentMutation: operations.executeIdempotentMutation ?? (async () => {
      throw new Error('Unexpected idempotent mutation');
    }),
    recordSyncChange: operations.recordSyncChange ?? (async () => undefined)
  });
  stubModule(paths.weightTrend, { WEIGHT_TREND_MODEL_VERSION: trendModelVersion });
  const loaded = require('../src/services/calibration');
  for (const [path, cached] of previous) {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
  return loaded;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value instanceof Date ? value.toISOString() : value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function createHarness({ scenarioId = 'target-too-high', scheduledRevision = null, currentPlan = null, pausedDates = [], todayStatus = null, trendModelVersion = 2 } = {}) {
  const scenario = getCalibrationScenario(scenarioId);
  assert.ok(scenario);
  const safeScheduledRevision = scheduledRevision ? {
    calorie_plan_review_status: 'CLEAR',
    calorie_plan_review_reason: null,
    ...scheduledRevision
  } : null;
  const captured = {
    upserts: [],
    staleUpdates: [],
    operation: null,
    operationAttempts: 0,
    revision: null,
    deletedRevisionId: null,
    appliedAt: null,
    sync: null,
    weightQuery: null
  };
  let storedRecommendation = null;
  let beforeMutation = null;
  let persistentMutationError = null;
  let scheduledRevisionState = safeScheduledRevision;
  const pausedDateSet = new Set(pausedDates);
  const logs = scenario.input.foodDays.flatMap((day) => [
    { local_date: new Date(`${day.date}T00:00:00.000Z`), calories: Math.floor(day.calories / 2), meal_period: 'BREAKFAST' },
    { local_date: new Date(`${day.date}T00:00:00.000Z`), calories: Math.ceil(day.calories / 2), meal_period: 'DINNER' }
  ]);
  const completionDays = scenario.input.foodDays.map((day) => ({
    local_date: new Date(`${day.date}T00:00:00.000Z`),
    status: pausedDateSet.has(day.date) ? 'PAUSED' : (day.isComplete ? 'COMPLETE' : 'INCOMPLETE')
  }));
  const weightRows = scenario.input.weightPoints.map((point, index) => ({
    id: index + 1,
    date: new Date(`${point.date}T00:00:00.000Z`),
    weight_grams: Math.round(point.weightKg * 1000)
  }));
  const serviceInput = {
    asOfDate: scenario.input.asOfDate,
    weightUnit: scenario.input.weightUnit,
    ageYears: 38,
    bmrKcal: 1650,
    profileTdeeKcal: 2400,
    configuredDailyDeficitKcal: scenario.input.configuredDailyDeficitKcal,
    currentTargetAdjustmentKcal: currentPlan?.targetAdjustmentKcal ?? 0,
    foodDays: scenario.input.foodDays.map((day) => ({
      date: day.date,
      calories: day.calories,
      entryCount: 2,
      mealPeriodCount: 2,
      isComplete: pausedDateSet.has(day.date) ? false : day.isComplete,
      isPaused: pausedDateSet.has(day.date)
    })),
    trackingPaused: todayStatus === 'PAUSED',
    weightPoints: weightRows.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      weightKg: row.weight_grams / 1000
    }))
  };
  const prisma = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    user: { findUnique: async () => ({
      id: 7,
      timezone: 'UTC',
      weight_unit: scenario.input.weightUnit,
      date_of_birth: new Date('1988-01-01T00:00:00.000Z'),
      sex: 'MALE',
      height_mm: 1800,
      activity_level: 'MODERATE'
    }) },
    goal: { findFirst: async () => ({
      id: 41,
      user_id: 7,
      daily_deficit: scenario.input.configuredDailyDeficitKcal,
      created_at: new Date('2026-06-01T00:00:00.000Z')
    }) },
    foodLogDay: {
      findUnique: async () => todayStatus ? { status: todayStatus } : null,
      findMany: async () => completionDays
    },
    foodLog: { findMany: async () => logs },
    bodyMetric: {
      findFirst: async () => ({ weight_grams: 82000 }),
      findMany: async (args) => {
        captured.weightQuery = args;
        return weightRows;
      }
    },
    activityDaySummary: { findMany: async () => [] },
    caloriePlanRevision: {
      findFirst: async () => scheduledRevisionState,
      create: async ({ data }) => {
        const revision = { id: 12, ...data };
        captured.revision = revision;
        if (storedRecommendation) storedRecommendation.plan_revision = revision;
        return revision;
      },
      delete: async ({ where }) => {
        captured.deletedRevisionId = where.id;
        const deleted = storedRecommendation?.plan_revision;
        if (storedRecommendation) storedRecommendation.plan_revision = null;
        return deleted;
      }
    },
    calibrationRecommendation: {
      updateMany: async (args) => {
        captured.staleUpdates.push(args);
        return { count: 0 };
      },
      upsert: async (args) => {
        captured.upserts.push(args);
        storedRecommendation ??= { id: 9, status: 'PENDING', plan_revision: null, ...args.create };
        return storedRecommendation;
      },
      findFirst: async () => storedRecommendation,
      update: async ({ data }) => {
        captured.appliedAt = data.applied_at;
        storedRecommendation = { ...storedRecommendation, ...data };
        return storedRecommendation;
      }
    },
    $transaction: async (callback) => callback(prisma)
  };
  const operations = {
    executeIdempotentMutation: async (options) => {
      captured.operation = options;
      captured.operationAttempts += 1;
      const interleave = beforeMutation;
      beforeMutation = null;
      if (interleave) await interleave();
      if (persistentMutationError) throw persistentMutationError;
      return options.mutate(prisma, options.operationId);
    },
    recordSyncChange: async (options) => { captured.sync = options; }
  };
  const planning = {
    user: {
      id: 7, timezone: 'UTC', weight_unit: scenario.input.weightUnit, height_unit: 'CM',
      date_of_birth: new Date('1988-01-01T00:00:00.000Z'), sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE'
    },
    goal: {
      id: 41, user_id: 7, start_weight_grams: 82_000, target_weight_grams: 75_000,
      daily_deficit: scenario.input.configuredDailyDeficitKcal, target_date: null,
      created_at: new Date('2026-06-01T00:00:00.000Z'),
      calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
    },
    latestWeightGrams: 82_000,
    localToday: '2026-08-01',
    effectiveRevision: currentPlan ? {
      id: 3, recommendation_id: null, target_adjustment_kcal: currentPlan.targetAdjustmentKcal,
      effective_local_date: currentPlan.effectiveLocalDate,
      calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
    } : null,
    nextRevision: safeScheduledRevision,
    futureRevisions: safeScheduledRevision ? [safeScheduledRevision] : [],
    unsafeRevisionIds: [],
    evaluation: {
      eligibility: { status: 'eligible', reasonCode: null, ageYears: 38, localDate: '2026-08-01' },
      status: 'available', reasonCode: null, bmr: 1650, tdee: 2400,
      minimumDailyCalorieTarget: 1650, planOptions: [], dailyCalorieTarget: 1900,
      baseDailyCalorieTarget: 1900, targetAdjustment: currentPlan?.targetAdjustmentKcal ?? 0,
      sourceWeightKg: 82, deficit: scenario.input.configuredDailyDeficitKcal, missing: []
    },
    projection: null
  };
  const planningState = { current: planning, transactional: null };
  const service = loadCalibrationService({ prisma, planning: planningState, operations, trendModelVersion });
  return {
    scenario, serviceInput, captured, prisma, service, planningState,
    evidenceState: { logs, completionDays, weightRows },
    setBeforeMutation(callback) { beforeMutation = callback; },
    setPersistentMutationError(error) { persistentMutationError = error; },
    setScheduledRevision(revision) {
      scheduledRevisionState = revision;
      planningState.transactional = { ...planningState.current, nextRevision: revision, futureRevisions: [revision] };
    },
    getStoredRecommendation: () => storedRecommendation
  };
}

test('calibration status materializes a deterministic model-scoped recommendation', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);

  assert.equal(status.evaluation.status, 'recommendation');
  assert.equal(status.recommendation.id, 9);
  assert.equal(status.recommendation.effectiveLocalDate, '2026-08-02');
  assert.equal(harness.captured.upserts.length, 1);
  const { weightUnit: _displayWeightUnit, ...actionEvidence } = harness.serviceInput;
  assert.equal(status.inputFingerprint, fingerprint({
    modelVersion: CALIBRATION_MODEL_VERSION,
    caloriePolicyVersion: CALORIE_POLICY_VERSION,
    goalId: 41,
    planStartDate: '2026-06-01',
    actionEvidence
  }));
  assert.notEqual(status.inputFingerprint, fingerprint({
    goalId: 41,
    planStartDate: '2026-06-01',
    actionEvidence
  }));
  assert.notEqual(status.inputFingerprint, fingerprint({
    modelVersion: CALIBRATION_MODEL_VERSION,
    goalId: 41,
    planStartDate: '2026-06-01',
    input: harness.serviceInput
  }));
  assert.equal(
    harness.captured.weightQuery.where.date.gte.toISOString().slice(0, 10),
    '2026-06-19'
  );
});

test('calibration status maps paused food days into a post-break evidence restart', async () => {
  const pausedDates = [
    '2026-07-18', '2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23',
    '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28'
  ];
  const harness = createHarness({ pausedDates });
  const status = await harness.service.buildCalibrationStatus(7, new Date('2026-08-01T12:00:00.000Z'));

  assert.equal(status.evaluation.status, 'not_ready');
  assert.equal(status.evaluation.headline, 'Gathering new history after your break');
  assert.equal(status.evaluation.dataQuality.observationDays, 3);
  assert.equal(status.evaluation.dataQuality.confidentDays, 3);
  assert.equal(status.evaluation.dataQuality.incompleteDays, 0);
  assert.equal(status.evaluation.historyProgress.restartedAfterPause, true);
  assert.equal(status.recommendation, null);
});

test('calibration status acknowledges a pause started on the current incomplete day', async () => {
  const harness = createHarness({ todayStatus: 'PAUSED' });
  const status = await harness.service.buildCalibrationStatus(7, new Date('2026-08-01T12:00:00.000Z'));

  assert.equal(status.evaluation.asOfDate, '2026-07-31');
  assert.equal(status.evaluation.status, 'not_ready');
  assert.equal(status.evaluation.headline, 'Calibration is paused with food tracking');
  assert.equal(status.evaluation.summary, 'Paused days are excluded from calibration, so your break is not treated as uncertain intake.');
  assert.equal(status.evaluation.historyProgress.restartedAfterPause, true);
  assert.equal(status.recommendation, null);
  assert.equal(harness.captured.upserts.length, 0);
});

test('scheduled revisions suppress new materialization and report the resulting budget', async () => {
  const harness = createHarness({
    scheduledRevision: {
      recommendation_id: 8,
      target_adjustment_kcal: 0,
      effective_local_date: new Date('2026-08-02T00:00:00.000Z')
    }
  });
  const status = await harness.service.buildCalibrationStatus(7, new Date('2026-08-01T12:00:00.000Z'));

  assert.equal(status.recommendation, null);
  assert.deepEqual(status.scheduledChange, {
    recommendationId: 8,
    targetAdjustmentKcal: 0,
    dailyCalorieBudgetKcal: 1900,
    effectiveLocalDate: '2026-08-02'
  });
  assert.equal(harness.captured.upserts.length, 0);
  assert.ok(harness.captured.staleUpdates.some((update) => update.where.status === 'PENDING'));
});

test('v1 trend rollback suppresses v2 calibration recommendations without changing accepted revisions', async () => {
  const harness = createHarness({
    trendModelVersion: 1,
    scheduledRevision: {
      recommendation_id: 8,
      target_adjustment_kcal: 0,
      effective_local_date: new Date('2026-08-02T00:00:00.000Z')
    }
  });

  const status = await harness.service.buildCalibrationStatus(7, new Date('2026-08-01T12:00:00.000Z'));

  assert.equal(status.evaluation.status, 'not_ready');
  assert.equal(status.evaluation.headline, 'Calibration is temporarily unavailable');
  assert.equal(status.evaluation.assessment.blocker, 'trend_unavailable');
  assert.equal(status.inputFingerprint, null);
  assert.equal(status.recommendation, null);
  assert.deepEqual(status.scheduledChange, {
    recommendationId: 8,
    targetAdjustmentKcal: 0,
    dailyCalorieBudgetKcal: 1900,
    effectiveLocalDate: '2026-08-02'
  });
  assert.equal(harness.captured.upserts.length, 0);
  assert.ok(harness.captured.staleUpdates.some((update) => update.where.status === 'PENDING'));
});

test('applying a recommendation revalidates, schedules one revision, and replays safely', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);
  const result = await harness.service.applyCalibrationRecommendation({
    userId: 7,
    recommendationId: status.recommendation.id,
    operationId: 'calibration-op-0001',
    now
  });

  assert.deepEqual(result, {
    recommendationId: 9,
    targetAdjustmentKcal: -150,
    dailyCalorieBudgetKcal: 1750,
    effectiveLocalDate: '2026-08-02'
  });
  assert.deepEqual(harness.captured.operation.requestPayload, { recommendation_id: 9 });
  assert.equal(harness.captured.revision.source_goal_id, 41);
  assert.equal(harness.captured.revision.effective_local_date.toISOString().slice(0, 10), '2026-08-02');
  assert.equal(harness.captured.appliedAt, now);
  assert.equal(harness.captured.sync.payload.dailyCalorieBudgetKcal, 1750);

  const replay = await harness.service.applyCalibrationRecommendation({
    userId: 7,
    recommendationId: 9,
    operationId: 'calibration-op-0001',
    now
  });
  assert.deepEqual(replay, result);
});

test('recommendation apply retries the complete serializable mutation after a P2034 conflict', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);
  harness.setBeforeMutation(() => {
    throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
  });

  const result = await harness.service.applyCalibrationRecommendation({
    userId: 7,
    recommendationId: status.recommendation.id,
    operationId: 'calibration-retry-0001',
    now
  });

  assert.equal(harness.captured.operationAttempts, 2);
  assert.deepEqual(result, {
    recommendationId: 9,
    targetAdjustmentKcal: -150,
    dailyCalorieBudgetKcal: 1750,
    effectiveLocalDate: '2026-08-02'
  });
});

test('recommendation apply stops after three persistent P2034 conflicts', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);
  harness.setPersistentMutationError(
    Object.assign(new Error('persistent serialization conflict'), { code: 'P2034' })
  );

  await assert.rejects(
    harness.service.applyCalibrationRecommendation({
      userId: 7,
      recommendationId: status.recommendation.id,
      operationId: 'calibration-retry-0002',
      now
    }),
    /persistent serialization conflict/
  );
  assert.equal(harness.captured.operationAttempts, 3);
  assert.equal(harness.captured.revision, null);
});

test('canceling a future revision restores the recommendation for review', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);
  await harness.service.applyCalibrationRecommendation({
    userId: 7,
    recommendationId: status.recommendation.id,
    operationId: 'calibration-op-apply',
    now
  });

  const restored = await harness.service.cancelScheduledCalibrationChange({
    userId: 7,
    recommendationId: status.recommendation.id,
    operationId: 'calibration-op-cancel',
    now
  });

  assert.equal(harness.captured.deletedRevisionId, 12);
  assert.equal(harness.getStoredRecommendation().status, 'PENDING');
  assert.equal(harness.getStoredRecommendation().applied_at, null);
  assert.equal(restored.scheduledChange, null);
  assert.equal(restored.recommendation.id, status.recommendation.id);
  assert.equal(harness.captured.operation.operationKind, 'calibration_recommendation.cancel');
  assert.equal(harness.captured.sync.action, 'delete');
});

test('a scheduled revision cannot be canceled after its effective local date', async () => {
  const harness = createHarness();
  const applyNow = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, applyNow);
  await harness.service.applyCalibrationRecommendation({
    userId: 7,
    recommendationId: status.recommendation.id,
    operationId: 'calibration-op-apply',
    now: applyNow
  });

  await assert.rejects(
    harness.service.cancelScheduledCalibrationChange({
      userId: 7,
      recommendationId: status.recommendation.id,
      operationId: 'calibration-op-cancel-late',
      now: new Date('2026-08-02T12:00:00.000Z')
    }),
    /already started/
  );
  assert.equal(harness.captured.deletedRevisionId, null);
});

test('an APPLIED recommendation from an old goal cannot replay onto the current plan', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);
  await harness.service.applyCalibrationRecommendation({
    userId: 7, recommendationId: status.recommendation.id, operationId: 'calibration-old-goal-apply', now
  });
  harness.planningState.current = {
    ...harness.planningState.current,
    goal: { ...harness.planningState.current.goal, id: 42 }
  };
  await assert.rejects(
    harness.service.applyCalibrationRecommendation({
      userId: 7, recommendationId: status.recommendation.id, operationId: 'calibration-old-goal-replay', now
    }),
    /no longer matches the current calorie plan/
  );
});

test('recommendation apply rejects a profile or weight race that changes the exact target inside the transaction', async () => {
  const harness = createHarness();
  const now = new Date('2026-08-01T12:00:00.000Z');
  const status = await harness.service.buildCalibrationStatus(7, now);
  harness.planningState.transactional = {
    ...harness.planningState.current,
    evaluation: { ...harness.planningState.current.evaluation, tdee: 2300, dailyCalorieTarget: 1800 }
  };
  await assert.rejects(
    harness.service.applyCalibrationRecommendation({
      userId: 7, recommendationId: status.recommendation.id, operationId: 'calibration-race-apply', now
    }),
    /requires review before a recommendation can be applied/
  );
  assert.equal(harness.captured.revision, null);
});
test('calibration status returns Plan check assessments for maintenance and gain without actions', async () => {
  for (const scenarioId of ['maintenance', 'gain']) {
    const harness = createHarness({ scenarioId });
    const status = await harness.service.buildCalibrationStatus(7, new Date('2026-08-01T12:00:00.000Z'));

    assert.notEqual(status.evaluation.assessment.state, 'waiting');
    assert.equal(status.evaluation.recommendation, null);
    assert.equal(status.recommendation, null);
    assert.equal(harness.captured.upserts.length, 0);
  }
});


test('manual pace changes exclude the mixed adjustment day and invalidate earlier calibration evidence', async () => {
  const harness = createHarness({ currentPlan: { targetAdjustmentKcal: 0, effectiveLocalDate: new Date('2026-07-30Z') } });
  harness.planningState.current.effectiveRevision.configured_daily_deficit = 250;
  harness.planningState.current.goal.daily_deficit = 250;
  const status = await harness.service.buildCalibrationStatus(7, new Date('2026-08-01T12:00:00Z'));
  assert.equal(status.evaluation.dataQuality.observationDays, 1);
  assert.equal(status.recommendation, null);
  assert.equal(status.evaluation.status, 'not_ready');
  assert.equal(harness.planningState.current.goal.created_at.toISOString(), '2026-06-01T00:00:00.000Z');
});
