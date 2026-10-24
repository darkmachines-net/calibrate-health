/** @file Regression coverage for food day comparison: captures only the actual local day and preserves the first plan through reopen/recomplete and later settings. */

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const { captureFoodDayComparison, foodDayCalorieComparison } = require('../src/services/foodDayComparison');
const { getEffectiveFoodDay, getEffectiveFoodDayRange } = require('../src/services/foodTracking');
const now = new Date('2026-01-01T07:30:00Z'); // Still Dec 31 in Los Angeles.
function fixture() {
  const day = { id: 1, user_id: 7, local_date: new Date('2025-12-31T00:00:00Z'), status: 'COMPLETE', origin: 'USER', completed_at: now, updated_at: now };
  const user = { id: 7, created_at: new Date('2025-01-01Z'), timezone: 'America/Los_Angeles', date_of_birth: new Date('1990-01-01Z'), sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM' };
  const goal = { id: 1, user_id: 7, start_weight_grams: 90000, target_weight_grams: 80000, daily_deficit: 500, calorie_plan_review_status: 'CLEAR', created_at: now };
  let logs = [];
  const db = {
    $executeRaw: async () => 1,
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    user: { findUnique: async () => user },
    goal: { findFirst: async () => goal },
    bodyMetric: { findFirst: async () => ({ weight_grams: 90000 }) },
    caloriePlanRevision: { findFirst: async () => null, findMany: async () => [] },
    foodLogDay: { findUnique: async () => day, findFirst: async () => day, findMany: async () => [day], update: async ({data}) => Object.assign(day, data) },
    foodLog: { findFirst: async () => null, findMany: async () => logs },
    foodTrackingPause: { findFirst: async () => null, findMany: async () => [] }
  };
  return { db, day, user, goal, setLogs: value => { logs = value; } };
}
test('captures only the actual local day and preserves the first plan through reopen/recomplete and later settings', async () => {
  const {db, day, goal, user} = fixture();
  await captureFoodDayComparison(db, day, now);
  const before = foodDayCalorieComparison(day, 2000);
  assert.ok(before); assert.equal(before.maintenance_kcal - before.target_kcal, 500);
  goal.daily_deficit = -500; user.height_mm = 1900;
  day.status = 'OPEN'; await captureFoodDayComparison(db, day, now);
  day.status = 'COMPLETE'; await captureFoodDayComparison(db, day, new Date('2026-02-01Z'));
  assert.deepEqual(foodDayCalorieComparison(day, 2000), before);
});
test('does not reconstruct past/future history or turn unsafe plans into colors', async () => {
  for (const date of ['2025-12-30', '2026-01-01']) {
    const {db,day} = fixture(); day.local_date = new Date(date + 'T00:00:00Z');
    await captureFoodDayComparison(db, day, now);
    assert.equal(day.comparison_captured_at, date === '2025-12-30' ? now : undefined);
    assert.equal(foodDayCalorieComparison(day, 0), null);
  }
  const {db,day,goal} = fixture(); goal.calorie_plan_review_status = 'REQUIRES_REVIEW';
  await captureFoodDayComparison(db, day, now);
  assert.equal(day.comparison_target_kcal, null); assert.equal(foodDayCalorieComparison(day, 0), null);
  goal.calorie_plan_review_status = 'CLEAR'; await captureFoodDayComparison(db, day, now);
  assert.equal(foodDayCalorieComparison(day, 0), null);
});
test('uses the evaluated adjusted target while maintenance remains profile-estimated TDEE', async () => {
  const {db,day} = fixture();
  db.caloriePlanRevision.findFirst = async () => ({ id: 2, target_adjustment_kcal: 100, calorie_plan_review_status: 'CLEAR', effective_local_date: day.local_date });
  await captureFoodDayComparison(db, day, now);
  assert.equal(day.comparison_maintenance_kcal - day.comparison_target_kcal, 400);
  assert.ok(Number.isInteger(day.comparison_maintenance_kcal));
});
test('range returns known zero, sums immutable entry calories, keeps reopened comparisons, and rejects invalid totals', async () => {
  const {db,day,setLogs} = fixture(); await captureFoodDayComparison(db,day,now);
  const range = () => getEffectiveFoodDayRange(7,day.local_date,day.local_date,now,db);
  assert.equal((await range())[0].calorie_comparison.consumed_kcal, 0);
  setLogs([{local_date:day.local_date,calories:1000},{local_date:day.local_date,calories:500}]);
  assert.equal((await range())[0].calorie_comparison.consumed_kcal, 1500);
  day.status = 'OPEN'; assert.equal((await range())[0].calorie_comparison.consumed_kcal, 1500);
  day.status = 'INCOMPLETE'; assert.equal((await range())[0].calorie_comparison.consumed_kcal, 1500);
  day.status = 'PAUSED'; assert.equal((await range())[0].calorie_comparison, null);
  day.status = 'COMPLETE'; setLogs([{local_date:day.local_date,calories:2001}]);
  assert.equal((await range())[0].calorie_comparison.consumed_kcal, 2001);
  setLogs([{local_date:day.local_date,calories:-1}]); assert.equal((await range())[0].calorie_comparison,null);
});

test('unfinished days compare current intake to their retained local-day plan without freezing or rebuilding it', async () => {
  const {db, day, setLogs} = fixture();
  day.status = 'INCOMPLETE'; day.completed_at = null; day.local_date = new Date('2025-12-30T00:00:00Z');
  const observed = await db.dailyCaloriePlan.upsert({
    where: { user_id_local_date: { user_id: 7, local_date: day.local_date } },
    create: { user_id: 7, local_date: day.local_date, timezone: 'America/Los_Angeles', observed_at: new Date('2025-12-30T20:00:00Z'), target_kcal: 2000, maintenance_kcal: 2500 },
    update: {}
  });
  db.goal.findFirst = async () => { throw new Error('A past day must not use current settings'); };
  const range = async () => (await getEffectiveFoodDayRange(7, day.local_date, day.local_date, now, db))[0];
  for (const status of ['INCOMPLETE', 'OPEN']) {
    day.status = status;
    for (const consumed of [1000, 2300, 2600]) {
      setLogs([{ local_date: day.local_date, calories: consumed }]);
      const single = await getEffectiveFoodDay(7, day.local_date, now, db);
      assert.deepEqual(single.calorie_comparison, (await range()).calorie_comparison);
      assert.deepEqual(single.calorie_comparison, { consumed_kcal: consumed, target_kcal: 2000, maintenance_kcal: 2500, captured_at: observed.observed_at.toISOString() });
      assert.equal(day.comparison_captured_at, undefined);
      assert.equal(observed.consumed_at, null);
    }
  }
  day.status = 'COMPLETE'; await captureFoodDayComparison(db, day, now);
  assert.equal((await range()).calorie_comparison.target_kcal, 2000);
  assert.equal((await range()).calorie_comparison.consumed_kcal, 2600);
});

test('unfinished ranges reject missing, conflicted, wrong-zone and wrong-day observations, and leave empty days unstarted', async () => {
  const {db, day, setLogs} = fixture();
  day.status = 'INCOMPLETE'; day.completed_at = null;
  const plan = { user_id: 7, local_date: day.local_date, timezone: 'America/Los_Angeles', timezone_conflict: false, observed_at: now, target_kcal: 2000, maintenance_kcal: 2500 };
  setLogs([{ local_date: day.local_date, calories: 2300 }]);
  for (const invalid of [null, { ...plan, timezone_conflict: true }, { ...plan, timezone: 'UTC' },
    { ...plan, observed_at: new Date('2025-12-30T20:00:00Z') }, { ...plan, observed_at: new Date('2026-01-01T08:00:00Z') },
    { ...plan, target_kcal: null }]) {
    db.dailyCaloriePlan.findMany = async () => invalid ? [invalid] : [];
    assert.equal((await getEffectiveFoodDayRange(7, day.local_date, day.local_date, now, db))[0].calorie_comparison, null);
  }
  db.dailyCaloriePlan.findMany = async () => [plan]; db.foodLogDay.findMany = async () => [];
  const partial = (await getEffectiveFoodDayRange(7, day.local_date, day.local_date, now, db))[0];
  assert.equal(partial.status, 'OPEN'); assert.equal(partial.source, 'DEFAULT');
  assert.equal(partial.calorie_comparison.consumed_kcal, 2300);
  setLogs([]);
  const empty = (await getEffectiveFoodDayRange(7, new Date('2025-12-30Z'), new Date('2025-12-30Z'), now, db))[0];
  assert.equal(empty.source, 'INFERRED_EMPTY'); assert.equal(empty.calorie_comparison, undefined);
});

test('an invalid timezone leaves completion intact and comparison unavailable', async () => {
  const {db,day,user} = fixture(); user.timezone = 'Invalid/Timezone';
  assert.equal(await captureFoodDayComparison(db,day,now),day);
  assert.equal(day.status,'COMPLETE'); assert.equal(foodDayCalorieComparison(day,0),null);
});

test('single-day reads match calendar history without rebuilding the current plan', async () => {
  const {db, day, goal, setLogs} = fixture();
  await captureFoodDayComparison(db, day, now);
  const savedTarget = day.comparison_target_kcal;
  goal.daily_deficit = -500;
  db.goal.findFirst = async () => { throw new Error('Historical reads must not evaluate current goals'); };
  for (const calories of [[], [1000, 800], [2600], [-1], [Number.MAX_SAFE_INTEGER, 1]]) {
    setLogs(calories.map(value => ({local_date: day.local_date, calories: value})));
    const single = await getEffectiveFoodDay(7, day.local_date, now, db);
    const range = (await getEffectiveFoodDayRange(7, day.local_date, day.local_date, now, db))[0];
    assert.deepEqual(single.calorie_comparison, range.calorie_comparison);
    if (single.calorie_comparison) assert.equal(single.calorie_comparison.target_kcal, savedTarget);
  }
  day.status = 'OPEN';
  assert.equal((await getEffectiveFoodDay(7, day.local_date, now, db)).calorie_comparison, null);
});

test('single-day reads leave legacy, partial and invalid snapshots unavailable', async () => {
  const {db, day} = fixture();
  const saved = {comparison_target_kcal: 2000, comparison_maintenance_kcal: 2500, comparison_captured_at: now};
  db.foodLog.findMany = async () => { throw new Error('No intake read needed without a valid snapshot'); };
  for (const invalid of [
    {comparison_target_kcal: null, comparison_maintenance_kcal: null, comparison_captured_at: null},
    {...saved, comparison_target_kcal: undefined}, {...saved, comparison_maintenance_kcal: null},
    {...saved, comparison_captured_at: null}, {...saved, comparison_target_kcal: -1}
  ]) {
    Object.assign(day, invalid);
    const result = await getEffectiveFoodDay(7, day.local_date, now, db);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.calorie_comparison, null);
  }
});

test('retains adjusted target ordering when a positive-deficit plan crosses maintenance', async () => {
  const {db,day,goal} = fixture();
  goal.daily_deficit = 250;
  db.caloriePlanRevision.findFirst = async () => ({ id: 3, target_adjustment_kcal: 300, calorie_plan_review_status: 'CLEAR', effective_local_date: day.local_date });
  await captureFoodDayComparison(db,day,now);
  assert.equal(goal.daily_deficit,250);
  assert.equal(day.comparison_target_kcal - day.comparison_maintenance_kcal,50);
  assert.ok(foodDayCalorieComparison(day,day.comparison_maintenance_kcal - 1));
});
