/** @file Regression coverage for presentation: activity presentation. */

import type { ActivityDaySummary, ActivityRecordEntry } from '@calibrate/api-client';
import {
    formatActivitySource,
    getActivitySourceLabels,
    hasImportedActivity,
    isActivitySummaryDelayed,
    isActivitySummaryEmpty
} from './presentation';

const summary: ActivityDaySummary = {
    id: 1,
    local_date: '2026-07-11',
    steps: 8000,
    active_calories_kcal: 420,
    total_calories_kcal: 2400,
    exercise_minutes: 35,
    observed_at: '2026-07-11T10:00:00.000Z',
    created_at: '2026-07-11T10:00:00.000Z',
    updated_at: '2026-07-11T10:00:00.000Z'
};

describe('activity presentation', () => {
    it('uses friendly source labels without exposing package identifiers', () => {
        expect(formatActivitySource('com.sec.android.app.shealth')).toBe('Samsung Health');
        expect(formatActivitySource('com.android.healthconnect.phone.abc123')).toBe('Health Connect');
        expect(formatActivitySource('other.app')).toBe('Connected health app');
        expect(getActivitySourceLabels([
            { data_origin: 'other.app' },
            { data_origin: 'com.sec.android.app.shealth' },
            { data_origin: 'com.android.healthconnect.phone.abc123' },
            { data_origin: 'another.app' }
        ] as ActivityRecordEntry[])).toEqual([
            'Connected health app',
            'Health Connect',
            'Samsung Health'
        ]);
    });

    it('distinguishes empty and delayed summaries', () => {
        expect(isActivitySummaryEmpty(summary)).toBe(false);
        expect(isActivitySummaryEmpty({
            ...summary,
            steps: null,
            active_calories_kcal: null,
            total_calories_kcal: null,
            exercise_minutes: null
        })).toBe(true);
        expect(isActivitySummaryDelayed(summary, true, new Date('2026-07-11T17:00:01.000Z'))).toBe(true);
        expect(isActivitySummaryDelayed(summary, false, new Date('2026-07-12T17:00:01.000Z'))).toBe(false);
    });
    it('detects imported summaries or records across selected and recent days', () => {
        const emptySummary = {
            ...summary,
            steps: null,
            active_calories_kcal: null,
            total_calories_kcal: null,
            exercise_minutes: null
        };
        expect(hasImportedActivity([{ local_date: '2026-07-11', summary: emptySummary, records: [] }])).toBe(false);
        expect(hasImportedActivity([{ local_date: '2026-07-11', summary, records: [] }])).toBe(true);
        expect(hasImportedActivity([{
            local_date: '2026-07-11',
            summary: emptySummary,
            records: [{ data_origin: 'other.app' } as ActivityRecordEntry]
        }])).toBe(true);
    });
});
