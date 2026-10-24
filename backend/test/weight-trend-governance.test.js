/** @file Regression coverage for weight trend governance: weight trend governance: model constants come from the versioned parameter manifest. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { WEIGHT_TREND_MODEL_VERSION } = require('../../shared/weightTrend.ts');
const {
  WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE,
  WEIGHT_TREND_PARAMETER_MANIFEST
} = require('../../shared/weightTrendParameters.ts');
const {
  assessParameterGovernance,
  buildTuningReport,
  fingerprintNumericParameters,
  REPORT_PATH
} = require('../scripts/weight-trend-tuning-report');

test('weight trend governance: model constants come from the versioned parameter manifest', () => {
  assert.equal(WEIGHT_TREND_PARAMETER_MANIFEST.manifestVersion, 1);
  assert.equal(WEIGHT_TREND_PARAMETER_MANIFEST.modelVersion, WEIGHT_TREND_MODEL_VERSION);
  assert.equal(WEIGHT_TREND_PARAMETER_MANIFEST.filter.huberK, 2.5);
  assert.equal(WEIGHT_TREND_PARAMETER_MANIFEST.filter.segmentResetDays, 14);
  assert.equal(WEIGHT_TREND_PARAMETER_MANIFEST.filter.rateProcessStdKgPerDaySqrtDay, 0.007);
  assert.equal(WEIGHT_TREND_PARAMETER_MANIFEST.measurement.defaultStdKg, 0.9);
  assert.equal(
    fingerprintNumericParameters(WEIGHT_TREND_PARAMETER_MANIFEST),
    WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.sha256
  );
  assert.equal(
    WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.modelVersion,
    WEIGHT_TREND_MODEL_VERSION
  );
});

test('weight trend governance: regenerated report rejects numeric changes without a model-version bump', () => {
  const candidate = JSON.parse(JSON.stringify(WEIGHT_TREND_PARAMETER_MANIFEST));
  candidate.filter.huberK += 0.1;

  const report = buildTuningReport(candidate);

  assert.equal(report.parameterGovernance.constantsChanged, true);
  assert.equal(report.parameterGovernance.modelVersionBumped, false);
  assert.equal(report.parameterGovernance.numericParameterChangeHasModelVersionBump, false);
  assert.equal(report.results.gateResults.numericParameterChangeHasModelVersionBump, false);
  assert.equal(report.decision.constantsChanged, true);
  assert.equal(report.decision.gatesPassed, false);
  assert.match(report.decision.rationale, /without a model-version bump/);

  candidate.modelVersion = WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE.modelVersion + 1;
  const bumped = assessParameterGovernance(candidate);
  assert.equal(bumped.constantsChanged, true);
  assert.equal(bumped.modelVersionBumped, true);
  assert.equal(bumped.numericParameterChangeHasModelVersionBump, true);
});

test('weight trend governance: checked-in tuning report is reproducible and passes every gate', () => {
  const checkedIn = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  const reproduced = buildTuningReport();

  assert.deepEqual(checkedIn, reproduced);
  assert.equal(reproduced.decision.gatesPassed, true);
  assert.equal(reproduced.decision.constantsChanged, false);
  assert.ok(Object.values(reproduced.results.gateResults).every(Boolean));
});
