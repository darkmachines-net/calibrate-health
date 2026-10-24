/** @file Activity source labels, units, and permission-aware display helpers. */

import type { ActivityDaySummary, ActivityDaysResponse, ActivityRecordEntry } from '@calibrate/api-client';

const ACTIVITY_DELAY_THRESHOLD_MS = 6 * 60 * 60 * 1000; // Flag same-day summaries that have not refreshed for most of a waking day.

const KNOWN_ACTIVITY_SOURCES: Record<string, string> = {
    'com.sec.android.app.shealth': 'Samsung Health',
    'com.samsung.android.wear.shealth': 'Samsung Health',
    'com.fitbit.FitbitMobile': 'Fitbit',
    'com.google.android.apps.fitness': 'Google Fit',
    android: 'Android'
};

const HEALTH_CONNECT_PACKAGE_PATTERN = /(?:^|\.)healthconnect(?:\.|$)/i;

/** Maps known package names to readable sources without exposing unknown package identifiers. */
export function formatActivitySource(packageName: string): string {
    const normalized = packageName.trim();
    if (!normalized) return 'Health Connect';
    const friendly = KNOWN_ACTIVITY_SOURCES[normalized];
    if (friendly) return friendly;
    if (HEALTH_CONNECT_PACKAGE_PATTERN.test(normalized)) return 'Health Connect';
    return 'Connected health app';
}

/** Returns sorted, distinct source labels, falling back to Health Connect when no records exist. */
export function getActivitySourceLabels(records: ActivityRecordEntry[]): string[] {
    const labels = new Set(records.map((record) => formatActivitySource(record.data_origin)));
    if (labels.size === 0) return ['Health Connect'];
    return Array.from(labels).sort();
}

/** Treats a missing summary or one containing only null metrics as empty; zero remains recorded data. */
export function isActivitySummaryEmpty(summary: ActivityDaySummary | null | undefined): boolean {
    if (!summary) return true;
    return [summary.steps, summary.active_calories_kcal, summary.total_calories_kcal, summary.exercise_minutes]
        .every((value) => value === null);
}

/** Reports whether any day contains imported summary values or individual activity records. */
export function hasImportedActivity(days: ActivityDaysResponse['days'] | null | undefined): boolean {
    return (days ?? []).some((day) => !isActivitySummaryEmpty(day.summary) || day.records.length > 0);
}
/** Marks today's summary delayed only when its valid observation time exceeds the freshness threshold. */
export function isActivitySummaryDelayed(
    summary: ActivityDaySummary | null | undefined,
    isToday: boolean,
    now = new Date()
): boolean {
    if (!summary || !isToday) return false;
    const observedAt = new Date(summary.observed_at);
    if (Number.isNaN(observedAt.getTime())) return false;
    return now.getTime() - observedAt.getTime() > ACTIVITY_DELAY_THRESHOLD_MS;
}
