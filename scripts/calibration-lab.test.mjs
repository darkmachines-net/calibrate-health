/** @file Regression coverage for calibration lab: calibration lab accepts a complete editable history shape. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildCalibrationLabBundle, createCalibrationLabServer, parseCalibrationInput } from './calibration-lab.mjs';
import {
  applyPreviewRecommendation,
  buildPreviewStatus,
  cancelPreviewScheduledChange
} from '../tools/calibration-lab/status.mjs';

const validInput = {
  asOfDate: '2026-07-31',
  weightUnit: 'KG',
  ageYears: 38,
  bmrKcal: 1650,
  profileTdeeKcal: 2400,
  configuredDailyDeficitKcal: 500,
  currentTargetAdjustmentKcal: 0,
  foodDays: [{
    date: '2026-07-31',
    calories: 1900,
    entryCount: 3,
    mealPeriodCount: 3,
    isComplete: true
  }],
  weightPoints: [{
    date: '2026-07-31',
    weightKg: 90
  }]
};

const previewEvaluation = {
  asOfDate: '2026-07-31',
  recommendation: {
    currentTargetKcal: 1900,
    recommendedTargetKcal: 2050,
    adjustmentStepKcal: 150,
    currentTargetAdjustmentKcal: 0,
    recommendedTargetAdjustmentKcal: 150
  }
};

test('calibration lab accepts a complete editable history shape', () => {
  assert.equal(parseCalibrationInput(validInput), validInput);
});

test('calibration lab rejects malformed nested history before evaluation', () => {
  assert.throws(
    () => parseCalibrationInput({ ...validInput, foodDays: [{ ...validInput.foodDays[0], calories: '1900' }] }),
    /foodDays\[0\]\.calories must be a finite number/
  );
  assert.throws(
    () => parseCalibrationInput({ ...validInput, weightPoints: [{ ...validInput.weightPoints[0], weightKg: 0 }] }),
    /weightKg must be greater than zero/
  );
  assert.throws(
    () => parseCalibrationInput({ ...validInput, foodDays: [validInput.foodDays[0], validInput.foodDays[0]] }),
    /duplicates 2026-07-31/
  );
  assert.throws(
    () => parseCalibrationInput({ ...validInput, asOfDate: '2026-02-30' }),
    /valid YYYY-MM-DD date/
  );
  assert.throws(
    () => parseCalibrationInput({ ...validInput, weightUnit: 'STONE' }),
    /weightUnit must be KG or LB/
  );
});

test('calibration lab creates product-shaped recommendation metadata', () => {
  const status = buildPreviewStatus(previewEvaluation, 'lab-target-too-low', '2026-08-01T00:00:00.000Z');
  assert.equal(status.generatedAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(status.recommendation, {
    id: 1,
    status: 'pending',
    inputFingerprint: 'lab-target-too-low',
    effectiveLocalDate: '2026-08-01'
  });
  assert.equal(status.scheduledChange, null);
});

test('calibration lab leaves non-actionable evaluations without recommendation metadata', () => {
  const status = buildPreviewStatus({ ...previewEvaluation, recommendation: null }, 'lab-on-track');
  assert.equal(status.recommendation, null);
  assert.equal(status.scheduledChange, null);
});

test('calibration lab simulates the resulting scheduled budget after apply', () => {
  const status = buildPreviewStatus(previewEvaluation, 'lab-target-too-low');
  const scheduled = applyPreviewRecommendation(status, 1);
  assert.equal(scheduled.recommendation, null);
  assert.deepEqual(scheduled.scheduledChange, {
    recommendationId: 1,
    targetAdjustmentKcal: 150,
    dailyCalorieBudgetKcal: 2050,
    effectiveLocalDate: '2026-08-01'
  });
});

test('calibration lab simulates undo by restoring the pending recommendation', () => {
  const status = buildPreviewStatus(previewEvaluation, 'lab-target-too-low');
  const restored = cancelPreviewScheduledChange(applyPreviewRecommendation(status, 1), 1);
  assert.equal(restored.scheduledChange, null);
  assert.deepEqual(restored.recommendation, status.recommendation);
});

test('calibration lab ignores apply and undo actions for a different recommendation', () => {
  const status = buildPreviewStatus(previewEvaluation, 'lab-target-too-low');
  assert.equal(applyPreviewRecommendation(status, 99), status);
  const scheduled = applyPreviewRecommendation(status, 1);
  assert.equal(cancelPreviewScheduledChange(scheduled, 99), scheduled);
});

test('calibration lab uses the same React presentation as Progress', async () => {
  const labMain = await readFile(new URL('../tools/calibration-lab/main.tsx', import.meta.url), 'utf8');
  assert.match(labMain, /import \{ PlanCheckCardView \}/);
  assert.match(labMain, /<PlanCheckCardView/);
  assert.match(labMain, /onApplyRecommendation=\{applyRecommendation\}/);
  assert.match(labMain, /onCancelScheduledChange=\{cancelScheduledChange\}/);
  assert.doesNotMatch(labMain, /Estimated budget difference/);
});

test('calibration lab presets cover the new descriptive and scheduled product states', async () => {
  const scenarios = await readFile(
    new URL('../shared/calibrationScenarios.ts', import.meta.url),
    'utf8'
  );
  const labMain = await readFile(new URL('../tools/calibration-lab/main.tsx', import.meta.url), 'utf8');

  for (const id of ['not-ready', 'early-insight', 'on-track', 'wide-weight-uncertainty',
    'target-too-high', 'scheduled', 'after-pause', 'maintenance', 'gain']) {
    assert.match(scenarios, new RegExp("id: '" + id + "'"));
  }
  assert.match(scenarios, /previewState: 'scheduled'/);
  assert.match(labMain, /previewState === 'scheduled'/);
});

test('calibration lab builds and serves its shared React preview bundle', async (context) => {
  const browserBundle = await buildCalibrationLabBundle();
  assert.ok(browserBundle.byteLength > 100_000);
  const server = createCalibrationLabServer({ evaluateCalibration: () => ({}), scenarios: [], browserBundle });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/main.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(await response.text(), /Calibration history lab/);
});
