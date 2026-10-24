/** @file Consistent food-day labels and available actions for open, complete, paused, and unavailable data. */

import type { FoodLogDay, FoodLogDayStatus } from '@calibrate/api-client';

export type FoodDayStatusLabel = 'Fully logged' | 'Not fully logged' | 'Paused';

/** Maps pause, completion, and failed loading into the visible food-day status label. */
export function getFoodDayStatusLabel({
    status,
    failed = false
}: {
    status: FoodLogDayStatus | undefined;
    failed?: boolean;
}): FoodDayStatusLabel {
    if (status === 'PAUSED') return 'Paused';
    if (failed) return 'Not fully logged';
    if (status === 'COMPLETE') return 'Fully logged';
    return 'Not fully logged';
}
/** Shows comparison for completed days or open days that are current or contain food. */
export function shouldShowCalorieComparison({
    status,
    isToday,
    hasFoodEntries
}: {
    status: FoodLogDayStatus | undefined;
    isToday: boolean;
    hasFoodEntries: boolean;
}) {
    if (status === 'COMPLETE') return true;
    return status === 'OPEN' && (isToday || hasFoodEntries);
}

/** Emphasizes a pause only on an empty, fully loaded current day. */
export function shouldEmphasizePausedStatus({
    status,
    isToday,
    hasFoodEntries,
    isContentLoading
}: {
    status: FoodLogDayStatus | undefined;
    isToday: boolean;
    hasFoodEntries: boolean;
    isContentLoading: boolean;
}) {
    return status === 'PAUSED' && isToday && !hasFoodEntries && !isContentLoading;
}

/** Fallbacks are presentation only; they must never become saved comparisons or calendar bands. */
export function getFoodDayCaloriePresentation({ day, isToday, currentTarget, hasFoodEntries = false }: {
    day: FoodLogDay | undefined;
    isToday: boolean;
    currentTarget: number | null;
    hasFoodEntries?: boolean;
}): { target: number | null; source: 'saved' | 'current' | 'fallback' | 'unavailable' } {
    if (!shouldShowCalorieComparison({ status: day?.status, isToday, hasFoodEntries })) {
        return { target: null, source: 'unavailable' };
    }
    const saved = day?.calorie_comparison;
    if (day?.status === 'COMPLETE' && saved &&
        Number.isSafeInteger(saved.target_kcal) && saved.target_kcal > 0 &&
        Number.isSafeInteger(saved.maintenance_kcal) && saved.maintenance_kcal > 0 &&
        Number.isFinite(Date.parse(saved.captured_at))) {
        return { target: saved.target_kcal, source: 'saved' };
    }
    if (currentTarget === null || !Number.isSafeInteger(currentTarget) || currentTarget <= 0) {
        return { target: null, source: 'unavailable' };
    }
    return { target: currentTarget, source: isToday && day?.status !== 'COMPLETE' ? 'current' : 'fallback' };
}
