/** @file Regression coverage for shared goal deficit: shared goalDeficit exports stable allowed values and defaults. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_DAILY_DEFICIT_ABS_VALUES,
  DAILY_DEFICIT_CHOICE_ABS_VALUES,
  DAILY_DEFICIT_CHOICE_STRINGS,
  DEFAULT_DAILY_DEFICIT_CHOICE_ABS_VALUE,
  DEFAULT_DAILY_DEFICIT_CHOICE_STRING,
  normalizeDailyDeficitChoiceAbsValue
} = require('../../shared/goalDeficit');

test('shared goalDeficit exports stable allowed values and defaults', () => {
  assert.deepEqual(ALLOWED_DAILY_DEFICIT_ABS_VALUES, [0, 250, 500, 750, 1000]);
  assert.equal(DEFAULT_DAILY_DEFICIT_CHOICE_ABS_VALUE, 500);
  assert.equal(DEFAULT_DAILY_DEFICIT_CHOICE_STRING, '500');
});

test('shared goalDeficit exports stable UI choice values (non-maintenance)', () => {
  assert.deepEqual(DAILY_DEFICIT_CHOICE_ABS_VALUES, [250, 500, 750, 1000]);
  assert.deepEqual(DAILY_DEFICIT_CHOICE_STRINGS, ['250', '500', '750', '1000']);
});

test('normalizeDailyDeficitChoiceAbsValue returns a non-maintenance abs magnitude', () => {
  // Allowed values (including negative) normalize to abs values.
  assert.equal(normalizeDailyDeficitChoiceAbsValue(250), 250);
  assert.equal(normalizeDailyDeficitChoiceAbsValue(-250), 250);
  assert.equal(normalizeDailyDeficitChoiceAbsValue('750'), 750);
  assert.equal(normalizeDailyDeficitChoiceAbsValue(-1000), 1000);

  // Maintenance (0) is not a selectable "choice"; it falls back to default.
  assert.equal(normalizeDailyDeficitChoiceAbsValue(0), 500);
  assert.equal(normalizeDailyDeficitChoiceAbsValue('0'), 500);

  // Unsupported/invalid inputs fall back to default.
  assert.equal(normalizeDailyDeficitChoiceAbsValue(999), 500);
  assert.equal(normalizeDailyDeficitChoiceAbsValue('not-a-number'), 500);
  assert.equal(normalizeDailyDeficitChoiceAbsValue(null), 500);
  assert.equal(normalizeDailyDeficitChoiceAbsValue(Number.POSITIVE_INFINITY), 500);
});

