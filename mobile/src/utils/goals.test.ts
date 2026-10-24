/** @file Regression coverage for goals: goal summary. */

import type { GoalEntry } from '@calibrate/api-client';
import {
    computeGoalProgress,
    DAILY_GOAL_CHANGE_OPTIONS,
    formatDailyGoalChange,
    formatGoalSummary,
    getDailyGoalChangeCopy,
    getGoalModeFromDailyDeficit,
    getGoalReachedDate,
    getSignedDailyDeficit,
    getTargetWeightAfterGoalModeChange
} from './goals';

function createGoal(dailyDeficit: number, targetWeight = 150): GoalEntry {
    return {
        id: 1,
        start_weight: 175,
        target_weight: targetWeight,
        target_date: null,
        daily_deficit: dailyDeficit,
        created_at: '2026-07-20T00:00:00.000Z'
    };
}

describe('goal summary', () => {
    it('describes loss, gain, and maintenance goals concisely', () => {
        expect(formatGoalSummary(createGoal(500), 'LB')).toBe('Lose to 150 lb | 500 kcal/day deficit');
        expect(formatGoalSummary(createGoal(-250, 82), 'KG')).toBe('Gain to 82 kg | 250 kcal/day surplus');
        expect(formatGoalSummary(createGoal(0, 168), 'LB')).toBe('Maintain around 168 lb');
    });

    it('handles accounts without a goal', () => {
        expect(formatGoalSummary(null, 'LB')).toBe('No active goal set');
    });

    it('shares goal direction and pace copy between onboarding and goal editing', () => {
        expect(DAILY_GOAL_CHANGE_OPTIONS).toEqual([250, 500, 750, 1000]);
        expect(getGoalModeFromDailyDeficit(undefined)).toBe('maintain');
        expect(getGoalModeFromDailyDeficit(500)).toBe('lose');
        expect(getGoalModeFromDailyDeficit(-250)).toBe('gain');
        expect(getSignedDailyDeficit('gain', '500')).toBe(-500);
        expect(getDailyGoalChangeCopy('gain', '500').label).toBe('500 kcal/day surplus');
        expect(formatDailyGoalChange(500)).toBe('500 kcal/day deficit');
    });
});

describe('goal progress state', () => {
    it('finds the first goal-period loss or gain weigh-in that reached the target', () => {
        const lossGoal = createGoal(500, 150);
        expect(getGoalReachedDate({
            goal: lossGoal,
            timezone: 'UTC',
            metrics: [
                { id: 1, date: '2026-07-19', weight: 149 },
                { id: 2, date: '2026-07-20', weight: 151 },
                { id: 3, date: '2026-07-22', weight: 149.8 },
                { id: 4, date: '2026-07-25', weight: 152 }
            ]
        })).toBe('2026-07-22');

        expect(getGoalReachedDate({
            goal: createGoal(-250, 180),
            timezone: 'UTC',
            metrics: [
                { id: 5, date: '2026-07-21', weight: 179.9 },
                { id: 6, date: '2026-07-23', weight: 180.2 }
            ]
        })).toBe('2026-07-23');
    });

    it('keeps maintenance ongoing even for legacy unequal start and target weights', () => {
        const maintenanceGoal = {
            ...createGoal(0, 165),
            start_weight: 175
        };

        expect(getGoalReachedDate({
            goal: maintenanceGoal,
            metrics: [{ id: 1, date: '2026-07-24', weight: 165 }]
        })).toBeNull();
        expect(computeGoalProgress({ startWeight: 165, targetWeight: 165, currentWeight: 165 }))
            .toBeNull();
    });

    it('excludes weigh-ins after the user current local day from goal completion', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-07-25T01:00:00.000Z'));
        try {
            expect(getGoalReachedDate({
                goal: createGoal(500, 150),
                timezone: 'America/Los_Angeles',
                metrics: [{ id: 1, date: '2026-07-25', weight: 149 }]
            })).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    it('syncs a maintenance target to the start weight without changing other mode drafts', () => {
        expect(getTargetWeightAfterGoalModeChange('maintain', '172.4', '165')).toBe('172.4');
        expect(getTargetWeightAfterGoalModeChange('lose', '172.4', '165')).toBe('165');
        expect(getTargetWeightAfterGoalModeChange('gain', '172.4', '180')).toBe('180');
    });
});
