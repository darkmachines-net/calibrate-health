/** @file Food calendar query identity, local-date ranges, and saved-comparison presentation. */

import type { FoodLogDay } from '@calibrate/api-client';

export type FoodDayCalendarMarker = 'complete-target' | 'complete-between' | 'complete-beyond' | 'complete-unavailable' | 'incomplete' | 'not-started' | 'paused' | 'none';
export type FoodDayCalorieBand = 'target' | 'between' | 'beyond' | 'unavailable';

export const foodDayRangeQueryRoot = ['mobile-food-days'] as const;

/** Builds a stable query key for an explicit food-day date range. */
export function foodDayRangeQueryKey(startDate: string, endDate: string) {
    return [...foodDayRangeQueryRoot, startDate, endDate] as const;
}

/** Classifies intake against the saved target and maintenance ordering; invalid or missing snapshots are unavailable. */
export function getFoodDayCalorieBand(day: FoodLogDay | undefined): FoodDayCalorieBand {
    const comparison = day?.calorie_comparison;
    if (!comparison) return 'unavailable';
    const { consumed_kcal: consumed, target_kcal: target, maintenance_kcal: maintenance, captured_at: captured } = comparison;
    if (!Number.isSafeInteger(consumed) || consumed < 0 ||
        !Number.isSafeInteger(target) || target <= 0 ||
        !Number.isSafeInteger(maintenance) || maintenance <= 0 ||
        typeof captured !== 'string' || !Number.isFinite(Date.parse(captured))) return 'unavailable';
    // Issue #408 follows the saved target ordering, including accepted corrections that cross maintenance.
    if (target > maintenance) {
        if (consumed >= target) return 'target';
        return consumed >= maintenance ? 'between' : 'beyond';
    }
    if (consumed <= target) return 'target';
    return consumed <= maintenance ? 'between' : 'beyond';
}

/** Classifies calendar completion using the day's saved calorie comparison and valid snapshot evidence. */
export function getFoodDayCalendarMarker(
    day: FoodLogDay | undefined,
    today: string
): FoodDayCalendarMarker {
    if (!day) return 'none';
    if (day.status === 'COMPLETE') return `complete-${getFoodDayCalorieBand(day)}`;
    if (day.status === 'PAUSED') return 'paused';
    if (day.source === 'INFERRED_EMPTY' || day.source === 'BEFORE_TRACKING_START') {
        return 'not-started';
    }
    if (day.status === 'INCOMPLETE') return 'incomplete';
    if (day.status === 'OPEN' && (day.date < today || getFoodDayCalorieBand(day) !== 'unavailable')) return 'incomplete';
    return 'none';
}

/** Describes a calendar marker accessibly, accounting for gain versus loss target direction. */
export function getFoodDayCalendarLabel(day: FoodLogDay | undefined, today: string): string {
    const marker = getFoodDayCalendarMarker(day, today);
    if (marker === 'incomplete' || day?.status === 'COMPLETE') {
        let status = 'completed';
        if (marker === 'incomplete') status = 'incomplete';
        if (day?.status === 'OPEN' && day.date >= today) status = 'in progress';
        return `${status}, ${getFoodDayComparisonLabel(day)}`;
    }
    switch (marker) {
        case 'not-started': return 'not started';
        case 'paused': return 'tracking paused';
        default: return 'in progress';
    }
}

function getFoodDayComparisonLabel(day: FoodLogDay | undefined): string {
    const targetAboveMaintenance = (day?.calorie_comparison?.target_kcal ?? 0) > (day?.calorie_comparison?.maintenance_kcal ?? 0);
    switch (getFoodDayCalorieBand(day)) {
        case 'target': return targetAboveMaintenance ? 'at or above target' : 'at or below target';
        case 'between': return targetAboveMaintenance ? 'below target, at or above maintenance' : 'above target, at or below maintenance';
        case 'beyond': return targetAboveMaintenance ? 'below maintenance' : 'above maintenance';
        default: return 'comparison unavailable';
    }
}

/** Extracts the year-month key from a canonical date-only string. */
export function getMonthKey(date: string): string {
    return date.slice(0, 7);
}

/** Offsets a year-month key with UTC calendar arithmetic so host timezone cannot shift the result. */
export function shiftMonth(monthKey: string, offset: number): string {
    const [yearString, monthString] = monthKey.split('-');
    const date = new Date(Date.UTC(Number(yearString), Number(monthString) - 1 + offset, 1));
    return date.toISOString().slice(0, 7);
}

/** Intersects a calendar month with the allowed tracking-date bounds. */
export function getCalendarMonthRange(monthKey: string, minDate: string, maxDate: string) {
    const [yearString, monthString] = monthKey.split('-');
    const year = Number(yearString);
    const month = Number(monthString);
    const monthStart = `${monthKey}-01`;
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return {
        startDate: monthStart < minDate ? minDate : monthStart,
        endDate: monthEnd > maxDate ? maxDate : monthEnd
    };
}

/** Builds Sunday-first calendar rows with null padding outside the requested month. */
export function getCalendarWeeks(monthKey: string): Array<Array<string | null>> {
    const [yearString, monthString] = monthKey.split('-');
    const year = Number(yearString);
    const month = Number(monthString);
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const cells = Array.from({ length: cellCount }, (_, index) => {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) return null;
        return `${monthKey}-${String(day).padStart(2, '0')}`;
    });

    return Array.from({ length: cellCount / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
}
