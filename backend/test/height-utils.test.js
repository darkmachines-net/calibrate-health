/** @file Regression coverage for height utils: height utils: resolveHeightMmUpdate returns not-provided when all fields are omitted. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveHeightMmUpdate } = require('../src/utils/height');

test('height utils: resolveHeightMmUpdate returns not-provided when all fields are omitted', () => {
  assert.deepEqual(resolveHeightMmUpdate({}), { provided: false, value: null, valid: true });
});

test('height utils: resolveHeightMmUpdate supports clearing height via null/empty string', () => {
  assert.deepEqual(resolveHeightMmUpdate({ height_mm: null }), { provided: true, value: null, valid: true });
  assert.deepEqual(resolveHeightMmUpdate({ height_cm: '' }), { provided: true, value: null, valid: true });
});

test('height utils: resolveHeightMmUpdate validates and normalizes height_mm and height_cm', () => {
  assert.deepEqual(resolveHeightMmUpdate({ height_mm: '1800.4' }), { provided: true, value: 1800, valid: true });
  assert.deepEqual(resolveHeightMmUpdate({ height_cm: 180 }), { provided: true, value: 1800, valid: true });

  assert.deepEqual(resolveHeightMmUpdate({ height_mm: 0 }), { provided: true, value: null, valid: false });
  assert.deepEqual(resolveHeightMmUpdate({ height_cm: -1 }), { provided: true, value: null, valid: false });
});

test('height utils: resolveHeightMmUpdate supports feet/inches inputs', () => {
  assert.deepEqual(resolveHeightMmUpdate({ height_feet: 5, height_inches: 11 }), { provided: true, value: 1803, valid: true });
  assert.deepEqual(resolveHeightMmUpdate({ height_feet: '', height_inches: '10' }), { provided: true, value: 254, valid: true });

  assert.deepEqual(resolveHeightMmUpdate({ height_feet: '0', height_inches: '0' }), { provided: true, value: null, valid: false });
});

test('height utils: resolveHeightMmUpdate prefers height_mm when multiple representations are present', () => {
  // Sending height_mm as null explicitly clears height even if height_cm is also provided.
  assert.deepEqual(resolveHeightMmUpdate({ height_mm: null, height_cm: 180 }), { provided: true, value: null, valid: true });
});

