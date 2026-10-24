/** @file Regression coverage for units utils: isWeightUnit identifies supported weight units. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  gramsToWeight,
  isHeightUnit,
  isWeightUnit,
  parseWeightToGrams
} = require('../src/utils/units');
const { isPolicyWeight } = require('../../shared/caloriePolicy');

test('isWeightUnit identifies supported weight units', () => {
  assert.equal(isWeightUnit('KG'), true);
  assert.equal(isWeightUnit('LB'), true);

  assert.equal(isWeightUnit('kg'), false);
  assert.equal(isWeightUnit('lbs'), false);
  assert.equal(isWeightUnit(''), false);
  assert.equal(isWeightUnit(null), false);
  assert.equal(isWeightUnit(undefined), false);
  assert.equal(isWeightUnit(123), false);
});

test('isHeightUnit identifies supported height units', () => {
  assert.equal(isHeightUnit('CM'), true);
  assert.equal(isHeightUnit('FT_IN'), true);

  assert.equal(isHeightUnit('cm'), false);
  assert.equal(isHeightUnit('FTIN'), false);
  assert.equal(isHeightUnit(''), false);
  assert.equal(isHeightUnit(null), false);
  assert.equal(isHeightUnit(undefined), false);
  assert.equal(isHeightUnit(123), false);
});

test('parseWeightToGrams converts kilograms to grams (rounded to 0.1 kg)', () => {
  assert.equal(parseWeightToGrams(1, 'KG'), 1000);
  assert.equal(parseWeightToGrams('1', 'KG'), 1000);
  assert.equal(parseWeightToGrams(1.04, 'KG'), 1000);
  assert.equal(parseWeightToGrams(1.05, 'KG'), 1100);
});

test('parseWeightToGrams converts pounds to grams (rounded to 0.1 lb)', () => {
  // 150 lb -> 68038.8555g -> 68039g
  assert.equal(parseWeightToGrams(150, 'LB'), 68039);
  // 150.05 rounds to 150.1 before converting.
  assert.equal(parseWeightToGrams(150.05, 'LB'), 68084);
});

test('API weight conversion enforces exact KG and one-decimal LB policy boundaries', () => {
  for (const [value, unit, expected] of [
    [24.9, 'KG', false], [25, 'KG', true], [400, 'KG', true], [400.1, 'KG', false],
    [55.1, 'LB', false], [55.2, 'LB', true], [881.8, 'LB', true], [881.9, 'LB', false]
  ]) {
    assert.equal(isPolicyWeight(parseWeightToGrams(value, unit)), expected, `${value} ${unit}`);
  }
});

test('parseWeightToGrams rejects invalid weights', () => {
  assert.throws(() => parseWeightToGrams('', 'KG'), /Weight must be positive/);
  assert.throws(() => parseWeightToGrams('not-a-number', 'KG'), /Invalid weight/);
  assert.throws(() => parseWeightToGrams({}, 'KG'), /Invalid weight/);
  assert.throws(() => parseWeightToGrams(0, 'KG'), /Weight must be positive/);
  assert.throws(() => parseWeightToGrams(-1, 'KG'), /Weight must be positive/);
});

test('gramsToWeight converts grams to the requested unit (rounded to 0.1)', () => {
  assert.equal(gramsToWeight(1000, 'KG'), 1);
  assert.equal(gramsToWeight(1100, 'KG'), 1.1);

  assert.equal(gramsToWeight(68039, 'LB'), 150);
  assert.equal(gramsToWeight(68084, 'LB'), 150.1);
});

test('gramsToWeight rejects invalid grams', () => {
  assert.throws(() => gramsToWeight(Number.NaN, 'KG'), /Invalid weight/);
  assert.throws(() => gramsToWeight(Number.POSITIVE_INFINITY, 'KG'), /Invalid weight/);
});
