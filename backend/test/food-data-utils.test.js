/** @file Regression coverage for food data utils: foodData utils: round rounds using the requested precision. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNumber, round, scaleNutrients } = require('../src/services/foodData/utils');

test('foodData utils: round rounds using the requested precision', () => {
  assert.equal(round(1.2345), 1.23);
  assert.equal(round(1.2355), 1.24);
  assert.equal(round(1.25, 1), 1.3);
});

test('foodData utils: parseNumber accepts finite numbers and numeric strings', () => {
  assert.equal(parseNumber(1), 1);
  assert.equal(parseNumber(1.5), 1.5);
  assert.equal(parseNumber('2.25'), 2.25);
  assert.equal(parseNumber(' 3.5 '), 3.5);

  assert.equal(parseNumber(Number.NaN), undefined);
  assert.equal(parseNumber(Number.POSITIVE_INFINITY), undefined);
  assert.equal(parseNumber('not-a-number'), undefined);
});

test('foodData utils: scaleNutrients scales and rounds fields consistently', () => {
  const nutrients = { calories: 123, protein: 10.123, fat: 5.333, carbs: 20.555 };
  assert.deepEqual(scaleNutrients(nutrients, 0.5), {
    calories: 61.5,
    protein: 5.06,
    fat: 2.67,
    carbs: 10.28
  });
});

test('foodData utils: scaleNutrients preserves missing macros as undefined', () => {
  const nutrients = { calories: 100 };
  assert.deepEqual(scaleNutrients(nutrients, 2), {
    calories: 200,
    protein: undefined,
    fat: undefined,
    carbs: undefined
  });
});

