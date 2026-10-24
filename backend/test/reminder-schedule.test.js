/** @file Regression coverage for reminder schedule: reminder wire times use canonical HH:mm values. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatLocalWallClockMinute,
  getLocalWallClock,
  isWithinQuietHours,
  parseLocalWallClockTime
} = require('../src/services/reminderSchedule');

test('reminder wire times use canonical HH:mm values', () => {
  assert.equal(parseLocalWallClockTime('09:05'), 9 * 60 + 5);
  assert.equal(formatLocalWallClockMinute(9 * 60 + 5), '09:05');
  assert.equal(parseLocalWallClockTime('9:05'), null);
  assert.equal(parseLocalWallClockTime('24:00'), null);
});

test('local wall-clock resolution follows IANA DST transitions without inventing UTC schedules', () => {
  assert.deepEqual(
    getLocalWallClock('America/Los_Angeles', new Date('2026-03-08T10:05:00.000Z')),
    { localDate: '2026-03-08', minuteOfDay: 3 * 60 + 5 }
  );

  const firstRepeatedTime = getLocalWallClock(
    'America/Los_Angeles',
    new Date('2026-11-01T08:30:00.000Z')
  );
  const secondRepeatedTime = getLocalWallClock(
    'America/Los_Angeles',
    new Date('2026-11-01T09:30:00.000Z')
  );
  assert.deepEqual(firstRepeatedTime, { localDate: '2026-11-01', minuteOfDay: 90 });
  assert.deepEqual(secondRepeatedTime, firstRepeatedTime);
});

test('current account timezone changes the wall-clock interpretation of the same instant', () => {
  const now = new Date('2026-08-09T15:00:00.000Z');
  assert.deepEqual(getLocalWallClock('America/Los_Angeles', now), {
    localDate: '2026-08-09',
    minuteOfDay: 8 * 60
  });
  assert.deepEqual(getLocalWallClock('America/New_York', now), {
    localDate: '2026-08-09',
    minuteOfDay: 11 * 60
  });
});

test('overnight quiet hours are start-inclusive and end-exclusive', () => {
  const start = 22 * 60;
  const end = 7 * 60;
  assert.equal(isWithinQuietHours(23 * 60, start, end), true);
  assert.equal(isWithinQuietHours(6 * 60 + 59, start, end), true);
  assert.equal(isWithinQuietHours(7 * 60, start, end), false);
  assert.equal(isWithinQuietHours(12 * 60, start, end), false);
});
