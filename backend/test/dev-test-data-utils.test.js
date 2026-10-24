/** @file Regression coverage for dev test data utils: devTestDataUtils: seed history is long enough for calibration recommendations. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCalibration } = require('../../shared/calibration');

const {
  addUtcDays,
  buildCompletedFoodLogDays,
  buildMealLogsForDay,
  DEV_SEED_FOOD_HISTORY_DAYS,
  getPastDateRangeDates,
  getMealTemplatesForSeedDayIndex,
  getPastWeekDates,
  getSeedUserCreatedAt,
  getSeedWeightGramsForDayIndex
} = require('../src/services/devTestDataUtils');

test('devTestDataUtils: seed history is long enough for calibration recommendations', () => {
  assert.equal(DEV_SEED_FOOD_HISTORY_DAYS, 28);
});

test('devTestDataUtils: seeded history produces a meaningful calibration result', () => {
  const now = new Date('2026-08-01T19:00:00Z');
  const foodDates = getPastDateRangeDates('America/Los_Angeles', DEV_SEED_FOOD_HISTORY_DAYS, now);
  const metricDates = getPastDateRangeDates('America/Los_Angeles', 120, now);
  const foodDays = foodDates.map((day, dayIndex) => {
    const logs = buildMealLogsForDay(1, day, dayIndex);
    return {
      date: day.toISOString().slice(0, 10),
      calories: logs.reduce((sum, log) => sum + log.calories, 0),
      entryCount: logs.length,
      mealPeriodCount: new Set(logs.map((log) => log.meal_period)).size,
      isComplete: true
    };
  });
  const weightPoints = metricDates.slice(-DEV_SEED_FOOD_HISTORY_DAYS).map((day, recentIndex) => {
    const dayIndex = metricDates.length - DEV_SEED_FOOD_HISTORY_DAYS + recentIndex;
    const weightKg = getSeedWeightGramsForDayIndex(dayIndex, 82000) / 1000;
    return {
      date: day.toISOString().slice(0, 10),
      weightKg
    };
  });

  const result = evaluateCalibration({
    asOfDate: foodDates.at(-1).toISOString().slice(0, 10),
    weightUnit: 'KG',
    ageYears: 36,
    bmrKcal: 1750,
    profileTdeeKcal: 2700,
    configuredDailyDeficitKcal: 500,
    currentTargetAdjustmentKcal: 0,
    foodDays,
    weightPoints
  });

  assert.notEqual(result.status, 'not_ready');
  assert.notEqual(result.status, 'learning');
  assert.equal(result.status, 'recommendation');
  assert.ok(result.selectedWindowDays >= 14);
  assert.equal(result.dataQuality.observationDays, result.selectedWindowDays);
  assert.equal(result.dataQuality.confidentDays, result.selectedWindowDays);
  assert.equal(result.dataQuality.weightSpanDays, result.selectedWindowDays - 1);
  assert.ok(result.estimates.averageIntakeKcal.midpoint >= 2050);
  assert.ok(result.estimates.averageIntakeKcal.midpoint <= 2200);
  assert.ok(Math.abs(result.estimates.observedWeeklyWeightChangeKg.midpoint) < Math.abs(result.estimates.configuredWeeklyWeightChangeKg));
  assert.equal(result.recommendation.adjustmentStepKcal, -150);
});

test('devTestDataUtils: addUtcDays adds days using UTC math without mutating the input', () => {
  const input = new Date('2025-01-15T12:34:56Z');
  const result = addUtcDays(input, 2);

  assert.equal(input.toISOString(), '2025-01-15T12:34:56.000Z');
  assert.equal(result.toISOString(), '2025-01-17T12:34:56.000Z');
});

test('devTestDataUtils: getPastWeekDates returns 7 UTC date-only values ending on the local day', () => {
  // 05:00Z is prior local day in America/Los_Angeles (UTC-8 in winter).
  const now = new Date('2025-01-02T05:00:00Z');
  const dates = getPastWeekDates('America/Los_Angeles', now);

  assert.equal(dates.length, 7);

  // Local day is 2025-01-01, so the seed week ends at that local day.
  assert.equal(dates[6].toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(dates[0].toISOString(), '2024-12-26T00:00:00.000Z');

  for (const date of dates) {
    assert.equal(date.getUTCHours(), 0);
    assert.equal(date.getUTCMinutes(), 0);
    assert.equal(date.getUTCSeconds(), 0);
    assert.equal(date.getUTCMilliseconds(), 0);
  }
});

test('devTestDataUtils: getPastDateRangeDates returns a date-only range with requested length', () => {
  const now = new Date('2025-01-02T05:00:00Z');
  const dates = getPastDateRangeDates('America/Los_Angeles', 30, now);

  assert.equal(dates.length, 30);
  assert.equal(dates[29].toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(dates[0].toISOString(), '2024-12-03T00:00:00.000Z');
});

test('devTestDataUtils: getSeedUserCreatedAt picks a UTC hour that preserves the earliest seed local day', () => {
  const seedDays = [new Date('2025-01-01T00:00:00Z')];

  const laCreatedAt = getSeedUserCreatedAt(seedDays, 'America/Los_Angeles');
  assert.equal(laCreatedAt.toISOString(), '2025-01-01T12:00:00.000Z');

  // Pacific/Kiritimati is UTC+14; noon UTC would land on the next local day, so we use 00:00 UTC.
  const kiritimatiCreatedAt = getSeedUserCreatedAt(seedDays, 'Pacific/Kiritimati');
  assert.equal(kiritimatiCreatedAt.toISOString(), '2025-01-01T00:00:00.000Z');
});

test('devTestDataUtils: getSeedUserCreatedAt falls back when the timezone is invalid', () => {
  const seedDays = [new Date('2025-01-01T00:00:00Z')];
  const createdAt = getSeedUserCreatedAt(seedDays, 'Not/AZone');
  assert.equal(createdAt.toISOString(), '2025-01-01T12:00:00.000Z');
});

test('devTestDataUtils: getMealTemplatesForSeedDayIndex returns deterministic week plans', () => {
  const day0 = getMealTemplatesForSeedDayIndex(0);
  assert.ok(day0.length > 0);
  assert.equal(day0[0].name, 'Spinach omelet');

  const day7 = getMealTemplatesForSeedDayIndex(7);
  assert.deepEqual(
    day7.map((item) => item.name),
    day0.map((item) => item.name)
  );

  assert.deepEqual(getMealTemplatesForSeedDayIndex(-1), []);
});

test('devTestDataUtils: buildMealLogsForDay stamps log timestamps using the template time-of-day', () => {
  const userId = 123;
  const day = new Date('2025-01-01T00:00:00Z');

  const logs = buildMealLogsForDay(userId, day, 0);
  assert.ok(logs.length > 0);

  assert.equal(logs[0].user_id, userId);
  assert.equal(logs[0].local_date.toISOString(), day.toISOString());
  assert.equal(logs[0].name, 'Spinach omelet');
  assert.equal(logs[0].date.toISOString(), '2025-01-01T07:00:00.000Z');
});

test('devTestDataUtils: buildCompletedFoodLogDays marks every seeded day as representative import data', () => {
  const days = [new Date('2025-01-01T00:00:00Z'), new Date('2025-01-02T00:00:00Z')];
  const completedAt = new Date('2025-01-03T08:00:00Z');

  assert.deepEqual(buildCompletedFoodLogDays(123, days, completedAt), [
    {
      user_id: 123,
      local_date: days[0],
      status: 'COMPLETE',
      origin: 'IMPORT',
      completed_at: completedAt
    },
    {
      user_id: 123,
      local_date: days[1],
      status: 'COMPLETE',
      origin: 'IMPORT',
      completed_at: completedAt
    }
  ]);
});

test('devTestDataUtils: getSeedWeightGramsForDayIndex yields a long-term downtrend with daily volatility', () => {
  const startWeight = 82000;
  const samples = Array.from({ length: 120 }, (_, dayIndex) =>
    getSeedWeightGramsForDayIndex(dayIndex, startWeight)
  );

  assert.equal(samples[0], getSeedWeightGramsForDayIndex(0, startWeight));
  assert.ok(samples[119] < samples[0] - 3000, 'expected at least ~3kg downward change over 120 days');

  const dayToDayChanges = samples.slice(1).map((weight, index) => weight - samples[index]);
  assert.ok(dayToDayChanges.some((change) => change > 0), 'expected at least one upward day');
  assert.ok(dayToDayChanges.some((change) => change < 0), 'expected at least one downward day');
});
