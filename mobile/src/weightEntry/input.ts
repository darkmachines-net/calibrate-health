/** @file Weight-entry numeric parsing and canonical precision across metric and imperial input. */

import { MAX_WEIGHT_GRAMS, MIN_WEIGHT_GRAMS, type WeightUnit } from '@calibrate/shared';

const MAX_WEIGHT_DECIMAL_PLACES = 1;

/** Accept both mobile decimal separators while keeping the API's tenth-unit precision visible. */
export function normalizeWeightInputText(rawValue: string): string {
    const normalizedSeparator = rawValue.replace(/,/g, '.');
    const digitsAndSeparators = normalizedSeparator.replace(/[^\d.]/g, '');
    const [whole = '', ...fractionParts] = digitsAndSeparators.split('.');
    if (fractionParts.length === 0) return whole;
    const fraction = fractionParts.join('').slice(0, MAX_WEIGHT_DECIMAL_PLACES);
    return `${whole}.${fraction}`;
}

/** Parses positive finite weight input with comma decimal support, returning null for incomplete values. */
export function parseWeightInput(value: string): number | null {
    if (!value.trim() || value === '.') return null;
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Formats weight input to supported precision without a redundant zero decimal. */
export function formatWeightInput(value: number): string {
    return value.toFixed(MAX_WEIGHT_DECIMAL_PLACES).replace(/\.0$/, '');
}

function weightInputToCanonicalGrams(value: number, unit: WeightUnit | undefined): number {
    const grams = unit === 'LB' ? value * 453.59237 : value * 1_000;
    return Math.round(grams);
}

/** Checks a display-unit weight against the shared canonical gram bounds. */
export function isWeightWithinPolicy(value: number, unit: WeightUnit | undefined): boolean {
    if (!Number.isFinite(value)) return false;
    const grams = weightInputToCanonicalGrams(value, unit);
    return grams >= MIN_WEIGHT_GRAMS && grams <= MAX_WEIGHT_GRAMS;
}

/** Returns conservative editable weight bounds in the selected display units. */
export function getWeightDisplayBounds(unit: WeightUnit | undefined): { minimum: number; maximum: number } {
    return unit === 'LB'
        ? { minimum: 55.2, maximum: 881.8 }
        : { minimum: 25, maximum: 400 };
}

/** Builds an actionable supported-weight-range message in the selected units. */
export function getWeightPolicyError(unit: WeightUnit | undefined): string {
    const bounds = getWeightDisplayBounds(unit);
    const unitLabel = unit === 'LB' ? 'lb' : 'kg';
    return `Enter a weight from ${bounds.minimum} to ${bounds.maximum} ${unitLabel}.`;
}

/** Returns the singular or plural spoken weight unit for accessibility copy. */
export function getSpokenWeightUnit(unit: WeightUnit | undefined, plural = true): string {
    if (unit === 'LB') return plural ? 'pounds' : 'pound';
    return plural ? 'kilograms' : 'kilogram';
}

/** Flags a large absolute or relative jump from a positive previous weight for user review. */
export function isWeightOutlier(args: {
    value: number;
    previousValue: number | null;
    unit: WeightUnit | undefined;
}): boolean {
    const { value, previousValue, unit } = args;
    if (previousValue === null || previousValue <= 0) return false;
    const absoluteChange = Math.abs(value - previousValue);
    const unitThreshold = unit === 'LB' ? 10 : 5;
    return absoluteChange >= unitThreshold || absoluteChange / previousValue >= 0.1;
}
