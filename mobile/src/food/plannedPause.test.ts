/** @file Regression coverage for planned Pause: projects only future days before the expectation, never the target or recorded history. */

import type { FoodTrackingPause } from '@calibrate/api-client';
import { getActivePausePlan, getPauseBrowseMonth, getPauseExpectationCopy, isPlannedPauseDate } from './plannedPause';
import { getTodayDate } from '../utils/dates';

const pause = (expected_resume_on: string | null): FoodTrackingPause => ({
    active: true, id: 1, starts_on: '2026-07-10', expected_resume_on, resumed_on: null,
    started_at: null, resumed_at: null, materialized_through: '2026-07-11', resume_confirmation_due: false
});

it('projects only future days before the expectation, never the target or recorded history', () => {
    const plan = getActivePausePlan(pause('2026-07-15'), '2026-07-11');
    expect(['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-14', '2026-07-15', '2026-07-16']
        .map(date => isPlannedPauseDate(date, '2026-07-11', plan))).toEqual([false, false, true, true, false, false]);
});

it('supports a pause started today and tomorrow as an empty future interval', () => {
    const plan = getActivePausePlan({ ...pause('2026-07-12'), starts_on: '2026-07-11' }, '2026-07-11');
    expect(isPlannedPauseDate('2026-07-12', '2026-07-11', plan)).toBe(false);
});

it('bounds open-ended browsing and preserves due and overdue expectations without new forecasts', () => {
    for (const target of [null, '2026-07-11', '2026-07-10']) {
        const plan = getActivePausePlan(pause(target), '2026-07-11');
        expect(getPauseBrowseMonth('2026-07-11', plan)).toBe('2026-07');
        expect(isPlannedPauseDate('2026-07-12', '2026-07-11', plan)).toBe(target === null);
    }
    expect(getPauseExpectationCopy(getActivePausePlan(pause(null), '2026-07-11'), '2026-07-11')).toBe('Until you resume');
    expect(getPauseExpectationCopy(getActivePausePlan(pause('2026-07-11'), '2026-07-11'), '2026-07-11')).toMatch(/today.*still paused/);
    expect(getPauseExpectationCopy(getActivePausePlan(pause('2026-07-10'), '2026-07-11'), '2026-07-11')).toMatch(/has passed.*still paused/);
});

it.each(['2026-02-30', '2026-13-01', '', '2026-07-12T00:00:00Z', '2025-12-01'])('rejects invalid expectation %s without inventing an open-ended plan', target => {
    expect(getActivePausePlan(pause(target), '2026-07-11')).toBeNull();
});

it('clears forecasts for actual resume, unavailable metadata, or a start in the future', () => {
    for (const value of [undefined, { ...pause(null), active: false }, { ...pause(null), resumed_on: '2026-07-11' }, { ...pause(null), starts_on: '2026-07-12' }]) {
        expect(getActivePausePlan(value, '2026-07-11')).toBeNull();
    }
});

it('includes the target month across years but excludes its target day', () => {
    const plan = getActivePausePlan(pause('2027-01-02'), '2026-12-31');
    expect(getPauseBrowseMonth('2026-12-31', plan)).toBe('2027-01');
    expect(isPlannedPauseDate('2027-01-01', '2026-12-31', plan)).toBe(true);
    expect(isPlannedPauseDate('2027-01-02', '2026-12-31', plan)).toBe(false);
});

it.each([
    ['2026-11-01T06:59:00Z', 'America/Los_Angeles', '2026-10-31'],
    ['2026-11-01T07:01:00Z', 'America/Los_Angeles', '2026-11-01'],
    ['2026-11-01T09:01:00Z', 'America/Los_Angeles', '2026-11-01'],
    ['2026-12-31T12:00:00Z', 'Pacific/Kiritimati', '2027-01-01']
])('uses the account day at %s in %s', (instant, timezone, expectedToday) => {
    jest.useFakeTimers().setSystemTime(new Date(instant));
    try { expect(getTodayDate(timezone)).toBe(expectedToday); } finally { jest.useRealTimers(); }
});
