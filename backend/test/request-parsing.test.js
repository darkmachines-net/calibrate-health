/** @file Regression coverage for request parsing: requestParsing: parsePositiveInteger accepts only finite integers >= 1. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parsePositiveInteger,
  parsePositiveNumber,
  resolveLanguageCode
} = require('../src/utils/requestParsing');

test('requestParsing: parsePositiveInteger accepts only finite integers >= 1', () => {
  assert.equal(parsePositiveInteger(1), 1);
  assert.equal(parsePositiveInteger('2'), 2);

  assert.equal(parsePositiveInteger(0), null);
  assert.equal(parsePositiveInteger(-1), null);
  assert.equal(parsePositiveInteger(1.1), null);
  assert.equal(parsePositiveInteger('1.1'), null);
  assert.equal(parsePositiveInteger('not-a-number'), null);
  assert.equal(parsePositiveInteger(null), null);
  assert.equal(parsePositiveInteger(undefined), null);
  assert.equal(parsePositiveInteger(Number.POSITIVE_INFINITY), null);
});

test('requestParsing: parseNonNegativeInteger accepts finite integers >= 0 (truncating numbers)', () => {
  assert.equal(parseNonNegativeInteger(0), 0);
  assert.equal(parseNonNegativeInteger('0'), 0);
  assert.equal(parseNonNegativeInteger(10), 10);
  assert.equal(parseNonNegativeInteger('10'), 10);

  // Route payloads may include floats; we truncate to align with current API behavior.
  assert.equal(parseNonNegativeInteger(10.9), 10);
  assert.equal(parseNonNegativeInteger('10.9'), 10);

  assert.equal(parseNonNegativeInteger(-1), null);
  assert.equal(parseNonNegativeInteger('-1'), null);
  assert.equal(parseNonNegativeInteger(''), null);
  assert.equal(parseNonNegativeInteger('10 calories'), null);
  assert.equal(parseNonNegativeInteger('not-a-number'), null);
  assert.equal(parseNonNegativeInteger({}), null);
  assert.equal(parseNonNegativeInteger(Number.NaN), null);
  assert.equal(parseNonNegativeInteger(Number.POSITIVE_INFINITY), null);
});

test('requestParsing: parseNonNegativeNumber accepts finite numbers >= 0 (including decimals)', () => {
  assert.equal(parseNonNegativeNumber(0), 0);
  assert.equal(parseNonNegativeNumber('0'), 0);
  assert.equal(parseNonNegativeNumber(10), 10);
  assert.equal(parseNonNegativeNumber('10'), 10);
  assert.equal(parseNonNegativeNumber(10.5), 10.5);
  assert.equal(parseNonNegativeNumber('10.5'), 10.5);

  assert.equal(parseNonNegativeNumber(-1), null);
  assert.equal(parseNonNegativeNumber('-1'), null);
  assert.equal(parseNonNegativeNumber(''), null);
  assert.equal(parseNonNegativeNumber('not-a-number'), null);
  assert.equal(parseNonNegativeNumber({}), null);
  assert.equal(parseNonNegativeNumber(Number.NaN), null);
  assert.equal(parseNonNegativeNumber(Number.POSITIVE_INFINITY), null);
});

test('requestParsing: parsePositiveNumber accepts only finite numbers > 0 (including decimals)', () => {
  assert.equal(parsePositiveNumber(1), 1);
  assert.equal(parsePositiveNumber('2'), 2);
  assert.equal(parsePositiveNumber(0.5), 0.5);
  assert.equal(parsePositiveNumber('0.5'), 0.5);

  assert.equal(parsePositiveNumber(0), null);
  assert.equal(parsePositiveNumber('0'), null);
  assert.equal(parsePositiveNumber(-1), null);
  assert.equal(parsePositiveNumber(''), null);
  assert.equal(parsePositiveNumber('not-a-number'), null);
  assert.equal(parsePositiveNumber(null), null);
  assert.equal(parsePositiveNumber(undefined), null);
  assert.equal(parsePositiveNumber(Number.NEGATIVE_INFINITY), null);
  assert.equal(parsePositiveNumber(Number.POSITIVE_INFINITY), null);
});

test('requestParsing: resolveLanguageCode prefers explicit query params over headers', () => {
  assert.equal(
    resolveLanguageCode({
      queryLanguageCode: ' EN ',
      acceptLanguageHeader: 'fr-CA,fr;q=0.9'
    }),
    'en'
  );
});

test('requestParsing: resolveLanguageCode falls back to Accept-Language primary tag', () => {
  assert.equal(resolveLanguageCode({ acceptLanguageHeader: 'en-US,en;q=0.9' }), 'en');
  assert.equal(resolveLanguageCode({ acceptLanguageHeader: ' fr-CA ,fr;q=0.9' }), 'fr');
  assert.equal(resolveLanguageCode({ queryLanguageCode: 123, acceptLanguageHeader: 'en-US,en;q=0.9' }), 'en');

  assert.equal(resolveLanguageCode({ acceptLanguageHeader: '' }), undefined);
  assert.equal(resolveLanguageCode({ acceptLanguageHeader: 123 }), undefined);
});
