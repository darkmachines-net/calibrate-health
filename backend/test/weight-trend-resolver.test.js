/** @file Regression coverage for weight trend resolver: weightTrend resolver: defaults to shared v2 and exports model version 2. */

const test = require('node:test');
const assert = require('node:assert/strict');

const sharedWeightTrend = require('../../shared/weightTrend.ts');
const { computeWeightTrendV1 } = require('../src/services/weightTrendV1');

const SERVICE_PATH = require.resolve('../src/services/weightTrend');
const MODEL_ENV_NAME = 'WEIGHT_TREND_MODEL';

function loadWeightTrendService(model) {
  const previousModel = process.env[MODEL_ENV_NAME];
  try {
    if (model === undefined) {
      delete process.env[MODEL_ENV_NAME];
    } else {
      process.env[MODEL_ENV_NAME] = model;
    }
    delete require.cache[SERVICE_PATH];
    return require('../src/services/weightTrend');
  } finally {
    if (previousModel === undefined) {
      delete process.env[MODEL_ENV_NAME];
    } else {
      process.env[MODEL_ENV_NAME] = previousModel;
    }
    delete require.cache[SERVICE_PATH];
  }
}

function fixtureObservations() {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-04', '2025-01-07', '2025-01-08', '2025-01-12'];
  const weights = [80, 79.8, 80.1, 79.6, 79.7, 79.3];
  return dates.map((date, index) => ({
    date: new Date(`${date}T00:00:00.000Z`),
    weight: weights[index]
  }));
}

function legacyPointFields(point) {
  return {
    date: point.date,
    weight: point.weight,
    trendWeight: point.trendWeight,
    trendStd: point.trendStd,
    lower95: point.lower95,
    upper95: point.upper95
  };
}

test('weightTrend resolver: defaults to shared v2 and exports model version 2', () => {
  const service = loadWeightTrendService(undefined);

  assert.equal(service.WEIGHT_TREND_MODEL_VERSION, 2);
  assert.deepEqual(
    service.computeWeightTrend(fixtureObservations()),
    sharedWeightTrend.computeWeightTrend(fixtureObservations())
  );
});

test('weightTrend resolver: explicit v2 returns the shared v2 model output', () => {
  const service = loadWeightTrendService('v2');
  const observations = fixtureObservations();
  const expected = sharedWeightTrend.computeWeightTrend(observations);
  const actual = service.computeWeightTrend(observations);

  assert.equal(service.WEIGHT_TREND_MODEL_VERSION, sharedWeightTrend.WEIGHT_TREND_MODEL_VERSION);
  assert.deepEqual(actual, expected);
  assert.ok(actual.points.every((point) => Number.isFinite(point.trendRateStdPerDay)));
});

test('weightTrend resolver: v1 preserves legacy levels and adapts unavailable v2 fields', () => {
  const service = loadWeightTrendService('v1');
  const observations = fixtureObservations();
  const legacy = computeWeightTrendV1(observations);
  const actual = service.computeWeightTrend(observations);

  assert.equal(service.WEIGHT_TREND_MODEL_VERSION, 1);
  assert.equal(actual.weeklyRate, legacy.weeklyRate);
  assert.equal(Number(actual.weeklyRate.toFixed(6)), -0.40825);
  assert.equal(actual.volatility, legacy.volatility);
  assert.deepEqual(actual.points.map(legacyPointFields), legacy.points.map(legacyPointFields));
  assert.deepEqual(
    {
      driftPerDay: actual.params.driftPerDay,
      processVariance: actual.params.processVariance,
      measurementVariance: actual.params.measurementVariance
    },
    legacy.params
  );
  assert.equal(actual.measurementVariabilityKg, Math.sqrt(legacy.params.measurementVariance));

  assert.equal(actual.currentRate.status, 'insufficient');
  assert.equal(actual.currentRate.direction, 'uncertain');
  assert.equal(Number.isFinite(actual.currentRate.estimateKgPerWeek), false);
  assert.equal(actual.currentRate.pointCount, 0);
  assert.equal(actual.windowAverageRate.status, 'insufficient');
  assert.equal(Number.isFinite(actual.windowAverageRate.estimateKgPerWeek), false);
  assert.ok(actual.points.every((point) => Number.isFinite(point.trendRatePerDay) === false));
  assert.ok(actual.points.every((point) => Number.isFinite(point.trendRateStdPerDay) === false));

  assert.deepEqual(actual.evidence, {
    pointCount: 6,
    spanDays: 11,
    segmentCount: 1,
    latestSegmentPointCount: 6,
    latestSegmentSpanDays: 11,
    effectiveObservationCount: 6,
    status: 'sufficient'
  });
  assert.equal(actual.segments.length, 1);
  assert.deepEqual(
    {
      id: actual.segments[0].id,
      startIndex: actual.segments[0].startIndex,
      endIndex: actual.segments[0].endIndex,
      pointCount: actual.segments[0].pointCount,
      spanDays: actual.segments[0].spanDays,
      resetGapDays: actual.segments[0].resetGapDays
    },
    {
      id: 1,
      startIndex: 0,
      endIndex: 5,
      pointCount: 6,
      spanDays: 11,
      resetGapDays: null
    }
  );
  assert.deepEqual(actual.points.map((point) => point.isSegmentStart), [true, false, false, false, false, false]);
});

test('weightTrend resolver: v1 honors the shared as-of option', () => {
  const service = loadWeightTrendService('v1');
  const observations = fixtureObservations();
  const asOfDate = new Date('2025-01-08T00:00:00.000Z');
  const expectedLegacy = computeWeightTrendV1(observations.slice(0, 5));
  const actual = service.computeWeightTrend(observations, { asOfDate });

  assert.deepEqual(actual.points.map(legacyPointFields), expectedLegacy.points.map(legacyPointFields));
  assert.equal(actual.asOfDate.getTime(), asOfDate.getTime());
});
