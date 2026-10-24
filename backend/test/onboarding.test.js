/** @file Regression coverage for onboarding: completion parser accepts one complete payload and rejects incomplete or underage input. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const {
  completeOnboardingInTransaction,
  parseCompleteOnboardingBody
} = require('../src/services/onboarding');

const NOW = new Date('2026-03-08T07:30:00.000Z');
const COMPLETE_DATA = {
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'America/Los_Angeles',
  date_of_birth: '1990-06-15',
  sex: 'FEMALE',
  height_mm: 1680,
  activity_level: 'MODERATE',
  current_weight_grams: 82000,
  target_weight_grams: 70000,
  daily_deficit: 500
};

function initialState({ goal = null } = {}) {
  return {
    user: {
      id: 7,
      email: 'person@example.com',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      onboarding_completed_at: null,
      weight_unit: 'KG',
      height_unit: 'CM',
      timezone: 'UTC',
      language: 'en',
      reminder_log_weight_enabled: true,
      reminder_log_food_enabled: true,
      haptics_enabled: true,
      date_of_birth: null,
      sex: null,
      height_mm: null,
      activity_level: null,
      profile_image: null,
      profile_image_mime_type: null,
      legal_acceptances: []
    },
    metric: null,
    goal,
    syncMarker: null,
    existingResponse: null
  };
}

function createCounters() {
  return {
    userWrites: 0,
    metricUpserts: 0,
    goalCreates: 0,
    goalUpdates: 0,
    syncWrites: 0
  };
}

function createTransactionStub(state, counters) {
  return {
    $queryRawUnsafe: async () => [{ id: state.user.id }],
    $executeRaw: async () => 1,
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    caloriePlanRevision: { findFirst: async () => null, findMany: async () => [] },
    user: {
      findUnique: async () => ({ ...state.user }),
      update: async ({ data }) => {
        Object.assign(state.user, data);
        counters.userWrites += 1;
        return { ...state.user };
      }
    },
    bodyMetric: {
      findFirst: async () => state.metric,
      upsert: async ({ where, update, create }) => {
        counters.metricUpserts += 1;
        state.metric = {
          id: state.metric?.id ?? 31,
          user_id: create.user_id,
          date: where.user_id_date.date,
          weight_grams: update.weight_grams
        };
        return state.metric;
      }
    },
    goal: {
      findFirst: async () => state.goal,
      update: async ({ data }) => {
        counters.goalUpdates += 1;
        state.goal = { ...state.goal, ...data };
        return state.goal;
      },
      create: async ({ data }) => {
        counters.goalCreates += 1;
        state.goal = { id: 41, created_at: NOW, ...data };
        return state.goal;
      }
    },
    syncChange: {
      create: async ({ data }) => {
        counters.syncWrites += 1;
        state.syncMarker = { id: 51n, ...data };
        return state.syncMarker;
      }
    },
    clientOperation: {
      findFirst: async () =>
        state.existingResponse ? { response_body: state.existingResponse } : null
    }
  };
}

async function runTransaction(state, operationId, input, options = {}) {
  const working = structuredClone(state);
  const writeCounters = createCounters();
  const result = await completeOnboardingInTransaction(
    createTransactionStub(working, writeCounters),
    7,
    operationId,
    input,
    options
  );
  Object.assign(state, working);
  return { result, writeCounters };
}

test('completion parser accepts one complete payload and rejects incomplete or underage input', () => {
  assert.deepEqual(parseCompleteOnboardingBody({ data: COMPLETE_DATA }), {
    ok: true,
    value: { data: COMPLETE_DATA }
  });
  const missing = parseCompleteOnboardingBody({ data: { ...COMPLETE_DATA, timezone: undefined } });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.fieldErrors, { timezone: ['This field is required.'] });

  const underage = parseCompleteOnboardingBody({
    data: { ...COMPLETE_DATA, date_of_birth: '2012-06-15' }
  });
  assert.equal(underage.ok, false);
  assert.deepEqual(underage.fieldErrors, {
    date_of_birth: ['Calibrate accounts require age 18 or older.']
  });
});

test('atomic completion uses the submitted timezone day and updates an existing goal without duplication', async () => {
  const state = initialState({
    goal: {
      id: 99,
      user_id: 7,
      start_weight_grams: 90000,
      target_weight_grams: 80000,
      daily_deficit: 250
    }
  });
  const { result, writeCounters } = await runTransaction(
    state,
    'operation-1',
    { data: COMPLETE_DATA },
    { now: NOW }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.receipt.operation_id, 'operation-1');
  assert.equal(state.metric.date.toISOString(), '2026-03-07T00:00:00.000Z');
  assert.equal(state.goal.id, 99);
  assert.equal(state.goal.daily_deficit, 500);
  assert.ok(state.user.onboarding_completed_at instanceof Date);
  assert.deepEqual(writeCounters, {
    userWrites: 2,
    metricUpserts: 1,
    goalCreates: 0,
    goalUpdates: 1,
    syncWrites: 1
  });
});

test('a later operation returns the first completion receipt without duplicate domain writes', async () => {
  const state = initialState();
  const first = await runTransaction(state, 'operation-1', { data: COMPLETE_DATA }, { now: NOW });
  state.existingResponse = first.result.body;
  const second = await runTransaction(state, 'operation-2', { data: COMPLETE_DATA }, { now: NOW });

  assert.equal(second.result.status, 200);
  assert.deepEqual(second.result.body, first.result.body);
  assert.deepEqual(second.writeCounters, createCounters());
});

test('representative injected failures leave the committed state unchanged', async () => {
  for (const stage of ['profile', 'metric', 'goal', 'sync_marker', 'completion']) {
    const state = initialState();
    const before = structuredClone(state);
    await assert.rejects(
      runTransaction(state, `operation-${stage}`, { data: COMPLETE_DATA }, {
        now: NOW,
        afterWrite: (completedStage) => {
          if (completedStage === stage) throw new Error(`fail-${stage}`);
        }
      }),
      new RegExp(`fail-${stage}`)
    );
    assert.deepEqual(state, before);
  }
});

test('atomic onboarding migration adds only the completion marker and backfills complete legacy accounts', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '../prisma/migrations/0036_atomic_onboarding/migration.sql'),
    'utf8'
  );
  assert.match(migration, /ADD COLUMN "onboarding_completed_at"/);
  assert.doesNotMatch(migration, /OnboardingDraft/);
  assert.match(migration, /"date_of_birth" IS NOT NULL/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM "BodyMetric"/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM "Goal"/);
});
