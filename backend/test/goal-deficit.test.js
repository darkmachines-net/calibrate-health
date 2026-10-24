/** @file Regression coverage for goal deficit: parseDailyDeficit accepts only the allowed deficit/surplus magnitudes. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDailyDeficit } = require('../src/utils/goalDeficit');

test('parseDailyDeficit accepts only the allowed deficit/surplus magnitudes', () => {
  const validCases = [
    { input: 0, expected: 0 },
    { input: '0', expected: 0 },
    { input: 250, expected: 250 },
    { input: '250', expected: 250 },
    { input: -250, expected: -250 },
    { input: '-250', expected: -250 },
    { input: 500, expected: 500 },
    { input: -500, expected: -500 },
    { input: 750, expected: 750 },
    { input: -750, expected: -750 },
    { input: 1000, expected: 1000 },
    { input: -1000, expected: -1000 }
  ];

  for (const { input, expected } of validCases) {
    assert.equal(parseDailyDeficit(input), expected);
  }

  const invalidCases = [
    // Non-numeric / non-finite
    null,
    undefined,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    'not-a-number',
    '250kcal',

    // Not an integer
    250.5,
    '250.5',

    // Unsupported magnitudes
    1,
    -1,
    249,
    -249,
    999,
    -999,
    1001,
    -1001
  ];

  for (const input of invalidCases) {
    assert.equal(parseDailyDeficit(input), null);
  }
});

