/** @file Shared synthetic summaries for component and browser tests, kept outside production source. */

import type { PlanCheckResponse } from '@calibrate/api-client';

/** Return independent test evidence with three windows and a saved Sunday report. */
export function planCheckFixture(): PlanCheckResponse {
    return {
        localDate: '2026-11-08', trackingSince: '2026-10-11', trackingDays: 28,
        weightUnit: 'KG', latestWeighInDate: '2026-11-07', needsWeighIn: false,
        windows: [7, 14, 28].map(days => ({
            days: days as 7 | 14 | 28, startDate: new Date(Date.UTC(2026, 10, 8 - days)).toISOString().slice(0, 10),
            endDate: '2026-11-07', loggedFoodDays: days - 2, completeFoodDays: days - 3,
            averageLoggedCalories: 1900, weighIns: Math.ceil(days / 2), weightSpanDays: days - 1,
            weightChangeKg: -days / 20, weeklyWeightChangeKg: -0.35
        })),
        weeklyReportsEnabled: true,
        weeklyReports: [{
            reportDate: '2026-11-08', generatedAt: '2026-11-08T12:00:00Z',
            summary: 'Your recorded weight moved gradually downward this week.',
            highlights: ['You logged food on 5 of 7 days. Missing days are not included in the average.'],
            nextStep: 'Keep logging the meals you can and add a fresh weigh-in.'
        }]
    };
}
