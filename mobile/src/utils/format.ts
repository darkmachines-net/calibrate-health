/** @file Consistent client meal, measurement, and numeric display formatting. */

import { MEAL_PERIODS, type MealPeriod, type WeightUnit } from '@calibrate/shared';

const MEAL_LABELS: Record<MealPeriod, string> = {
    [MEAL_PERIODS.BREAKFAST]: 'Breakfast',
    [MEAL_PERIODS.MORNING_SNACK]: 'Morning Snack',
    [MEAL_PERIODS.LUNCH]: 'Lunch',
    [MEAL_PERIODS.AFTERNOON_SNACK]: 'Afternoon Snack',
    [MEAL_PERIODS.DINNER]: 'Dinner',
    [MEAL_PERIODS.EVENING_SNACK]: 'Evening Snack'
};

/** Resolves the fixed meal-period label with the original value as a fallback. */
export function formatMealPeriod(meal: MealPeriod): string {
    return MEAL_LABELS[meal] ?? meal;
}

/** Formats finite calories as a localized rounded kcal value, otherwise a missing-value dash. */
export function formatCalories(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }

    return `${Math.round(value).toLocaleString()} kcal`;
}

/** Formats a finite number with bounded displayed precision, otherwise a missing-value dash. */
export function formatNumber(value: number | null | undefined, fractionDigits = 1): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }

    return value.toLocaleString(undefined, {
        maximumFractionDigits: fractionDigits
    });
}

/** Formats a finite display-unit weight with its unit label, otherwise a missing-value dash. */
export function formatWeight(value: number | null | undefined, unit: WeightUnit | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }

    return `${formatNumber(value)} ${formatWeightUnit(unit)}`;
}

/** Returns the display abbreviation for pounds or the default kilograms. */
export function formatWeightUnit(unit: WeightUnit | undefined): string {
    return unit === 'LB' ? 'lb' : 'kg';
}
