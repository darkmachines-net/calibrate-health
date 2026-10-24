/** @file Regression coverage for weight trend benchmark: weight trend benchmark: recovers representative steady rates without outlier-driven reversal. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const { computeWeightTrend } = require('../../shared/weightTrend.ts');
const { computeWeightTrendV1 } = require('../src/services/weightTrendV1');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function gaussian(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function buildScenario({ days, weeklyRateKg, noiseStdKg, seed, outlierEvery = 0 }) {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const random = seededRandom(seed);
  return Array.from({ length: days }, (_unused, index) => ({
    date: new Date(startMs + index * MS_PER_DAY),
    weight: 85 + weeklyRateKg * index / 7 + gaussian(random) * noiseStdKg
      + (outlierEvery > 0 && index > 0 && index % outlierEvery === 0 ? 5 : 0)
  }));
}

function computeTrend(observations, options = {}) {
  const cutoffMs = options.asOfDate instanceof Date
    ? options.asOfDate.getTime()
    : Number.POSITIVE_INFINITY;
  const eligible = observations
    .filter((point) => point.date.getTime() <= cutoffMs)
    .slice()
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const latestDate = eligible.at(-1)?.date;
  const calibrationWindow = latestDate
    ? {
        startDate: new Date(latestDate.getTime() - 28 * MS_PER_DAY),
        endDate: new Date(latestDate.getTime())
      }
    : undefined;
  return computeWeightTrend(observations, { ...options, calibrationWindow });
}
test('weight trend benchmark: recovers representative steady rates without outlier-driven reversal', () => {
  const cases = [
    { weeklyRateKg: -0.9, noiseStdKg: 0.4, seed: 31, outlierEvery: 0 },
    { weeklyRateKg: -0.5, noiseStdKg: 0.35, seed: 11, outlierEvery: 0 },
    { weeklyRateKg: 0.35, noiseStdKg: 0.4, seed: 17, outlierEvery: 0 },
    { weeklyRateKg: 0.9, noiseStdKg: 0.4, seed: 37, outlierEvery: 0 },
    { weeklyRateKg: -0.4, noiseStdKg: 0.3, seed: 23, outlierEvery: 13 }
  ];

  for (const scenario of cases) {
    const result = computeTrend(buildScenario({ days: 90, ...scenario }));
    assert.ok(
      Math.abs(result.windowAverageRate.estimateKgPerWeek - scenario.weeklyRateKg) < 0.2,
      `expected ${scenario.weeklyRateKg}, received ${result.windowAverageRate.estimateKgPerWeek}`
    );
    assert.equal(result.windowAverageRate.direction, scenario.weeklyRateKg < 0 ? 'down' : 'up');
    assert.equal(result.windowAverageRate.status, 'confident');
  }
});

test('weight trend benchmark: seeded level and window-average pace intervals achieve 90%-98% empirical coverage', () => {
  let levelCovered = 0;
  let levelEvaluated = 0;
  let rateCovered = 0;
  const scenarioCount = 120;
  for (let seed = 1; seed <= scenarioCount; seed += 1) {
    const observations = buildScenario({
      days: 60,
      weeklyRateKg: -0.35,
      noiseStdKg: 0.9,
      seed
    });
    const result = computeTrend(observations);
    for (let index = 14; index < result.points.length; index += 1) {
      const latent = 85 - 0.35 * index / 7;
      const point = result.points[index];
      levelCovered += point.lower95 <= latent && latent <= point.upper95 ? 1 : 0;
      levelEvaluated += 1;
    }
    rateCovered += result.windowAverageRate.lower95KgPerWeek <= -0.35 &&
      -0.35 <= result.windowAverageRate.upper95KgPerWeek ? 1 : 0;
  }

  const levelCoverage = levelCovered / levelEvaluated;
  const rateCoverage = rateCovered / scenarioCount;
  assert.ok(levelCoverage >= 0.9 && levelCoverage <= 0.98, `level coverage was ${levelCoverage}`);
  assert.ok(rateCoverage >= 0.9 && rateCoverage <= 0.98, `rate coverage was ${rateCoverage}`);
});

test('weight trend benchmark: local velocity-state intervals achieve 90%-98% process coverage', () => {
  let covered = 0;
  const scenarioCount = 120;
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  for (let seed = 1; seed <= scenarioCount; seed += 1) {
    const random = seededRandom(seed);
    let latentLevelKg = 85;
    let latentRateKgPerDay = -0.35 / 7;
    const observations = [];
    for (let day = 0; day < 60; day += 1) {
      if (day > 0) {
        latentRateKgPerDay += gaussian(random) * 0.007;
        latentLevelKg += latentRateKgPerDay;
      }
      observations.push({
        date: new Date(startMs + day * MS_PER_DAY),
        weight: latentLevelKg + gaussian(random) * 0.9
      });
    }

    const result = computeTrend(observations);
    const currentRateKgPerWeek = latentRateKgPerDay * 7;
    covered += result.currentRate.lower95KgPerWeek <= currentRateKgPerWeek &&
      currentRateKgPerWeek <= result.currentRate.upper95KgPerWeek ? 1 : 0;
  }

  const coverage = covered / scenarioCount;
  assert.ok(coverage >= 0.9 && coverage <= 0.98, `velocity-state coverage was ${coverage}`);
});

test('weight trend benchmark: causal stable and linear level RMSE is no more than 5% worse than v1', () => {
  const weeklyRates = [0, -0.5];
  for (const weeklyRateKg of weeklyRates) {
    let levelSquaredError = 0;
    let v1LevelSquaredError = 0;
    let levelCount = 0;
    let rateSquaredError = 0;
    const scenarioCount = 120;
    for (let seed = 1; seed <= scenarioCount; seed += 1) {
      const observations = buildScenario({ days: 60, weeklyRateKg, noiseStdKg: 0.6, seed });
      const result = computeTrend(observations);
      for (let index = 14; index < result.points.length; index += 1) {
        const latent = 85 + weeklyRateKg * index / 7;
        levelSquaredError += (result.points[index].trendWeight - latent) ** 2;
        const v1AsOfPoint = computeWeightTrendV1(observations.slice(0, index + 1)).points.at(-1);
        v1LevelSquaredError += (v1AsOfPoint.trendWeight - latent) ** 2;
        levelCount += 1;
      }
      rateSquaredError += (result.windowAverageRate.estimateKgPerWeek - weeklyRateKg) ** 2;
    }

    const levelRmse = Math.sqrt(levelSquaredError / levelCount);
    const v1LevelRmse = Math.sqrt(v1LevelSquaredError / levelCount);
    const rateRmse = Math.sqrt(rateSquaredError / scenarioCount);
    assert.ok(levelRmse <= 0.26, `level RMSE for ${weeklyRateKg} kg/week was ${levelRmse}`);
    assert.ok(
      levelRmse <= v1LevelRmse * 1.05,
      `v2 level RMSE ${levelRmse} exceeded v1 ${v1LevelRmse} by more than 5%`
    );
    assert.ok(rateRmse <= 0.12, `rate RMSE for ${weeklyRateKg} kg/week was ${rateRmse}`);
  }
});

test('weight trend benchmark: a sustained reversal becomes confidently visible within 14 days', () => {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const observations = [];
  for (let index = 0; index < 60; index += 1) {
    observations.push({
      date: new Date(startMs + index * MS_PER_DAY),
      weight: 80 + 0.35 * index / 7 + (index % 2 === 0 ? -0.15 : 0.15)
    });
  }
  const reversalWeight = 80 + 0.35 * 59 / 7;
  for (let day = 1; day <= 14; day += 1) {
    observations.push({
      date: new Date(startMs + (59 + day) * MS_PER_DAY),
      weight: reversalWeight - 0.7 * day / 7 + (day % 2 === 0 ? -0.15 : 0.15)
    });
  }

  const result = computeTrend(observations);
  assert.equal(result.currentRate.direction, 'down');
  assert.equal(result.currentRate.status, 'confident');
  assert.ok(result.currentRate.estimateKgPerWeek < 0);
  assert.equal(result.windowAverageRate.direction, 'down');
  assert.equal(result.windowAverageRate.status, 'confident');
  assert.ok(result.windowAverageRate.estimateKgPerWeek < -0.1);
  assert.ok(result.points[result.points.length - 1].trendRatePerDay < 0);
});

test('weight trend benchmark: local v2 pace changes direction sooner than v1 after a reversal', () => {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const observations = [];
  for (let index = 0; index < 60; index += 1) {
    observations.push({
      date: new Date(startMs + index * MS_PER_DAY),
      weight: 80 + 0.35 * index / 7 + (index % 2 === 0 ? -0.15 : 0.15)
    });
  }
  const reversalWeight = 80 + 0.35 * 59 / 7;
  let v2ReversalLagDays = Number.POSITIVE_INFINITY;
  let v2ConfidentReversalLagDays = Number.POSITIVE_INFINITY;
  let v1ReversalLagDays = Number.POSITIVE_INFINITY;
  for (let day = 1; day <= 14; day += 1) {
    observations.push({
      date: new Date(startMs + (59 + day) * MS_PER_DAY),
      weight: reversalWeight - 0.7 * day / 7 + (day % 2 === 0 ? -0.15 : 0.15)
    });
    const v2 = computeTrend(observations);
    const v1 = computeWeightTrendV1(observations);
    if (v2.currentRate.estimateKgPerWeek < 0 && !Number.isFinite(v2ReversalLagDays)) {
      v2ReversalLagDays = day;
    }
    if (
      v2.currentRate.direction === 'down' &&
      v2.currentRate.status === 'confident' &&
      !Number.isFinite(v2ConfidentReversalLagDays)
    ) {
      v2ConfidentReversalLagDays = day;
    }
    if (v1.weeklyRate < 0 && !Number.isFinite(v1ReversalLagDays)) {
      v1ReversalLagDays = day;
    }
  }

  assert.ok(v2ReversalLagDays < v1ReversalLagDays, `v2 lag ${v2ReversalLagDays}, v1 lag ${v1ReversalLagDays}`);
  assert.ok(v2ConfidentReversalLagDays <= 14, `v2 confidence lag ${v2ConfidentReversalLagDays}`);
});

test('weight trend benchmark: plateau after loss is recognized as steady', () => {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const observations = [];
  for (let index = 0; index < 28; index += 1) {
    observations.push({
      date: new Date(startMs + index * MS_PER_DAY),
      weight: 85 - 0.5 * index / 7 + (index % 2 === 0 ? -0.1 : 0.1)
    });
  }
  const plateauWeight = 85 - 0.5 * 27 / 7;
  for (let day = 1; day <= 28; day += 1) {
    observations.push({
      date: new Date(startMs + (27 + day) * MS_PER_DAY),
      weight: plateauWeight + (day % 2 === 0 ? -0.1 : 0.1)
    });
  }

  const result = computeTrend(observations);
  assert.equal(result.windowAverageRate.direction, 'steady');
  assert.equal(result.windowAverageRate.status, 'confident');
  assert.ok(Math.abs(result.windowAverageRate.estimateKgPerWeek) < 0.03);
});

test('weight trend benchmark: isolated spikes are damped and recover within two weeks', () => {
  const baseline = Array.from({ length: 70 }, (_unused, index) => ({
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * MS_PER_DAY),
    weight: 85 - 0.4 * index / 7 + (index % 2 === 0 ? -0.2 : 0.2)
  }));
  const spiked = baseline.map((point, index) => ({
    ...point,
    weight: point.weight + (index === 30 ? 8 : 0)
  }));
  const baselineResult = computeTrend(baseline);
  const spikeResult = computeTrend(spiked);

  assert.ok(spikeResult.points[30].huberWeight < 0.2);
  assert.ok(Math.abs(spikeResult.points[30].trendWeight - baselineResult.points[30].trendWeight) < 0.4);
  assert.ok(Math.abs(spikeResult.points[44].trendWeight - baselineResult.points[44].trendWeight) < 0.02);
  assert.ok(Math.abs(spikeResult.windowAverageRate.estimateKgPerWeek + 0.4) < 0.03);
});

test('weight trend benchmark: positive and negative three-kilogram spikes do not cause a lasting reversal', () => {
  const baseline = Array.from({ length: 70 }, (_unused, index) => ({
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * MS_PER_DAY),
    weight: 85 - 0.4 * index / 7 + (index % 2 === 0 ? -0.2 : 0.2)
  }));
  const baselineResult = computeTrend(baseline);

  for (const spikeKg of [3, -3]) {
    const spiked = baseline.map((point, index) => ({
      ...point,
      weight: point.weight + (index === 30 ? spikeKg : 0)
    }));
    const result = computeTrend(spiked);
    assert.ok(result.points[30].huberWeight < 0.5);
    assert.ok(Math.abs(result.points[30].trendWeight - baselineResult.points[30].trendWeight) < 0.3);
    assert.ok(Math.abs(result.points[44].trendWeight - baselineResult.points[44].trendWeight) < 0.06);
    assert.equal(result.windowAverageRate.direction, 'down');
    assert.equal(result.windowAverageRate.status, 'confident');
  }
});

test('weight trend benchmark: a short hydration outlier run does not leave a lasting direction reversal', () => {
  const baseline = Array.from({ length: 70 }, (_unused, index) => ({
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * MS_PER_DAY),
    weight: 85 - 0.4 * index / 7 + (index % 2 === 0 ? -0.2 : 0.2)
  }));
  const baselineResult = computeTrend(baseline);
  const withOutlierRun = baseline.map((point, index) => ({
    ...point,
    weight: point.weight + (index >= 30 && index <= 32 ? 3 : 0)
  }));
  const result = computeTrend(withOutlierRun);

  assert.ok(Math.abs(result.points[44].trendWeight - baselineResult.points[44].trendWeight) < 0.2);
  assert.equal(result.windowAverageRate.direction, 'down');
  assert.equal(result.windowAverageRate.status, 'confident');
});

test('weight trend benchmark: actual-date pace survives cadence changes without inventing continuity', () => {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const daily = Array.from({ length: 29 }, (_unused, day) => ({
    date: new Date(startMs + day * MS_PER_DAY),
    weight: 82 - 0.42 * day / 7
  }));
  const mixedCadence = daily.filter((_point, day) => day < 8 || day % 3 === 1 || day === 28);
  const dailyResult = computeTrend(daily);
  const mixedResult = computeTrend(mixedCadence);

  assert.ok(Math.abs(dailyResult.windowAverageRate.estimateKgPerWeek + 0.42) < 1e-10);
  assert.ok(Math.abs(mixedResult.windowAverageRate.estimateKgPerWeek + 0.42) < 1e-10);
  assert.equal(mixedResult.segments.length, 1);
  assert.ok(mixedResult.points.some((point) => point.gapDays === 3));

  const afterGap = computeTrend([
    ...mixedCadence,
    { date: new Date(startMs + 44 * MS_PER_DAY), weight: 79 }
  ]);
  assert.equal(afterGap.segments.length, 2);
  assert.equal(afterGap.points[afterGap.points.length - 1].isSegmentStart, true);
  assert.equal(afterGap.windowAverageRate.status, 'insufficient');
  assert.equal(afterGap.currentRate.status, 'insufficient');
});

test('weight trend benchmark: backfills do not rewrite earlier forward states materially', () => {
  const complete = Array.from({ length: 50 }, (_unused, index) => ({
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * MS_PER_DAY),
    weight: 85 - 0.4 * index / 7 + (index % 3 === 0 ? 0.2 : -0.1)
  }));
  const missing = complete.filter((_point, index) => index !== 20);
  const beforeBackfill = computeTrend(missing);
  const afterBackfill = computeTrend(complete);
  const afterByDate = new Map(afterBackfill.points.map((point) => [point.date.getTime(), point]));
  const precedingChanges = beforeBackfill.points
    .filter((point) => point.date < complete[20].date)
    .map((point) => Math.abs(point.trendWeight - afterByDate.get(point.date.getTime()).trendWeight));

  assert.ok(Math.max(...precedingChanges) < 0.002);
  assert.ok(Math.abs(
    afterBackfill.windowAverageRate.estimateKgPerWeek - beforeBackfill.windowAverageRate.estimateKgPerWeek
  ) < 0.02);
});

test('weight trend benchmark: input order and kilogram boundary conversion are invariant', () => {
  const kilograms = buildScenario({ days: 45, weeklyRateKg: -0.35, noiseStdKg: 0.45, seed: 71 });
  const shuffled = kilograms.slice().sort((left, right) => (
    (left.date.getUTCDate() * 17) % 11 - (right.date.getUTCDate() * 17) % 11
  ));
  const pounds = kilograms.map((point) => ({ ...point, weight: point.weight * 2.2046226218487757 }));
  const chronologicalResult = computeTrend(kilograms);
  const shuffledResult = computeTrend(shuffled);
  const convertedResult = computeTrend(pounds.map((point) => ({
    ...point,
    weight: point.weight / 2.2046226218487757
  })));

  assert.deepEqual(
    shuffledResult.points.map((point) => [point.date.getTime(), point.trendWeight, point.trendRatePerDay]),
    chronologicalResult.points.map((point) => [point.date.getTime(), point.trendWeight, point.trendRatePerDay])
  );
  assert.deepEqual(
    convertedResult.points.map((point) => [point.trendWeight, point.lower95, point.upper95]),
    chronologicalResult.points.map((point) => [point.trendWeight, point.lower95, point.upper95])
  );
  assert.equal(
    convertedResult.windowAverageRate.estimateKgPerWeek,
    chronologicalResult.windowAverageRate.estimateKgPerWeek
  );
});

test('weight trend benchmark: appending one consistent observation keeps prior history stable', () => {
  const observations = Array.from({ length: 60 }, (_unused, index) => ({
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * MS_PER_DAY),
    weight: 85 - 0.35 * index / 7 + (index % 2 === 0 ? -0.2 : 0.25)
  }));
  const before = computeTrend(observations);
  const appendedObservation = {
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + 60 * MS_PER_DAY),
    weight: 85 - 0.35 * 60 / 7 - 0.2
  };
  const extendedObservations = [...observations, appendedObservation];
  const after = computeTrend(extendedObservations);
  const maximumHistoricalChange = Math.max(...before.points.map((point, index) => (
    Math.abs(point.trendWeight - after.points[index].trendWeight)
  )));

  assert.ok(maximumHistoricalChange < 1e-10, `maximum historical change was ${maximumHistoricalChange}`);
  assert.deepEqual(after.points.slice(0, before.points.length), before.points);
  assert.deepEqual(
    computeTrend(extendedObservations, { asOfDate: observations.at(-1).date }).points,
    before.points
  );
});

test('weight trend benchmark: bounded-window workloads remain inexpensive', () => {
  const observations = buildScenario({
    days: 150,
    weeklyRateKg: -0.4,
    noiseStdKg: 0.7,
    seed: 41,
    outlierEvery: 29
  });
  const startedAt = performance.now();
  for (let iteration = 0; iteration < 500; iteration += 1) {
    computeTrend(observations);
  }
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 5000, `500 bounded trend evaluations took ${elapsedMs.toFixed(1)} ms`);
});
