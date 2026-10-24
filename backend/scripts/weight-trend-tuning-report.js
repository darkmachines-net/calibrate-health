/** @file Deterministic weight-trend tuning fixture generation and verification from versioned model inputs. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { computeWeightTrend } = require('../../shared/weightTrend.ts');
const {
  WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE,
  WEIGHT_TREND_PARAMETER_MANIFEST
} = require('../../shared/weightTrendParameters.ts');
const { computeWeightTrendV1 } = require('../src/services/weightTrendV1');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REPORT_PATH = path.resolve(__dirname, '../../backend/test/fixtures/weight-trend-v2-tuning-report.json');

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function gaussian(random) {
  const first = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
}

function buildLinearScenario({ days, weeklyRateKg, noiseStdKg, seed }) {
  const random = seededRandom(seed);
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: days }, (_unused, day) => ({
    date: new Date(startMs + day * MS_PER_DAY),
    weight: 85 + weeklyRateKg * day / 7 + gaussian(random) * noiseStdKg
  }));
}

function computeCalibrationTrend(observations, windowDays = 28) {
  const latestDate = observations.at(-1)?.date;
  const calibrationWindow = latestDate
    ? {
        startDate: new Date(latestDate.getTime() - windowDays * MS_PER_DAY),
        endDate: new Date(latestDate.getTime())
      }
    : undefined;
  return computeWeightTrend(observations, { calibrationWindow });
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function collectNumericParameterEntries(value, pathPrefix = '', entries = []) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite numeric model parameter at ${pathPrefix}.`);
    if (pathPrefix !== 'manifestVersion' && pathPrefix !== 'modelVersion') {
      entries.push([pathPrefix, value]);
    }
    return entries;
  }
  if (!value || typeof value !== 'object') return entries;

  for (const key of Object.keys(value)) {
    const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    collectNumericParameterEntries(value[key], childPath, entries);
  }
  return entries;
}

/** Hash sorted numeric model inputs, excluding manifest/model version labels, for tuning governance. */
function fingerprintNumericParameters(parameterManifest) {
  const entries = collectNumericParameterEntries(parameterManifest)
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Compare numeric inputs with the approved fingerprint and require a model-version increase for changes. */
function assessParameterGovernance(parameterManifest) {
  const currentFingerprint = fingerprintNumericParameters(parameterManifest);
  const constantsChanged = currentFingerprint !== WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.sha256;
  const modelVersionBumped = parameterManifest.modelVersion >
    WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.modelVersion;
  return {
    approvedModelVersion: WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.modelVersion,
    approvedNumericParameterFingerprintSha256: WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.sha256,
    currentNumericParameterFingerprintSha256: currentFingerprint,
    constantsChanged,
    modelVersionBumped,
    modelVersionNotRegressed: parameterManifest.modelVersion >=
      WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.modelVersion,
    numericParameterChangeHasModelVersionBump: !constantsChanged || modelVersionBumped
  };
}

function buildCoverageResults() {
  let levelCovered = 0;
  let levelEvaluated = 0;
  let windowRateCovered = 0;
  let velocityRateCovered = 0;
  const scenarioCount = 120;
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');

  for (let seed = 1; seed <= scenarioCount; seed += 1) {
    const observations = buildLinearScenario({
      days: 60,
      weeklyRateKg: -0.35,
      noiseStdKg: 0.9,
      seed
    });
    const linear = computeCalibrationTrend(observations);
    for (let day = 14; day < linear.points.length; day += 1) {
      const latent = 85 - 0.35 * day / 7;
      const point = linear.points[day];
      levelCovered += point.lower95 <= latent && latent <= point.upper95 ? 1 : 0;
      levelEvaluated += 1;
    }
    windowRateCovered += linear.windowAverageRate.lower95KgPerWeek <= -0.35 &&
      -0.35 <= linear.windowAverageRate.upper95KgPerWeek ? 1 : 0;

    const random = seededRandom(seed);
    let latentLevelKg = 85;
    let latentRateKgPerDay = -0.35 / 7;
    const changingRate = [];
    for (let day = 0; day < 60; day += 1) {
      if (day > 0) {
        latentRateKgPerDay += gaussian(random) * 0.007;
        latentLevelKg += latentRateKgPerDay;
      }
      changingRate.push({
        date: new Date(startMs + day * MS_PER_DAY),
        weight: latentLevelKg + gaussian(random) * 0.9
      });
    }
    const velocity = computeWeightTrend(changingRate);
    const currentRateKgPerWeek = latentRateKgPerDay * 7;
    velocityRateCovered += velocity.currentRate.lower95KgPerWeek <= currentRateKgPerWeek &&
      currentRateKgPerWeek <= velocity.currentRate.upper95KgPerWeek ? 1 : 0;
  }

  return {
    scenarioCount,
    levelCoverage: round(levelCovered / levelEvaluated),
    windowAverageRateCoverage: round(windowRateCovered / scenarioCount),
    currentVelocityRateCoverage: round(velocityRateCovered / scenarioCount)
  };
}

function buildRmseResults() {
  return [0, -0.5].map((weeklyRateKg) => {
    let v2SquaredError = 0;
    let v1SquaredError = 0;
    let levelCount = 0;
    let rateSquaredError = 0;
    const scenarioCount = 120;
    for (let seed = 1; seed <= scenarioCount; seed += 1) {
      const observations = buildLinearScenario({ days: 60, weeklyRateKg, noiseStdKg: 0.6, seed });
      const v2 = computeCalibrationTrend(observations);
      for (let day = 14; day < v2.points.length; day += 1) {
        const latent = 85 + weeklyRateKg * day / 7;
        v2SquaredError += (v2.points[day].trendWeight - latent) ** 2;
        const v1Point = computeWeightTrendV1(observations.slice(0, day + 1)).points.at(-1);
        v1SquaredError += (v1Point.trendWeight - latent) ** 2;
        levelCount += 1;
      }
      rateSquaredError += (v2.windowAverageRate.estimateKgPerWeek - weeklyRateKg) ** 2;
    }
    const v2LevelRmse = Math.sqrt(v2SquaredError / levelCount);
    const v1LevelRmse = Math.sqrt(v1SquaredError / levelCount);
    return {
      weeklyRateKg,
      v2LevelRmseKg: round(v2LevelRmse),
      v1LevelRmseKg: round(v1LevelRmse),
      v2ToV1LevelRmseRatio: round(v2LevelRmse / v1LevelRmse),
      windowAverageRateRmseKgPerWeek: round(Math.sqrt(rateSquaredError / scenarioCount))
    };
  });
}

function buildReversalResults() {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const observations = Array.from({ length: 60 }, (_unused, day) => ({
    date: new Date(startMs + day * MS_PER_DAY),
    weight: 80 + 0.35 * day / 7 + (day % 2 === 0 ? -0.15 : 0.15)
  }));
  const reversalWeight = 80 + 0.35 * 59 / 7;
  let v2DirectionLagDays = null;
  let v2ConfidenceLagDays = null;
  let v1DirectionLagDays = null;
  for (let day = 1; day <= 14; day += 1) {
    observations.push({
      date: new Date(startMs + (59 + day) * MS_PER_DAY),
      weight: reversalWeight - 0.7 * day / 7 + (day % 2 === 0 ? -0.15 : 0.15)
    });
    const v2 = computeWeightTrend(observations);
    const v1 = computeWeightTrendV1(observations);
    if (v2DirectionLagDays === null && v2.currentRate.estimateKgPerWeek < 0) v2DirectionLagDays = day;
    if (v2ConfidenceLagDays === null && v2.currentRate.direction === 'down' && v2.currentRate.status === 'confident') {
      v2ConfidenceLagDays = day;
    }
    if (v1DirectionLagDays === null && v1.weeklyRate < 0) v1DirectionLagDays = day;
  }
  return { v2DirectionLagDays, v2ConfidenceLagDays, v1DirectionLagDays };
}

function buildStabilityResults() {
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const baseline = Array.from({ length: 70 }, (_unused, day) => ({
    date: new Date(startMs + day * MS_PER_DAY),
    weight: 85 - 0.4 * day / 7 + (day % 2 === 0 ? -0.2 : 0.2)
  }));
  const baselineResult = computeCalibrationTrend(baseline);
  let maximumSpikeRecoveryErrorKg = 0;
  for (const spikeKg of [3, -3]) {
    const spiked = baseline.map((point, day) => ({
      ...point,
      weight: point.weight + (day === 30 ? spikeKg : 0)
    }));
    const result = computeCalibrationTrend(spiked);
    maximumSpikeRecoveryErrorKg = Math.max(
      maximumSpikeRecoveryErrorKg,
      Math.abs(result.points[44].trendWeight - baselineResult.points[44].trendWeight)
    );
  }

  const converted = computeCalibrationTrend(baseline.map((point) => ({
    ...point,
    weight: point.weight * 2.2046226218487757 / 2.2046226218487757
  })));
  const reversed = computeCalibrationTrend(baseline.slice().reverse());
  const appended = [...baseline, {
    date: new Date(startMs + 70 * MS_PER_DAY),
    weight: 85 - 0.4 * 70 / 7 - 0.2
  }];
  const appendedResult = computeCalibrationTrend(appended);

  return {
    maximumSpikeRecoveryErrorKgAt14Days: round(maximumSpikeRecoveryErrorKg, 9),
    kilogramBoundaryMaximumErrorKg: round(Math.max(...baselineResult.points.map((point, index) => (
      Math.abs(point.trendWeight - converted.points[index].trendWeight)
    ))), 12),
    inputOrderMaximumErrorKg: round(Math.max(...baselineResult.points.map((point, index) => (
      Math.abs(point.trendWeight - reversed.points[index].trendWeight)
    ))), 12),
    appendOneHistoricalMaximumErrorKg: round(Math.max(...baselineResult.points.map((point, index) => (
      Math.abs(point.trendWeight - appendedResult.points[index].trendWeight)
    ))), 12)
  };
}

/** Run deterministic coverage, accuracy and stability scenarios and return their reproducible governance report. */
function buildTuningReport(parameterManifest = WEIGHT_TREND_PARAMETER_MANIFEST) {
  const coverage = buildCoverageResults();
  const rmse = buildRmseResults();
  const reversal = buildReversalResults();
  const stability = buildStabilityResults();
  const parameterGovernance = assessParameterGovernance(parameterManifest);
  const gateResults = {
    levelCoverage: coverage.levelCoverage >= 0.9 && coverage.levelCoverage <= 0.98,
    windowAverageRateCoverage: coverage.windowAverageRateCoverage >= 0.9 && coverage.windowAverageRateCoverage <= 0.98,
    currentVelocityRateCoverage: coverage.currentVelocityRateCoverage >= 0.9 && coverage.currentVelocityRateCoverage <= 0.98,
    v2LevelRmseWithinFivePercentOfV1: rmse.every((result) => result.v2ToV1LevelRmseRatio <= 1.05),
    windowAverageRateRmse: rmse.every((result) => result.windowAverageRateRmseKgPerWeek <= 0.12),
    reversalConfidenceWithinFourteenDays: reversal.v2ConfidenceLagDays !== null && reversal.v2ConfidenceLagDays <= 14,
    reversalDirectionFasterThanV1: reversal.v2DirectionLagDays !== null && reversal.v1DirectionLagDays !== null &&
      reversal.v2DirectionLagDays < reversal.v1DirectionLagDays,
    spikeRecoveryWithinTwoWeeks: stability.maximumSpikeRecoveryErrorKgAt14Days < 0.06,
    inputOrderAndUnitInvariant: stability.kilogramBoundaryMaximumErrorKg < 1e-10 &&
      stability.inputOrderMaximumErrorKg < 1e-10,
    appendOneHistoryStable: stability.appendOneHistoricalMaximumErrorKg < 1e-10,
    modelVersionNotRegressed: parameterGovernance.modelVersionNotRegressed,
    numericParameterChangeHasModelVersionBump:
      parameterGovernance.numericParameterChangeHasModelVersionBump
  };

  return {
    schemaVersion: 1,
    reportVersion: 1,
    modelVersion: parameterManifest.modelVersion,
    generator: 'npm run weight-trend:tuning-report',
    parameterManifest,
    parameterGovernance,
    fixtures: {
      seedRange: [1, 120],
      simulatedDays: 60,
      linearWeeklyRatesKg: [0, -0.5],
      measurementNoiseStdKg: [0.6, 0.9],
      calibrationWindowDays: 28
    },
    gates: {
      intervalCoverage: { minimum: 0.9, maximum: 0.98 },
      maximumV2ToV1LevelRmseRatio: 1.05,
      maximumWindowRateRmseKgPerWeek: 0.12,
      maximumConfidentReversalLagDays: 14,
      maximumSpikeRecoveryErrorKgAt14Days: 0.06,
      invarianceToleranceKg: 1e-10,
      appendStabilityToleranceKg: 1e-10
    },
    results: { coverage, rmse, reversal, stability, gateResults },
    decision: {
      gatesPassed: Object.values(gateResults).every(Boolean),
      constantsChanged: parameterGovernance.constantsChanged,
      rationale: parameterGovernance.constantsChanged
        ? parameterGovernance.modelVersionBumped
          ? 'Numeric parameters differ from the approved baseline and include a model-version bump; every release gate must still pass.'
          : `Numeric parameters differ from the approved baseline without a model-version bump above ${parameterGovernance.approvedModelVersion}; the report is rejected.`
        : 'Existing Weight Trend v2 parameters match the approved fingerprint and pass every deterministic gate; no numeric change is justified.'
    }
  };
}

if (require.main === module) {
  const report = buildTuningReport();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv.includes('--write')) {
    fs.writeFileSync(REPORT_PATH, serialized, 'utf8');
  } else if (process.argv.includes('--check')) {
    assert.equal(fs.readFileSync(REPORT_PATH, 'utf8'), serialized, 'Checked-in tuning report is stale. Run the write command.');
  } else {
    process.stdout.write(serialized);
  }
}

module.exports = {
  assessParameterGovernance,
  buildTuningReport,
  fingerprintNumericParameters,
  REPORT_PATH
};
