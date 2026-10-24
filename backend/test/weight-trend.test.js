/** @file Regression coverage for weight trend: computeWeightTrend: keeps a stable trend for mostly flat weight series. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WEIGHT_TREND_HUBER_K,
  WEIGHT_TREND_SEGMENT_RESET_DAYS,
  classifyWeightTrendEvidence,
  classifyWeightTrendRate,
  computeWeightTrend,
  hasSufficientWeightTrendEvidence
} = require('../../shared/weightTrend.ts');

const LB_TO_KG = 0.45359237;

function addDays(startDate, days) {
  const next = new Date(startDate);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function computeUnweightedSlopePerDay(observations) {
  if (observations.length < 2) return 0;

  const startMs = observations[0].date.getTime();
  const xValues = observations.map((observation) => (observation.date.getTime() - startMs) / (24 * 60 * 60 * 1000));
  const yValues = observations.map((observation) => observation.weight);

  const xMean = xValues.reduce((sum, value) => sum + value, 0) / xValues.length;
  const yMean = yValues.reduce((sum, value) => sum + value, 0) / yValues.length;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xValues.length; i += 1) {
    const xCentered = xValues[i] - xMean;
    numerator += xCentered * (yValues[i] - yMean);
    denominator += xCentered * xCentered;
  }

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

test('computeWeightTrend: keeps a stable trend for mostly flat weight series', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const observations = Array.from({ length: 10 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 + (index % 2 === 0 ? 0.2 : -0.2)
  }));

  const result = computeWeightTrend(observations);
  assert.equal(result.points.length, observations.length);
  assert.ok(result.points.every((point) => Number.isFinite(point.trendWeight)));
  assert.ok(result.points.every((point) => Number.isFinite(point.lower95)));
  assert.ok(result.points.every((point) => Number.isFinite(point.upper95)));

  const latestTrend = result.points[result.points.length - 1].trendWeight;
  assert.ok(Math.abs(latestTrend - 80) < 1.2);
});

test('computeWeightTrend: dampens a short-lived spike', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const base = [80, 79.8, 79.7, 79.6, 79.5, 81.5, 79.4, 79.3, 79.2];
  const observations = base.map((weight, index) => ({
    date: addDays(start, index),
    weight
  }));

  const result = computeWeightTrend(observations);
  const spikeIndex = 5;

  const rawJump = observations[spikeIndex].weight - observations[spikeIndex - 1].weight;
  const trendJump = result.points[spikeIndex].trendWeight - result.points[spikeIndex - 1].trendWeight;

  assert.ok(trendJump > 0, 'trend should react in the same direction');
  assert.ok(Math.abs(trendJump) < Math.abs(rawJump), 'trend should react less than raw measurement');
});

test('computeWeightTrend: widens uncertainty under high volatility', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const lowNoise = Array.from({ length: 20 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 - index * 0.08 + (index % 2 === 0 ? 0.15 : -0.1)
  }));
  const highNoise = Array.from({ length: 20 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 - index * 0.08 + (index % 2 === 0 ? 1.3 : -1.1)
  }));

  const lowResult = computeWeightTrend(lowNoise);
  const highResult = computeWeightTrend(highNoise);

  const lowStdMedian = median(lowResult.points.map((point) => point.trendStd));
  const highStdMedian = median(highResult.points.map((point) => point.trendStd));

  assert.ok(highStdMedian > lowStdMedian);
  assert.ok(['low', 'medium', 'high'].includes(lowResult.volatility));
  assert.ok(['low', 'medium', 'high'].includes(highResult.volatility));
});

test('computeWeightTrend: supports sparse histories with finite defaults', () => {
  const observations = [{ date: new Date('2025-01-01T00:00:00Z'), weight: 180 * LB_TO_KG }];

  const result = computeWeightTrend(observations);
  assert.equal(result.points.length, 1);
  assert.ok(Number.isFinite(result.points[0].trendWeight));
  assert.ok(Number.isFinite(result.points[0].trendStd));
  assert.ok(Number.isFinite(result.points[0].lower95));
  assert.ok(Number.isFinite(result.points[0].upper95));
  assert.equal(result.weeklyRate, 0);
});

test('computeWeightTrend: caps uncertainty growth across very large date gaps', () => {
  const observations = [
    { date: new Date('2012-01-01T00:00:00Z'), weight: 178 * LB_TO_KG },
    { date: new Date('2012-01-02T00:00:00Z'), weight: 177.5 * LB_TO_KG },
    { date: new Date('2026-01-01T00:00:00Z'), weight: 171.8 * LB_TO_KG },
  ];

  const result = computeWeightTrend(observations);
  assert.equal(result.points.length, 3);

  const firstPointAfterGap = result.points[2];
  const rangeWidth = firstPointAfterGap.upper95 - firstPointAfterGap.lower95;

  // We still allow wider intervals after sparse periods, but avoid exploding to implausible spans.
  assert.ok(rangeWidth < 8 * LB_TO_KG);
});

test('computeWeightTrend: reports a 95% confidence interval around the trend estimate', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const observations = Array.from({ length: 90 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: (180 - index * 0.06 + (index % 2 === 0 ? 1.1 : -0.95) + (index % 13 === 0 ? 1.6 : 0)) * LB_TO_KG,
  }));

  const result = computeWeightTrend(observations);
  for (const point of result.points) {
    const expectedLower = point.trendWeight - 1.96 * point.trendStd;
    const expectedUpper = point.trendWeight + 1.96 * point.trendStd;

    assert.ok(Math.abs(point.lower95 - expectedLower) < 1e-9);
    assert.ok(Math.abs(point.upper95 - expectedUpper) < 1e-9);
  }
});

test('computeWeightTrend: anchors the first trend point to the first observation', () => {
  const observations = [
    { date: new Date('2025-01-01T00:00:00Z'), weight: 80.5 },
    { date: new Date('2025-01-02T00:00:00Z'), weight: 80.3 },
    { date: new Date('2025-01-03T00:00:00Z'), weight: 80.1 }
  ];

  const result = computeWeightTrend(observations);
  assert.equal(result.points.length, observations.length);
  assert.equal(result.points[0].trendWeight, observations[0].weight);
  assert.ok(Number.isFinite(result.points[0].trendStd));
  assert.ok(result.points[0].lower95 <= result.points[0].trendWeight);
  assert.ok(result.points[0].upper95 >= result.points[0].trendWeight);
});

test('computeWeightTrend: recency-weighted drift adapts when recent direction differs from long-run history', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const observations = [];

  // Older period: gradual gain over ~5 months.
  for (let index = 0; index < 140; index += 1) {
    observations.push({
      date: addDays(start, index),
      weight: 75 + (6 / 139) * index + (index % 2 === 0 ? -0.15 : 0.15)
    });
  }

  // Recent period: sustained loss over ~6 weeks.
  for (let day = 0; day < 45; day += 1) {
    observations.push({
      date: addDays(start, 140 + day),
      weight: 81 - (4 / 44) * day + (day % 2 === 0 ? -0.2 : 0.2)
    });
  }

  const result = computeWeightTrend(observations);
  const unweightedSlope = computeUnweightedSlopePerDay(observations);

  assert.ok(unweightedSlope > 0, 'global unweighted slope should reflect the longer historical gain');
  assert.ok(result.params.driftPerDay < 0, 'recency-weighted drift should align with the recent loss period');
});

test('computeWeightTrend: does not assimilate a segment-start observation twice', () => {
  const result = computeWeightTrend([
    { date: new Date('2026-01-01T00:00:00Z'), weight: 80 }
  ]);

  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].trendWeight, 80);
  assert.equal(result.points[0].trendStd, result.measurementVariabilityKg);
  assert.equal(result.points[0].trendRatePerDay, 0);
  assert.equal(result.points[0].trendRateStdPerDay, 0.15);
  assert.equal(result.points[0].huberWeight, 1);
  assert.equal(result.points[0].isSegmentStart, true);
});

test('computeWeightTrend: uses actual elapsed time and resets only after gaps greater than 14 days', () => {
  const observations = [
    { date: new Date('2026-01-01T00:00:00Z'), weight: 80 },
    { date: new Date('2026-01-15T00:00:00Z'), weight: 79 },
    { date: new Date('2026-01-30T00:00:00Z'), weight: 75 }
  ];

  const result = computeWeightTrend(observations);
  assert.equal(WEIGHT_TREND_SEGMENT_RESET_DAYS, 14);
  assert.deepEqual(result.points.map((point) => point.gapDays), [0, 14, 15]);
  assert.deepEqual(result.points.map((point) => point.segmentId), [1, 1, 2]);
  assert.equal(result.points[1].isSegmentStart, false);
  assert.equal(result.points[2].isSegmentStart, true);
  assert.equal(result.points[2].trendWeight, observations[2].weight);
  assert.equal(result.points[2].trendRatePerDay, 0);
  assert.equal(result.segments[1].resetGapDays, 15);
  assert.equal(result.evidence.latestSegmentPointCount, 1);
  assert.equal(result.evidence.status, 'insufficient');
});

test('computeWeightTrend: exposes coherent level and rate uncertainty bounds', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const observations = Array.from({ length: 30 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 85 - index * 0.06 + (index % 2 === 0 ? 0.15 : -0.15)
  }));
  const result = computeWeightTrend(observations, {
    calibrationWindow: { startDate: addDays(start, 1), endDate: addDays(start, 29) }
  });
  const latest = result.points[result.points.length - 1];

  assert.ok(Math.abs(latest.lower95 - (latest.trendWeight - 1.96 * latest.trendStd)) < 1e-12);
  assert.ok(Math.abs(latest.upper95 - (latest.trendWeight + 1.96 * latest.trendStd)) < 1e-12);
  assert.ok(Math.abs(latest.trendRateLower95PerDay - (latest.trendRatePerDay - 1.96 * latest.trendRateStdPerDay)) < 1e-12);
  assert.ok(Math.abs(latest.trendRateUpper95PerDay - (latest.trendRatePerDay + 1.96 * latest.trendRateStdPerDay)) < 1e-12);
  assert.equal(result.currentRate.estimateKgPerWeek, latest.trendRatePerDay * 7);
  assert.equal(result.currentRate.stdKgPerWeek, latest.trendRateStdPerDay * 7);
  assert.equal(result.currentRate.lower95KgPerWeek, latest.trendRateLower95PerDay * 7);
  assert.equal(result.currentRate.upper95KgPerWeek, latest.trendRateUpper95PerDay * 7);
  assert.ok(Math.abs(result.windowAverageRate.lower95KgPerWeek - (
    result.windowAverageRate.estimateKgPerWeek - 1.96 * result.windowAverageRate.stdKgPerWeek
  )) < 1e-12);
  assert.ok(Math.abs(result.windowAverageRate.upper95KgPerWeek - (
    result.windowAverageRate.estimateKgPerWeek + 1.96 * result.windowAverageRate.stdKgPerWeek
  )) < 1e-12);
  assert.equal(result.currentRate.pointCount, 30);
  assert.equal(result.currentRate.spanDays, 29);
  assert.equal(result.windowAverageRate.pointCount, 29);
  assert.equal(result.windowAverageRate.spanDays, 28);
});

test('computeWeightTrend: requires explicit 7-42 day calibration-window bounds', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const observations = Array.from({ length: 60 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 85 - index * 0.05
  }));

  const omitted = computeWeightTrend(observations);
  const tooShort = computeWeightTrend(observations, {
    calibrationWindow: { startDate: addDays(start, 53), endDate: addDays(start, 59) }
  });
  const selected = computeWeightTrend(observations, {
    calibrationWindow: { startDate: addDays(start, 24), endDate: addDays(start, 59) }
  });
  const tooLong = computeWeightTrend(observations, {
    calibrationWindow: { startDate: start, endDate: addDays(start, 59) }
  });

  assert.equal(omitted.windowAverageRate.status, 'insufficient');
  assert.equal(Number.isFinite(omitted.windowAverageRate.estimateKgPerWeek), false);
  assert.equal(tooShort.windowAverageRate.status, 'insufficient');
  assert.equal(Number.isFinite(tooShort.windowAverageRate.estimateKgPerWeek), false);
  assert.equal(selected.windowAverageRate.spanDays, 35);
  assert.equal(tooLong.windowAverageRate.status, 'insufficient');
  assert.equal(Number.isFinite(tooLong.windowAverageRate.estimateKgPerWeek), false);
  assert.equal(selected.currentRate.spanDays, 59, 'current velocity evidence is not truncated to the regression window');
});

test('computeWeightTrend: Huber weighting limits an isolated extreme observation', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const baseline = Array.from({ length: 30 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 - index * 0.05 + (index % 2 === 0 ? -0.1 : 0.1)
  }));
  const withOutlier = baseline.map((point, index) => ({
    ...point,
    weight: point.weight + (index === 15 ? 10 : 0)
  }));

  const baselineResult = computeWeightTrend(baseline);
  const outlierResult = computeWeightTrend(withOutlier);
  assert.equal(WEIGHT_TREND_HUBER_K, 2.5);
  assert.ok(outlierResult.points[15].huberWeight < 0.2);
  assert.ok(Math.abs(outlierResult.points[15].trendWeight - baselineResult.points[15].trendWeight) < 0.5);
  assert.ok(Math.abs(outlierResult.points[29].trendWeight - baselineResult.points[29].trendWeight) < 0.05);
});

test('computeWeightTrend: estimates bounded two-pass measurement variability with sparse-data shrinkage', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const quiet = Array.from({ length: 60 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 - index * 0.02 + (index % 2 === 0 ? -0.05 : 0.05)
  }));
  const noisy = quiet.map((point, index) => ({
    ...point,
    weight: point.weight + (index % 2 === 0 ? -2 : 2)
  }));

  const sparse = computeWeightTrend(quiet.slice(0, 2));
  const quietResult = computeWeightTrend(quiet);
  const noisyResult = computeWeightTrend(noisy);
  assert.equal(sparse.measurementVariabilityKg, 0.9);
  assert.ok(quietResult.measurementVariabilityKg >= 0.25);
  assert.ok(quietResult.measurementVariabilityKg < 0.9);
  assert.ok(noisyResult.measurementVariabilityKg > quietResult.measurementVariabilityKg);
  assert.ok(noisyResult.measurementVariabilityKg <= 3.5);
});

test('computeWeightTrend: resets measurement variability at a new segment', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const noisyHistory = Array.from({ length: 30 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 - index * 0.02 + (index % 2 === 0 ? -2 : 2)
  }));
  const afterGap = [
    ...noisyHistory,
    { date: addDays(start, 45), weight: 79 }
  ];

  const result = computeWeightTrend(afterGap);

  assert.equal(result.points[result.points.length - 1].isSegmentStart, true);
  assert.equal(result.measurementVariabilityKg, 0.9);
});

test('computeWeightTrend: limits as-of results and derives evidence from the latest segment', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const observations = Array.from({ length: 20 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 - index * 0.05
  }));
  const asOfDate = addDays(start, 9);
  const result = computeWeightTrend(observations, { asOfDate });

  assert.equal(result.points.length, 10);
  assert.equal(result.asOfDate.getTime(), asOfDate.getTime());
  assert.equal(result.evidence.latestSegmentPointCount, 10);
  assert.equal(result.evidence.latestSegmentSpanDays, 9);
  assert.equal(result.evidence.status, 'sufficient');
  assert.equal(hasSufficientWeightTrendEvidence(result.evidence), true);
});

test('classifyWeightTrendEvidence: uses raw point count and elapsed span boundaries', () => {
  assert.equal(classifyWeightTrendEvidence(1, 30, 1), 'insufficient');
  assert.equal(classifyWeightTrendEvidence(2, 0, 0), 'limited');
  assert.equal(classifyWeightTrendEvidence(2, 7, 0), 'limited');
  assert.equal(classifyWeightTrendEvidence(3, 6, 0), 'limited');
  assert.equal(classifyWeightTrendEvidence(3, 7, 0), 'sufficient');
});

test('computeWeightTrend: withholds pace until the latest segment spans seven elapsed days', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const spanSix = computeWeightTrend([
    { date: start, weight: 80 },
    { date: addDays(start, 6), weight: 79.7 }
  ], {
    calibrationWindow: { startDate: start, endDate: addDays(start, 6) }
  });
  const spanSeven = computeWeightTrend([
    { date: start, weight: 80 },
    { date: addDays(start, 7), weight: 79.65 }
  ], {
    calibrationWindow: { startDate: start, endDate: addDays(start, 7) }
  });

  assert.equal(spanSix.evidence.status, 'limited');
  assert.equal(spanSix.currentRate.status, 'insufficient');
  assert.equal(spanSix.windowAverageRate.status, 'insufficient');
  assert.equal(spanSeven.evidence.status, 'limited');
  assert.equal(spanSeven.currentRate.status, 'limited');
  assert.equal(spanSeven.windowAverageRate.status, 'limited');
});

test('computeWeightTrend: deprecated weekly rate uses only the latest uninterrupted segment', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const beforeGap = Array.from({ length: 14 }, (_unused, index) => ({
    date: addDays(start, index),
    weight: 80 + index * 0.2
  }));
  const afterGapStart = addDays(start, 29);
  const afterGap = Array.from({ length: 8 }, (_unused, index) => ({
    date: addDays(afterGapStart, index),
    weight: 83 - index * 0.2
  }));

  const result = computeWeightTrend([...beforeGap, ...afterGap]);
  const latestSegment = result.points.filter((point) => point.segmentId === 2);
  const expected = (
    (latestSegment.at(-1).trendWeight - latestSegment[0].trendWeight) /
    7
  ) * 7;

  assert.equal(result.segments.length, 2);
  assert.equal(result.weeklyRate, expected);
  assert.ok(result.weeklyRate < 0, 'pre-gap gain must not invert the post-gap loss rate');
});

test('computeWeightTrend: exact calibration window never falls back across a reset gap', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const observations = [
    { date: start, weight: 80 },
    { date: addDays(start, 1), weight: 80.2 },
    { date: addDays(start, 17), weight: 79.8 },
    { date: addDays(start, 24), weight: 79.2 },
    { date: addDays(start, 28), weight: 78.8 }
  ];

  const result = computeWeightTrend(observations, {
    calibrationWindow: { startDate: start, endDate: addDays(start, 28) }
  });

  assert.equal(result.segments.length, 2);
  assert.equal(result.currentRate.estimateKgPerWeek, result.points.at(-1).trendRatePerDay * 7);
  assert.equal(result.windowAverageRate.status, 'insufficient');
  assert.equal(result.windowAverageRate.pointCount, observations.length);
  assert.equal(Number.isFinite(result.windowAverageRate.estimateKgPerWeek), false);
});
test('classifyWeightTrendRate: requires sufficient evidence before assigning a confident direction', () => {
  assert.deepEqual(classifyWeightTrendRate(-0.8, -0.1, 'sufficient'), {
    direction: 'down',
    status: 'confident'
  });
  assert.deepEqual(classifyWeightTrendRate(0.1, 0.8, 'sufficient'), {
    direction: 'up',
    status: 'confident'
  });
  assert.deepEqual(classifyWeightTrendRate(-0.2, 0.2, 'sufficient'), {
    direction: 'uncertain',
    status: 'uncertain'
  });
  assert.deepEqual(classifyWeightTrendRate(-0.8, -0.1, 'limited'), {
    direction: 'uncertain',
    status: 'limited'
  });
});
