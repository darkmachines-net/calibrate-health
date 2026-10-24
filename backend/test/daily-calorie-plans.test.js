/** @file Regression coverage for daily calorie plans: observe D, change all inputs on D+1, complete D keeps the last D plan and its original inputs. */

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { observeCurrentCaloriePlan, invalidateDailyPlanTimezone } = require('../src/services/dailyCaloriePlans');
const { buildStoredCaloriePlanningSnapshot } = require('../src/services/caloriePlanning');
const { captureFoodDayComparison, readFoodDayComparison } = require('../src/services/foodDayComparison');

function fixture(timezone = 'America/Los_Angeles') {
  const user = { id: 7, timezone, date_of_birth: new Date('1990-01-01Z'), sex: 'MALE', height_mm: 1800,
    activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM' };
  const goal = { id: 3, user_id: 7, start_weight_grams: 90000, target_weight_grams: 80000,
    daily_deficit: 500, calorie_plan_review_status: 'CLEAR', created_at: new Date('2025-01-01Z') };
  const day = { id: 5, user_id: 7, local_date: new Date('2026-03-07Z'), status: 'COMPLETE', comparison_captured_at: null };
  const revision = { id: 4, configured_daily_deficit: 250, target_adjustment_kcal: 100,
    effective_local_date: new Date('2026-03-01Z'), calorie_plan_review_status: 'CLEAR' };
  const weight = { id: 9, date: new Date('2026-03-07Z'), weight_grams: 85000 };
  let calories = 1800;
  const db = { $executeRaw: async () => 1, dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    user: { findUnique: async () => ({ ...user }) }, goal: { findFirst: async () => ({ ...goal }) },
    bodyMetric: { findFirst: async () => ({ ...weight }) },
    caloriePlanRevision: { findFirst: async () => ({ ...revision }), findMany: async () => [] },
    foodLogDay: { update: async ({ data }) => Object.assign(day, data) },
    foodLog: { findMany: async () => [{ calories }] }
  };
  return { db, day, user, goal, revision, weight, intake: value => { calories = value; } };
}

test('observe D, change all inputs on D+1, complete D keeps the last D plan and its original inputs', async () => {
  const f = fixture();
  const first = new Date('2026-03-08T06:00:00Z'), last = new Date('2026-03-08T07:59:59Z');
  await observeCurrentCaloriePlan(f.db, 7, first);
  f.revision.configured_daily_deficit = 500;
  const plan = await observeCurrentCaloriePlan(f.db, 7, last);
  const evidence = structuredClone(f.db.dailyCaloriePlan.rows[0]);
  f.goal.id = 8; f.user.height_mm = 1900; f.weight.weight_grams = 90000; f.revision.target_adjustment_kcal = 0;
  const nextDay = new Date('2026-03-08T08:00:01Z');
  await observeCurrentCaloriePlan(f.db, 7, nextDay);
  await captureFoodDayComparison(f.db, f.day, nextDay);
  const comparison = await readFoodDayComparison(f.db, f.day);
  assert.equal(comparison.target_kcal, plan.evaluation.dailyCalorieTarget);
  assert.equal(comparison.captured_at, nextDay.toISOString());
  assert.equal(evidence.observed_at.toISOString(), last.toISOString());
  assert.equal(evidence.inputs.goal.id, 3);
  assert.equal(evidence.inputs.pace_revision.id, 4);
  assert.equal(evidence.inputs.weight_metric.id, 9);
  assert.equal(evidence.inputs.profile.height_mm, 1800);
  assert.equal(f.db.dailyCaloriePlan.rows[0].consumed_at, nextDay);
  f.day.status = 'OPEN'; assert.deepEqual(await readFoodDayComparison(f.db, f.day), comparison);
  f.day.status = 'COMPLETE'; f.intake(1700);
  await captureFoodDayComparison(f.db, f.day, new Date('2026-04-01Z'));
  assert.deepEqual(await readFoodDayComparison(f.db, f.day), { ...comparison, consumed_kcal: 1700 });
});

test('available/unavailable transitions replace evidence until consumed, then stay frozen', async () => {
  for (const finalAvailable of [false, true]) {
    const f = fixture();
    await observeCurrentCaloriePlan(f.db, 7, new Date('2026-03-07T18:00:00Z'));
    f.user.height_mm = null;
    await observeCurrentCaloriePlan(f.db, 7, new Date('2026-03-07T19:00:00Z'));
    assert.equal(f.db.dailyCaloriePlan.rows[0].target_kcal, null);
    if (finalAvailable) f.user.height_mm = 1800;
    await captureFoodDayComparison(f.db, f.day, new Date('2026-03-07T20:00:00Z'));
    const retained = structuredClone(f.db.dailyCaloriePlan.rows[0]);
    assert.equal(Boolean(await readFoodDayComparison(f.db, f.day)), finalAvailable);
    f.user.height_mm = finalAvailable ? null : 1800;
    await observeCurrentCaloriePlan(f.db, 7, new Date('2026-03-07T21:00:00Z'));
    assert.deepEqual(f.db.dailyCaloriePlan.rows[0], retained);
  }
});

test('pure calculations and missing past observations never manufacture history', async () => {
  const f = fixture();
  await buildStoredCaloriePlanningSnapshot(f.db, 7, new Date('2026-03-07T18:00:00Z'));
  assert.equal(f.db.dailyCaloriePlan.rows.length, 0);
  await captureFoodDayComparison(f.db, f.day, new Date('2026-03-09Z'));
  assert.equal(f.db.dailyCaloriePlan.rows.length, 0);
  assert.equal(await readFoodDayComparison(f.db, f.day), null);
  assert.ok(f.day.comparison_captured_at);
});

test('timezone edits and conflicting date observations cannot be relabeled, even after returning', async () => {
  for (const explicitEdit of [false, true]) {
    const f = fixture();
    const now = new Date('2026-03-07T20:00:00Z');
    await observeCurrentCaloriePlan(f.db, 7, now);
    if (explicitEdit) await invalidateDailyPlanTimezone(f.db, 7, f.user.timezone, 'UTC', now);
    f.user.timezone = 'UTC';
    await observeCurrentCaloriePlan(f.db, 7, now);
    f.user.timezone = 'America/Los_Angeles';
    await captureFoodDayComparison(f.db, f.day, now);
    assert.equal(f.db.dailyCaloriePlan.rows[0].timezone, 'America/Los_Angeles');
    assert.equal(f.db.dailyCaloriePlan.rows[0].timezone_conflict, true);
    assert.equal(await readFoodDayComparison(f.db, f.day), null);
  }
});

test('DST repeated hours retain one date and midnight creates a new observation without overwriting yesterday', async () => {
  const f = fixture();
  for (const iso of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-02T07:59:59Z']) {
    await observeCurrentCaloriePlan(f.db, 7, new Date(iso));
  }
  assert.equal(f.db.dailyCaloriePlan.rows.length, 1);
  assert.equal(f.db.dailyCaloriePlan.rows[0].local_date.toISOString().slice(0, 10), '2026-11-01');
  await observeCurrentCaloriePlan(f.db, 7, new Date('2026-11-02T08:00:00Z'));
  assert.equal(f.db.dailyCaloriePlan.rows.length, 2);
});
