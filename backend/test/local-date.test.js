/** @file Regression coverage for local date: parseLocalDateOnly accepts YYYY-MM-DD and returns a UTC-normalized Date. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLocalDateOnly, getSafeUtcTodayDateOnlyInTimeZone } = require('../src/utils/date');

test('parseLocalDateOnly accepts YYYY-MM-DD and returns a UTC-normalized Date', () => {
  const parsed = parseLocalDateOnly('2025-12-22');
  assert.equal(parsed.toISOString(), '2025-12-22T00:00:00.000Z');
});

test('parseLocalDateOnly accepts ISO-ish strings that start with YYYY-MM-DD', () => {
  const parsed = parseLocalDateOnly('2025-12-22T12:00:00');
  assert.equal(parsed.toISOString(), '2025-12-22T00:00:00.000Z');
});

test('parseLocalDateOnly rejects invalid inputs', () => {
  assert.throws(() => parseLocalDateOnly(''), /Invalid local date/);
  assert.throws(() => parseLocalDateOnly('2025-12'), /Invalid local date/);
  assert.throws(() => parseLocalDateOnly('not-a-date'), /Invalid local date/);
  assert.throws(() => parseLocalDateOnly('2025-99-99'), /Invalid local date/);
  assert.throws(() => parseLocalDateOnly('2025-02-31'), /Invalid local date/);

  assert.throws(() => parseLocalDateOnly(null), /Invalid local date/);
  assert.throws(() => parseLocalDateOnly(123), /Invalid local date/);
  assert.throws(() => parseLocalDateOnly({}), /Invalid local date/);
});

test('getSafeUtcTodayDateOnlyInTimeZone falls back to UTC for invalid timezone values', () => {
  const now = new Date('2025-01-01T05:00:00.000Z');
  const fallback = getSafeUtcTodayDateOnlyInTimeZone('Not/AZone', now);
  assert.equal(fallback.toISOString(), '2025-01-01T00:00:00.000Z');
});

test('getSafeUtcTodayDateOnlyInTimeZone falls back to UTC for missing timezone values', () => {
  const now = new Date('2025-01-01T05:00:00.000Z');
  assert.equal(getSafeUtcTodayDateOnlyInTimeZone('', now).toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(getSafeUtcTodayDateOnlyInTimeZone(null, now).toISOString(), '2025-01-01T00:00:00.000Z');
});
