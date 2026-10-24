/** @file Regression coverage for profile utils: profile utils: isSex validates allowed enum values. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isActivityLevel, isSex } = require('../src/utils/profile');

test('profile utils: isSex validates allowed enum values', () => {
  assert.equal(isSex('MALE'), true);
  assert.equal(isSex('FEMALE'), true);

  assert.equal(isSex('male'), false);
  assert.equal(isSex(''), false);
  assert.equal(isSex(null), false);
});

test('profile utils: isActivityLevel validates allowed enum values', () => {
  assert.equal(isActivityLevel('SEDENTARY'), true);
  assert.equal(isActivityLevel('LIGHT'), true);
  assert.equal(isActivityLevel('MODERATE'), true);
  assert.equal(isActivityLevel('ACTIVE'), true);
  assert.equal(isActivityLevel('VERY_ACTIVE'), true);

  assert.equal(isActivityLevel('moderate'), false);
  assert.equal(isActivityLevel(''), false);
  assert.equal(isActivityLevel(undefined), false);
});