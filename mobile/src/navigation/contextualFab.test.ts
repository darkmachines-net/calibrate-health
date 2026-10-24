/** @file Regression coverage for contextual Fab: contextual tab FAB. */

import { getActiveTabRoute, resolveContextualFab } from './contextualFab';

describe('contextual tab FAB', () => {
    it('identifies primary tabs and the full food-log surface', () => {
        expect(getActiveTabRoute('/today')).toBe('today');
        expect(getActiveTabRoute('/progress/')).toBe('progress');
        expect(getActiveTabRoute('/food-log?date=2026-07-20')).toBe('food-log');
        expect(getActiveTabRoute('/settings')).toBeNull();
        expect(getActiveTabRoute('/weight?date=2026-07-20')).toBeNull();
    });

    it('keeps Add food only on the full Food log', () => {
        expect(resolveContextualFab({
            pathname: '/today',
            foodDayStatus: 'OPEN', foodDayStatusLoaded: true
        })).toBeNull();
        expect(resolveContextualFab({
            pathname: '/food-log',
            foodDayStatus: 'OPEN', foodDayStatusLoaded: true
        }))
            .toBe('add-food');
        expect(resolveContextualFab({ pathname: '/progress' })).toBeNull();
        expect(resolveContextualFab({ pathname: '/settings' }))
            .toBeNull();
    });

    it.each(['COMPLETE', 'INCOMPLETE', 'PAUSED'] as const)('hides Add food when the day is %s', (status) => {
        expect(resolveContextualFab({
            pathname: '/food-log',
            foodDayStatus: status,
            foodDayStatusLoaded: true
        })).toBeNull();
    });
});
