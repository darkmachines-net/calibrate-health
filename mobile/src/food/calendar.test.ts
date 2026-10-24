/** @file Regression coverage for calendar: food-day calendar. */

import type { FoodLogDay, FoodLogDaySource, FoodLogDayStatus } from '@calibrate/api-client';
import {
    getCalendarMonthRange,
    getCalendarWeeks,
    getFoodDayCalendarMarker,
    getFoodDayCalendarLabel,
    getFoodDayCalorieBand,
    shiftMonth
} from './calendar';

function day(
    date: string,
    status: FoodLogDayStatus,
    source: FoodLogDaySource
): FoodLogDay {
    return {
        date,
        status,
        source,
        origin: source === 'STORED' ? 'USER' : null,
        is_representative: status === 'COMPLETE',
        is_complete: status === 'COMPLETE',
        completed_at: null,
        updated_at: null
    };
}

describe('food-day calendar', () => {
    it('maps canonical history into distinct calendar markers', () => {
        const today = '2026-07-18';

        expect(getFoodDayCalendarMarker(day('2026-07-14', 'COMPLETE', 'STORED'), today)).toBe('complete-unavailable');
        expect(getFoodDayCalendarMarker(day('2026-07-15', 'INCOMPLETE', 'STORED'), today)).toBe('incomplete');
        expect(getFoodDayCalendarMarker(day('2026-07-16', 'OPEN', 'DEFAULT'), today)).toBe('incomplete');
        expect(getFoodDayCalendarMarker(day('2026-07-17', 'INCOMPLETE', 'INFERRED_EMPTY'), today)).toBe('not-started');
        expect(getFoodDayCalendarMarker(day('2026-07-18', 'PAUSED', 'ACTIVE_PAUSE'), today)).toBe('paused');
        expect(getFoodDayCalendarMarker(day('2026-07-18', 'OPEN', 'DEFAULT'), today)).toBe('none');
    });

    it('builds complete Sunday-first weeks for leap months', () => {
        const weeks = getCalendarWeeks('2024-02');
        expect(weeks).toHaveLength(5);
        expect(weeks[0]).toEqual([null, null, null, null, '2024-02-01', '2024-02-02', '2024-02-03']);
        expect(weeks[4][4]).toBe('2024-02-29');
    });

    it('shifts across years and clamps month requests to the selectable range', () => {
        expect(shiftMonth('2026-01', -1)).toBe('2025-12');
        expect(shiftMonth('2026-12', 1)).toBe('2027-01');
        expect(getCalendarMonthRange('2026-07', '2026-07-11', '2026-07-18')).toEqual({
            startDate: '2026-07-11',
            endDate: '2026-07-18'
        });
    });
});

const captured = '2026-07-18T19:00:00.000Z';
function completed(consumed: number, target = 2000, maintenance = 2500): FoodLogDay {
    return { ...day('2026-07-18', 'COMPLETE', 'STORED'), calorie_comparison: {
        consumed_kcal: consumed, target_kcal: target, maintenance_kcal: maintenance, captured_at: captured
    } };
}

describe('completed calorie comparisons', () => {
    it('follows saved adjusted target ordering even when calibration crosses maintenance', () => {
        // A +250 deficit with +300 accepted correction yields target 2550 at maintenance 2500.
        const capturedDay = completed(2499, 2550, 2500);
        expect(getFoodDayCalendarMarker(capturedDay, '2026-07-18')).toBe('complete-beyond');
        expect(getFoodDayCalendarLabel(capturedDay, '2026-07-18')).toBe('completed, below maintenance');
        expect(getFoodDayCalendarMarker(completed(2500, 2550, 2500), '2026-07-18')).toBe('complete-between');
        expect(getFoodDayCalendarMarker(completed(2550, 2550, 2500), '2026-07-18')).toBe('complete-target');
    });
    it.each([[0, 'target'], [1999, 'target'], [2000, 'target'], [2001, 'between'], [2499, 'between'], [2500, 'between'], [2501, 'beyond']])('loss: %i kcal is %s', (calories, band) => {
        expect(getFoodDayCalendarMarker(completed(Number(calories)), '2026-07-18')).toBe('complete-' + band);
    });
    it.each([[2499, 'beyond'], [2500, 'between'], [2501, 'between'], [2999, 'between'], [3000, 'target'], [3001, 'target']])('gain: %i kcal is %s', (calories, band) => {
        expect(getFoodDayCalendarMarker(completed(Number(calories), 3000), '2026-07-18')).toBe('complete-' + band);
    });
    it.each([[2499, 'target'], [2500, 'target'], [2501, 'beyond']])('maintenance: %i kcal is %s', (calories, band) => {
        expect(getFoodDayCalendarMarker(completed(Number(calories), 2500), '2026-07-18')).toBe('complete-' + band);
    });
    it.each([NaN, Infinity, -1, 1999.9])('does not round or guess invalid intake %s', (value) => {
        expect(getFoodDayCalendarMarker(completed(value), '2026-07-18')).toBe('complete-unavailable');
    });
    it('keeps pause state separate from comparison colors and rejects malformed plans', () => {
        expect(getFoodDayCalendarMarker({ ...completed(2000), status: 'PAUSED' }, '2026-07-18')).toBe('paused');
        expect(getFoodDayCalendarMarker({ ...completed(2000), status: 'OPEN' }, '2026-07-19')).toBe('incomplete');
        expect(getFoodDayCalendarMarker(completed(2000, 0), '2026-07-18')).toBe('complete-unavailable');
        expect(getFoodDayCalendarMarker(completed(2000, 2000, NaN), '2026-07-18')).toBe('complete-unavailable');
        const invalid = completed(2000);
        invalid.calorie_comparison!.captured_at = 'unknown';
        expect(getFoodDayCalendarMarker(invalid, '2026-07-18')).toBe('complete-unavailable');
    });
    it.each([
        [0, 2000, 'target'], [2000, 2000, 'target'], [2001, 2000, 'between'], [2500, 2000, 'between'], [2501, 2000, 'beyond'],
        [2499, 3000, 'beyond'], [2500, 3000, 'between'], [2999, 3000, 'between'], [3000, 3000, 'target'],
        [2500, 2500, 'target'], [2501, 2500, 'beyond']
    ])('uses the same %s/%s calorie band for complete, incomplete and open days', (consumed, target, band) => {
        const complete = completed(Number(consumed), Number(target));
        for (const status of ['COMPLETE', 'INCOMPLETE', 'OPEN'] as const) {
            const current = { ...complete, status };
            expect(getFoodDayCalorieBand(current)).toBe(band);
            if (status !== 'COMPLETE') expect(getFoodDayCalendarMarker(current, '2026-07-18')).toBe('incomplete');
        }
        expect(getFoodDayCalendarLabel({ ...complete, status: 'INCOMPLETE' }, '2026-07-18')).toMatch(/^incomplete, /);
        expect(getFoodDayCalendarLabel({ ...complete, status: 'OPEN' }, '2026-07-18')).toMatch(/^in progress, /);
    });
});
