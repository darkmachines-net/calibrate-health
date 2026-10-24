/** @file goal Deficit: Allowed daily calorie deficit/surplus magnitudes (kcal/day). */

/**
 * Allowed daily calorie deficit/surplus magnitudes (kcal/day).
 *
 * We validate goals using the absolute value of the daily calorie change so the same set
 * supports both loss (positive deficit) and gain (negative surplus) modes.
 */
export const ALLOWED_DAILY_DEFICIT_ABS_VALUES = [0, 250, 500, 750, 1000] as const;

export type AllowedDailyDeficitAbsValue = (typeof ALLOWED_DAILY_DEFICIT_ABS_VALUES)[number];

/**
 * Default non-maintenance daily calorie change magnitude (kcal/day) used by the UI when
 * an unexpected/unsupported value is encountered.
 */
export const DEFAULT_DAILY_DEFICIT_CHOICE_ABS_VALUE = 500 as const;

const allowedDailyDeficitAbsValues = new Set<number>(ALLOWED_DAILY_DEFICIT_ABS_VALUES);

/**
 * User-selectable (non-maintenance) daily calorie change magnitudes (kcal/day).
 */
export const DAILY_DEFICIT_CHOICE_ABS_VALUES = ALLOWED_DAILY_DEFICIT_ABS_VALUES.filter(
    (value): value is Exclude<AllowedDailyDeficitAbsValue, 0> => value !== 0
);

/**
 * Preformatted string versions of `DAILY_DEFICIT_CHOICE_ABS_VALUES` for UI select controls.
 */
export const DAILY_DEFICIT_CHOICE_STRINGS = DAILY_DEFICIT_CHOICE_ABS_VALUES.map((value) => value.toString());

/**
 * Default UI string value for daily deficit selections.
 */
export const DEFAULT_DAILY_DEFICIT_CHOICE_STRING = DEFAULT_DAILY_DEFICIT_CHOICE_ABS_VALUE.toString();

/**
 * Parse and validate the goal calorie change.
 *
 * Convention:
 * - positive => deficit (lose weight)
 * - zero => maintenance
 * - negative => surplus (gain weight)
 *
 * Only allows standard deficit/surplus magnitudes to keep projections stable.
 */
export function parseDailyDeficit(input: unknown): number | null {
    const numeric = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : Number.NaN;
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        return null;
    }

    const absValue = Math.abs(numeric);
    if (!allowedDailyDeficitAbsValues.has(absValue)) {
        return null;
    }

    return numeric;
}

/**
 * Normalize a daily-deficit UI selection to one of the allowed non-maintenance choices.
 *
 * Returns an absolute magnitude (kcal/day). Inputs outside the allowed set fall back to the default.
 */
export function normalizeDailyDeficitChoiceAbsValue(input: unknown): number {
    const numeric = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : Number.NaN;
    if (!Number.isFinite(numeric)) {
        return DEFAULT_DAILY_DEFICIT_CHOICE_ABS_VALUE;
    }

    const absValue = Math.abs(numeric);
    if (absValue !== 0 && allowedDailyDeficitAbsValues.has(absValue)) {
        return absValue;
    }

    return DEFAULT_DAILY_DEFICIT_CHOICE_ABS_VALUE;
}
