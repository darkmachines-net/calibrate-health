/** @file Regression coverage for my foods utils: myFoodsUtils: normalizeServingUnitLabel trims and collapses whitespace. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MY_FOOD_NAME_MAX_LENGTH,
  SERVING_UNIT_LABEL_MAX_LENGTH,
  createHttpError,
  isHttpError,
  normalizeMyFoodName,
  normalizeOptionalString,
  normalizeServingUnitLabel
} = require('../src/routes/myFoodsUtils');

test('myFoodsUtils: normalizeServingUnitLabel trims and collapses whitespace', () => {
  assert.equal(normalizeServingUnitLabel('  fl   oz  '), 'fl oz');
  assert.equal(normalizeServingUnitLabel(''), null);
  assert.equal(normalizeServingUnitLabel('   '), null);
  assert.equal(normalizeServingUnitLabel(null), null);
});

test('myFoodsUtils: normalizeServingUnitLabel enforces max length', () => {
  assert.equal(normalizeServingUnitLabel('a'.repeat(SERVING_UNIT_LABEL_MAX_LENGTH)), 'a'.repeat(SERVING_UNIT_LABEL_MAX_LENGTH));
  assert.equal(normalizeServingUnitLabel('a'.repeat(SERVING_UNIT_LABEL_MAX_LENGTH + 1)), null);
});

test('myFoodsUtils: normalizeMyFoodName trims and collapses whitespace', () => {
  assert.equal(normalizeMyFoodName('  Peanut   butter  '), 'Peanut butter');
  assert.equal(normalizeMyFoodName(''), null);
  assert.equal(normalizeMyFoodName(undefined), null);
});

test('myFoodsUtils: normalizeMyFoodName enforces max length', () => {
  assert.equal(normalizeMyFoodName('a'.repeat(MY_FOOD_NAME_MAX_LENGTH)), 'a'.repeat(MY_FOOD_NAME_MAX_LENGTH));
  assert.equal(normalizeMyFoodName('a'.repeat(MY_FOOD_NAME_MAX_LENGTH + 1)), null);
});

test('myFoodsUtils: normalizeOptionalString trims and treats empty as missing', () => {
  assert.equal(normalizeOptionalString('  Brand  '), 'Brand');
  assert.equal(normalizeOptionalString(''), null);
  assert.equal(normalizeOptionalString('   '), null);
  assert.equal(normalizeOptionalString(123), null);
});

test('myFoodsUtils: createHttpError and isHttpError provide lightweight status codes', () => {
  const err = createHttpError(400, 'Bad request');
  assert.equal(err.message, 'Bad request');
  assert.equal(err.statusCode, 400);
  assert.equal(isHttpError(err), true);

  assert.equal(isHttpError(new Error('oops')), false);
  assert.equal(isHttpError(null), false);
});

