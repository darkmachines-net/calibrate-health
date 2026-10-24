/** @file Regression coverage for meal period: mealPeriod: parseMealPeriod accepts canonical enum identifiers. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMealPeriod } = require('../src/utils/mealPeriod');

test('mealPeriod: parseMealPeriod accepts canonical enum identifiers', () => {
  assert.equal(parseMealPeriod('BREAKFAST'), 'BREAKFAST');
  assert.equal(parseMealPeriod(' DINNER '), 'DINNER');
});

test('mealPeriod: parseMealPeriod rejects invalid inputs', () => {
  assert.equal(parseMealPeriod('breakfast'), null);
  assert.equal(parseMealPeriod(''), null);
  assert.equal(parseMealPeriod(null), null);
  assert.equal(parseMealPeriod(undefined), null);
});

