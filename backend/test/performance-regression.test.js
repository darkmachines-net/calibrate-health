/** @file Regression coverage for performance regression: balances reference work from the reviewed per-operation ratio. */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  balancedReferenceIterations,
  evaluateBenchmarkRatio,
  isConfirmedBenchmarkRegression,
  normalizeRatioPpm,
} = require('../scripts/performance-regression');

test('balances reference work from the reviewed per-operation ratio', () => {
  assert.equal(balancedReferenceIterations(40, 30_332_540), 1_200);
  assert.equal(balancedReferenceIterations(2_000, 2_163_563), 4_000);
  assert.equal(balancedReferenceIterations(40, 499_999), 40);
  assert.throws(() => balancedReferenceIterations(0, 1_000_000), /positive safe integer/);
  assert.throws(() => balancedReferenceIterations(40, Number.NaN), /positive safe integer/);
});

test('normalizes unequal batch sizes back to a per-operation ratio', () => {
  assert.equal(normalizeRatioPpm(2_300, 1_000, 10, 100), 23_000_000);
  assert.throws(() => normalizeRatioPpm(0, 1_000, 10, 100), /finite and positive/);
});

test('allows the exact reviewed threshold and rejects the next ppm', () => {
  assert.deepEqual(evaluateBenchmarkRatio(33_365_794, 30_332_540, 10), {
    allowed: 33_365_794,
    exceeds: false,
  });
  assert.deepEqual(evaluateBenchmarkRatio(33_365_795, 30_332_540, 10), {
    allowed: 33_365_794,
    exceeds: true,
  });
});

test('requires an independent median to reproduce a benchmark regression', () => {
  assert.equal(isConfirmedBenchmarkRegression(33_365_795, 33_365_794, 30_332_540, 10), false);
  assert.equal(isConfirmedBenchmarkRegression(33_365_795, 33_365_795, 30_332_540, 10), true);
  assert.equal(isConfirmedBenchmarkRegression(33_365_794, 40_000_000, 30_332_540, 10), false);
});
