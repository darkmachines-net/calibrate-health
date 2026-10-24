/** @file Guard the smoke timeline against wall-clock date collisions and DST changes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { goalPaceFixtureDates } from './postgres-goal-pace-fixtures.mjs';

/** Format a scenario instant as the account's calendar date. */
function localDay(instant, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(instant));
}

test('historical create has a fresh date on the release failure days', () => {
    for (const day of ['2026-10-11', '2026-10-12']) {
        const dates = goalPaceFixtureDates(`${day}T17:35:25Z`);
        const occupiedDays = [day, dates.timezoneUtcDay, dates.timezonePreviousDay];
        assert(!occupiedDays.includes(dates.historicalDay));
        assert(dates.timezonePreviousDay < dates.timezoneUtcDay);
        assert(dates.timezoneUtcDay < dates.historicalDay);
        assert(dates.historicalDay < day);
    }
});

test('timezone scenarios retain their day relationships across a leap year, DST and year rollover', () => {
    const first = new Date('2024-01-01T00:00:00Z');
    for (let offset = 0; offset <= 366; offset++) {
        const now = new Date(first);
        now.setUTCDate(now.getUTCDate() + offset);
        now.setUTCHours(23, 59, 59, 999);
        const dates = goalPaceFixtureDates(now);
        assert.equal(dates.today.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
        assert.equal(dates.today.getUTCHours(), 0);
        assert.equal(new Set([
            dates.today.toISOString().slice(0, 10), dates.historicalDay,
            dates.timezoneUtcDay, dates.timezonePreviousDay,
        ]).size, 4);
        for (const [zone, acceptedDay] of [
            ['UTC', dates.timezoneUtcDay], ['America/Los_Angeles', dates.timezonePreviousDay],
        ]) {
            assert.equal(localDay(dates.timezoneNow, zone), acceptedDay);
            assert.equal(localDay(dates.metricGoalCreatedAt, zone), dates.timezonePreviousDay);
            assert.equal(localDay(dates.importGoalCreatedAt, zone), acceptedDay);
        }
    }
});
