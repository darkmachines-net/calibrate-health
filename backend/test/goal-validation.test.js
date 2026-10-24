/** @file Regression coverage for goal validation: goalValidation: validateGoalWeightsForDailyDeficit enforces loss direction for positive deficits. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGoalWeightsForDailyDeficit } = require('../src/utils/goalValidation');

test('goalValidation: validateGoalWeightsForDailyDeficit enforces loss direction for positive deficits', () => {
  assert.equal(
    validateGoalWeightsForDailyDeficit({
      dailyDeficit: 500,
      startWeightGrams: 80000,
      targetWeightGrams: 80000
    }),
    'For a weight loss goal, target weight must be less than start weight.'
  );

  assert.equal(
    validateGoalWeightsForDailyDeficit({
      dailyDeficit: 500,
      startWeightGrams: 80000,
      targetWeightGrams: 79000
    }),
    null
  );
});

test('goalValidation: validateGoalWeightsForDailyDeficit enforces gain direction for negative deficits', () => {
  assert.equal(
    validateGoalWeightsForDailyDeficit({
      dailyDeficit: -500,
      startWeightGrams: 80000,
      targetWeightGrams: 80000
    }),
    'For a weight gain goal, target weight must be greater than start weight.'
  );

  assert.equal(
    validateGoalWeightsForDailyDeficit({
      dailyDeficit: -500,
      startWeightGrams: 80000,
      targetWeightGrams: 81000
    }),
    null
  );
});

test('goalValidation: validateGoalWeightsForDailyDeficit allows maintenance goals', () => {
  assert.equal(
    validateGoalWeightsForDailyDeficit({
      dailyDeficit: 0,
      startWeightGrams: 80000,
      targetWeightGrams: 90000
    }),
    null
  );
});

