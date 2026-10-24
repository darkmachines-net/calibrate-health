/** @file Regression coverage for day Presentation: day calorie presentation. */

import {
    getFoodDayStatusLabel,
    getFoodDayCaloriePresentation,
    shouldEmphasizePausedStatus,
    shouldShowCalorieComparison
} from './dayPresentation';
import type { FoodLogDay } from '@calibrate/api-client';

describe('day calorie presentation', () => {
    it.each([
        ['COMPLETE', 'Fully logged'],
        ['OPEN', 'Not fully logged'],
        ['INCOMPLETE', 'Not fully logged'],
        ['PAUSED', 'Paused'],
        [undefined, 'Not fully logged']
    ] as const)('maps %s to the standardized day status', (status, label) => {
        expect(getFoodDayStatusLabel({ status })).toBe(label);
    });

    it('never presents failed day data as fully logged', () => {
        expect(getFoodDayStatusLabel({ status: 'COMPLETE', failed: true })).toBe('Not fully logged');
        expect(getFoodDayStatusLabel({ status: 'PAUSED', failed: true })).toBe('Paused');
    });
    it('shows the real balance for open days that have food data', () => {
        expect(shouldShowCalorieComparison({
            status: 'OPEN',
            isToday: false,
            hasFoodEntries: true
        })).toBe(true);
    });

    it('keeps blank past open days unresolved', () => {
        expect(shouldShowCalorieComparison({
            status: 'OPEN',
            isToday: false,
            hasFoodEntries: false
        })).toBe(false);
    });

    it.each(['INCOMPLETE', 'PAUSED'] as const)('does not interpret %s days against the target', (status) => {
        expect(shouldShowCalorieComparison({
            status,
            isToday: false,
            hasFoodEntries: true
        })).toBe(false);
    });

    it('emphasizes a settled paused status when it is the only calorie content for today', () => {
        expect(shouldEmphasizePausedStatus({
            status: 'PAUSED',
            isToday: true,
            hasFoodEntries: false,
            isContentLoading: false
        })).toBe(true);
    });

    it.each([
        { isToday: false, hasFoodEntries: false, isContentLoading: false },
        { isToday: true, hasFoodEntries: true, isContentLoading: false },
        { isToday: true, hasFoodEntries: false, isContentLoading: true }
    ])('keeps the regular paused layout when other day content or loading state is present', (state) => {
        expect(shouldEmphasizePausedStatus({
            status: 'PAUSED',
            ...state
        })).toBe(false);
    });
});

const saved = { consumed_kcal: 1800, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-20T19:00:00Z' };
const complete = { status: 'COMPLETE', calorie_comparison: saved } as FoodLogDay;

test('saved targets survive later plan changes and pending or unavailable current targets', () => {
    for (const isToday of [true, false]) {
        for (const currentTarget of [2350, null]) {
            expect(getFoodDayCaloriePresentation({ day: complete, isToday, currentTarget }))
                .toEqual({ target: 2000, source: 'saved' });
        }
    }
});

test('legacy completed and populated past open days explicitly fall back without changing history', () => {
    for (const status of ['COMPLETE', 'OPEN'] as const) {
        for (const calorie_comparison of [undefined, null]) {
            const day = { ...complete, status, calorie_comparison };
            for (const currentTarget of [2100, 2350]) {
                expect(getFoodDayCaloriePresentation({ day, isToday: false, currentTarget, hasFoodEntries: true }))
                    .toEqual({ target: currentTarget, source: 'fallback' });
                expect(day.calorie_comparison).toBe(calorie_comparison);
            }
        }
    }
});

test('empty past open, paused, incomplete and invalid current plans remain unavailable', () => {
    for (const status of ['OPEN', 'INCOMPLETE', 'PAUSED'] as const) {
        expect(getFoodDayCaloriePresentation({ day: { ...complete, status }, isToday: false, currentTarget: 2350 }))
            .toEqual({ target: null, source: 'unavailable' });
    }
    for (const currentTarget of [null, NaN, Infinity, 0, -1, 1.5]) {
        expect(getFoodDayCaloriePresentation({ day: { ...complete, calorie_comparison: null }, isToday: false, currentTarget }))
            .toEqual({ target: null, source: 'unavailable' });
    }
    expect(getFoodDayCaloriePresentation({ day: { ...complete, status: 'OPEN' }, isToday: true, currentTarget: 2350 }))
        .toEqual({ target: 2350, source: 'current' });
});
