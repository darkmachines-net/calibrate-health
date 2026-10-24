/** @file Regression coverage for mcp progress: MCP food snapshot groups local days and averages only COMPLETE days. */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const { getRecentFoodLogs, getWeightTrend } = require('../src/services/mcpProgress');

const day = (value) => new Date(`${value}T00:00:00.000Z`);

const baseUser = {
  id: 7,
  created_at: new Date('2026-08-01T12:00:00.000Z'),
  timezone: 'America/Los_Angeles',
  date_of_birth: day('1990-01-01'),
  sex: 'MALE',
  height_mm: 1800,
  activity_level: 'MODERATE',
  weight_unit: 'KG',
  height_unit: 'CM'
};

const baseGoal = {
  id: 12,
  user_id: 7,
  start_weight_grams: 82_000,
  target_weight_grams: 75_000,
  daily_deficit: 500,
  target_date: null,
  created_at: new Date('2026-08-01T12:00:00.000Z'),
  calorie_plan_review_status: 'CLEAR',
  calorie_plan_review_reason: null
};

function planningDelegates(options = {}) {
  return {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    user: { findUnique: async () => ({ ...baseUser, ...(options.user ?? {}) }) },
    goal: { findFirst: async () => (options.goal === undefined ? baseGoal : options.goal) },
    caloriePlanRevision: {
      findFirst: async () => null,
      findMany: async () => []
    }
  };
}

test('MCP food snapshot groups local days and averages only COMPLETE days', async () => {
  let isolationLevel;
  const logs = [
    {
      local_date: day('2026-08-17'), meal_period: 'BREAKFAST', name: 'Oatmeal', calories: 500,
      servings_consumed: 1, serving_size_quantity_snapshot: 1, serving_unit_label_snapshot: 'bowl',
      created_at: new Date('2026-08-17T15:00:00.000Z'), id: 1,
      external_id: 'must-not-leak', barcode_snapshot: 'must-not-leak'
    },
    {
      local_date: day('2026-08-17'), meal_period: 'DINNER', name: 'Rice bowl', calories: 700,
      servings_consumed: 1.5, serving_size_quantity_snapshot: null, serving_unit_label_snapshot: null,
      created_at: new Date('2026-08-18T02:00:00.000Z'), id: 2
    },
    {
      local_date: day('2026-08-18'), meal_period: 'LUNCH', name: 'Sandwich', calories: 600,
      servings_consumed: 1, serving_size_quantity_snapshot: 1, serving_unit_label_snapshot: 'sandwich',
      created_at: new Date('2026-08-18T20:00:00.000Z'), id: 3
    }
  ];
  const storedDays = [
    {
      id: 1, user_id: 7, local_date: day('2026-08-17'), status: 'COMPLETE', origin: 'USER',
      completed_at: new Date('2026-08-18T04:00:00.000Z'), updated_at: new Date('2026-08-18T04:00:00.000Z')
    }
  ];
  const database = {
    ...planningDelegates(),
    bodyMetric: {
      findFirst: async ({ select }) => select?.weight_grams ? { weight_grams: 81_000 } : null
    },
    foodLogDay: {
      findFirst: async () => storedDays[0],
      findMany: async () => storedDays
    },
    foodTrackingPause: {
      findFirst: async () => null,
      findMany: async () => []
    },
    foodLog: {
      findFirst: async () => ({ local_date: day('2026-08-17') }),
      findMany: async ({ select }) => select?.name
        ? logs
        : [...new Map(logs.map((log) => [log.local_date.getTime(), { local_date: log.local_date }])).values()]
    }
  };
  database.$transaction = async (callback, options) => {
    isolationLevel = options?.isolationLevel;
    return callback(database);
  };

  const snapshot = await getRecentFoodLogs(7, {
    days: 3,
    now: new Date('2026-08-19T08:00:00.000Z'),
    database
  });

  assert.equal(snapshot.as_of_date, '2026-08-19');
  assert.deepEqual(snapshot.days.map((entry) => entry.date), [
    '2026-08-17', '2026-08-18', '2026-08-19'
  ]);
  assert.deepEqual(snapshot.days.map((entry) => entry.is_representative), [true, false, false]);
  assert.equal(snapshot.days[0].total_calories_kcal, 1200);
  assert.equal(snapshot.days[1].total_calories_kcal, 600);
  assert.deepEqual(snapshot.representative_summary, {
    complete_day_count: 1,
    total_calories_kcal: 1200,
    average_daily_calories_kcal: 1200
  });
  assert.deepEqual(snapshot.days[0].entries[0], {
    meal_period: 'BREAKFAST',
    name: 'Oatmeal',
    calories_kcal: 500,
    servings_consumed: 1,
    serving_size_quantity: 1,
    serving_unit: 'bowl'
  });
  assert.equal('external_id' in snapshot.days[0].entries[0], false);
  assert.equal('barcode_snapshot' in snapshot.days[0].entries[0], false);
  assert.ok(snapshot.calorie_target_context.profile_estimated_tdee_kcal > 0);
  assert.equal('tdee' in snapshot.calorie_target_context, false);
  assert.equal(isolationLevel, 'RepeatableRead');
});

