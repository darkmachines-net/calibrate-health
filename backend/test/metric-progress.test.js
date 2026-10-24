/** @file Regression coverage for metric progress: canonical goal progress mirrors loss and gain and bounds overshoot. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCanonicalGoalProgress
} = require('../../shared/goalProgress');
const {
  evaluateMetricProgressUpdate
} = require('../src/services/metricProgress');

const CURRENT_DATE = '2026-08-03';

function goal(overrides = {}) {
  return {
    id: 11,
    startWeightGrams: 100000,
    targetWeightGrams: 80000,
    dailyDeficit: 500,
    createdLocalDate: '2026-01-01',
    ...overrides
  };
}

function evaluate(overrides = {}) {
  return evaluateMetricProgressUpdate({
    saveKind: 'created',
    savedLocalDate: CURRENT_DATE,
    currentLocalDate: CURRENT_DATE,
    currentWeightGrams: 99000,
    weightUnit: 'KG',
    goal: null,
    previousMetrics: [],
    hadAnyMetricBeforeSave: false,
    ...overrides
  });
}

test('canonical goal progress mirrors loss and gain and bounds overshoot', () => {
  assert.deepEqual(
    calculateCanonicalGoalProgress(
      { startWeightGrams: 100000, targetWeightGrams: 80000, dailyDeficit: 500 },
      90000
    ),
    {
      mode: 'lose', progressPercent: 50, progressWeightGrams: 10000,
      remainingWeightGrams: 10000, isComplete: false
    }
  );
  assert.deepEqual(
    calculateCanonicalGoalProgress(
      { startWeightGrams: 80000, targetWeightGrams: 100000, dailyDeficit: -500 },
      101000
    ),
    {
      mode: 'gain', progressPercent: 100, progressWeightGrams: 21000,
      remainingWeightGrams: 0, isComplete: true
    }
  );
});

test('canonical maintenance progress remains ongoing and neutral', () => {
  assert.deepEqual(
    calculateCanonicalGoalProgress(
      { startWeightGrams: 80000, targetWeightGrams: 80000, dailyDeficit: 0 },
      80050
    ),
    {
      mode: 'maintain', progressPercent: null, progressWeightGrams: null,
      remainingWeightGrams: 50, isComplete: false
    }
  );
});

test('metric progress recognizes a first current-day measurement but not backfills or unchanged saves', () => {
  assert.deepEqual(evaluate().recognitions, [{ type: 'baseline_recorded' }]);
  assert.deepEqual(evaluate({ savedLocalDate: '2026-08-02' }).recognitions, []);
  assert.deepEqual(evaluate({ saveKind: 'unchanged' }).recognitions, []);
});

test('metric progress reports a historical save against the latest retained weigh-in', () => {
  const update = evaluate({
    savedLocalDate: '2026-08-01',
    goal: goal(),
    currentWeightGrams: 90000,
    previousMetrics: [
      { localDate: '2026-08-03', weightGrams: 87000 },
      { localDate: '2026-08-01', weightGrams: 95000 },
      { localDate: '2026-08-02', weightGrams: 88000 }
    ],
    hadAnyMetricBeforeSave: true
  });

  assert.equal(update.current_weight_grams, 90000);
  assert.deepEqual(update.recognitions, []);
  assert.equal(update.goal.current_progress_percent, 65);
  assert.equal(update.goal.remaining_weight_grams, 7000);
});

test('metric progress reports only the highest newly crossed percentage milestone', () => {
  const update = evaluate({
    goal: goal(),
    currentWeightGrams: 84000,
    previousMetrics: [{ localDate: '2026-08-02', weightGrams: 98000 }],
    hadAnyMetricBeforeSave: true
  });

  assert.deepEqual(update.recognitions, [{ type: 'goal_percent', threshold_percent: 75 }]);
  assert.equal(update.goal.previous_progress_percent, 10);
  assert.equal(update.goal.current_progress_percent, 80);
});

test('metric progress recognizes each percentage threshold inclusively and only once', () => {
  for (const threshold of [25, 50, 75]) {
    const currentWeightGrams = 120000 - (threshold * 1000);
    const update = evaluate({
      goal: goal({ startWeightGrams: 120000, targetWeightGrams: 20000 }),
      currentWeightGrams,
      previousMetrics: [{ localDate: '2026-08-02', weightGrams: currentWeightGrams + 1000 }],
      hadAnyMetricBeforeSave: true
    });
    assert.deepEqual(update.recognitions, [{ type: 'goal_percent', threshold_percent: threshold }]);

    const repeated = evaluate({
      goal: goal({ startWeightGrams: 120000, targetWeightGrams: 20000 }),
      currentWeightGrams: currentWeightGrams - 100,
      previousMetrics: [{ localDate: '2026-08-02', weightGrams: currentWeightGrams }],
      hadAnyMetricBeforeSave: true
    });
    assert.notDeepEqual(repeated.recognitions, [{ type: 'goal_percent', threshold_percent: threshold }]);
  }
});

test('metric progress prioritizes exact or overshot goal completion and records the reached date', () => {
  for (const currentWeightGrams of [80000, 79000]) {
    const update = evaluate({
      goal: goal(),
      currentWeightGrams,
      previousMetrics: [{ localDate: '2026-08-02', weightGrams: 85000 }],
      hadAnyMetricBeforeSave: true
    });

    assert.deepEqual(update.recognitions, [{ type: 'goal_reached' }]);
    assert.equal(update.goal.is_complete, true);
    assert.equal(update.goal.current_progress_percent, 100);
    assert.equal(update.goal.remaining_weight_grams, 0);
    assert.equal(update.goal.reached_local_date, CURRENT_DATE);
  }
});

test('metric progress preserves an earlier reached date after later fluctuation', () => {
  const update = evaluate({
    goal: goal(),
    currentWeightGrams: 85000,
    previousMetrics: [{ localDate: '2026-08-01', weightGrams: 79000 }],
    hadAnyMetricBeforeSave: true
  });

  assert.deepEqual(update.recognitions, []);
  assert.equal(update.goal.is_complete, true);
  assert.equal(update.goal.reached_local_date, '2026-08-01');
  assert.equal(update.goal.current_progress_percent, 100);
});

test('metric progress removes completion when the only reached value is edited away', () => {
  const update = evaluate({
    saveKind: 'updated',
    goal: goal(),
    currentWeightGrams: 85000,
    previousMetrics: [{ localDate: CURRENT_DATE, weightGrams: 79000 }],
    hadAnyMetricBeforeSave: true
  });

  assert.equal(update.goal.previous_progress_percent, 100);
  assert.equal(update.goal.is_complete, false);
  assert.equal(update.goal.reached_local_date, null);
  assert.equal(update.goal.current_progress_percent, 75);
});

test('metric progress recognizes unit-specific weight increments before a meaningful best', () => {
  const kgUpdate = evaluate({
    goal: goal({ targetWeightGrams: 50000 }),
    currentWeightGrams: 98000,
    hadAnyMetricBeforeSave: true
  });
  assert.deepEqual(kgUpdate.recognitions, [{ type: 'goal_weight', threshold_grams: 2000 }]);

  const lbUpdate = evaluate({
    weightUnit: 'LB',
    goal: goal({ startWeightGrams: 90718, targetWeightGrams: 45359 }),
    currentWeightGrams: 88450,
    hadAnyMetricBeforeSave: true
  });
  assert.deepEqual(lbUpdate.recognitions, [{ type: 'goal_weight', threshold_grams: 2268 }]);
});

test('metric progress mirrors meaningful new best recognition for loss and gain', () => {
  const loss = evaluate({
    goal: goal(),
    currentWeightGrams: 98500,
    previousMetrics: [{ localDate: '2026-08-02', weightGrams: 99000 }],
    hadAnyMetricBeforeSave: true
  });
  assert.deepEqual(loss.recognitions, [{ type: 'meaningful_best', improvement_grams: 500 }]);

  const gain = evaluate({
    goal: goal({ startWeightGrams: 80000, targetWeightGrams: 100000, dailyDeficit: -500 }),
    currentWeightGrams: 81500,
    previousMetrics: [{ localDate: '2026-08-02', weightGrams: 81000 }],
    hadAnyMetricBeforeSave: true
  });
  assert.deepEqual(gain.recognitions, [{ type: 'meaningful_best', improvement_grams: 500 }]);
});

test('metric progress keeps maintenance and ordinary regressions neutral', () => {
  const maintenance = evaluate({
    goal: goal({ startWeightGrams: 90000, targetWeightGrams: 90000, dailyDeficit: 0 }),
    currentWeightGrams: 90100,
    hadAnyMetricBeforeSave: true
  });
  assert.deepEqual(maintenance.recognitions, []);
  assert.deepEqual(maintenance.goal, {
    id: 11,
    mode: 'maintain',
    previous_progress_percent: null,
    current_progress_percent: null,
    remaining_weight_grams: 100,
    is_complete: false,
    reached_local_date: null
  });

  const regression = evaluate({
    goal: goal(),
    currentWeightGrams: 99600,
    previousMetrics: [{ localDate: '2026-08-02', weightGrams: 99000 }],
    hadAnyMetricBeforeSave: true
  });
  assert.deepEqual(regression.recognitions, []);
});

test('metric progress ignores achievements before the active goal local creation date', () => {
  const update = evaluate({
    goal: goal({ createdLocalDate: '2026-08-01' }),
    currentWeightGrams: 80000,
    previousMetrics: [{ localDate: '2026-07-31', weightGrams: 79000 }],
    hadAnyMetricBeforeSave: true
  });

  assert.deepEqual(update.recognitions, [{ type: 'goal_reached' }]);
  assert.equal(update.goal.reached_local_date, CURRENT_DATE);
});