test('MCP weight snapshot excludes future rows and returns the canonical trend in the preferred unit', async () => {
  let isolationLevel;
  const metrics = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    user_id: 7,
    date: day(`2026-08-${String(index + 1).padStart(2, '0')}`),
    weight_grams: 82_000 - index * 100
  }));
  metrics.push({ id: 99, user_id: 7, date: day('2026-08-22'), weight_grams: 70_000 });
  const database = {
    ...planningDelegates({ user: { weight_unit: 'LB' } }),
    bodyMetric: {
      findFirst: async ({ select }) => select?.weight_grams
        ? { weight_grams: metrics[20].weight_grams }
        : { date: metrics[20].date },
      findMany: async () => metrics
    }
  };
  database.$transaction = async (callback, options) => {
    isolationLevel = options?.isolationLevel;
    return callback(database);
  };

  const snapshot = await getWeightTrend(7, {
    days: 30,
    now: new Date('2026-08-21T19:00:00.000Z'),
    database
  });

  assert.equal(snapshot.weight_unit, 'lb');
  assert.equal(snapshot.points.length, 21);
  assert.equal(snapshot.points.some((point) => point.date === '2026-08-22'), false);
  assert.ok(snapshot.points.every((point) => !('user_id' in point) && !('body_fat_percent' in point)));
  assert.equal(snapshot.summary.freshness, 'current');
  assert.ok(snapshot.summary.latest_trend);
  assert.ok(snapshot.summary.weekly_rate);
  assert.equal(snapshot.summary.weekly_rate.unit, 'lb/week');
  assert.equal(snapshot.summary.weekly_rate.direction, 'down');
  assert.equal(snapshot.goal_context.direction, 'weight_loss');
  assert.equal(snapshot.goal_context.configured_daily_deficit_kcal, 500);
  assert.ok(snapshot.calorie_target_context.profile_estimated_tdee_kcal > 0);
  assert.equal(isolationLevel, 'RepeatableRead');
});

test('MCP weight snapshot nulls the pace when evidence is outdated and clamps the requested range', async () => {
  const oldMetric = { id: 1, user_id: 7, date: day('2026-07-01'), weight_grams: 80_000 };
  const database = {
    ...planningDelegates(),
    bodyMetric: {
      findFirst: async ({ select }) => select?.weight_grams
        ? { weight_grams: oldMetric.weight_grams }
        : { date: oldMetric.date },
      findMany: async () => [oldMetric]
    }
  };

  const snapshot = await getWeightTrend(7, {
    days: 1,
    now: new Date('2026-08-19T19:00:00.000Z'),
    database
  });

  assert.equal(snapshot.requested_days, 7);
  assert.equal(snapshot.points.length, 0);
  assert.equal(snapshot.summary.latest_observation_date, '2026-07-01');
  assert.equal(snapshot.summary.freshness, 'outdated');
  assert.equal(snapshot.summary.status, 'insufficient');
  assert.equal(snapshot.summary.weekly_rate, null);
});
