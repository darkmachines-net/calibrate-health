/** @file food Log Amount: Resolve the amount users recognize from immutable serving snapshots and map edits back to servings. */

import type { FoodLogEntry } from '@calibrate/api-client';

export type FoodLogEditableAmount = {
    amount: number;
    unitLabel: string;
    toServings: (amount: number) => number;
};

export type FoodLogAmountSnapshot = Pick<
    FoodLogEntry,
    | 'servings_consumed'
    | 'serving_size_quantity_snapshot'
    | 'serving_unit_label_snapshot'
    | 'measure_label_snapshot'
    | 'grams_per_measure_snapshot'
    | 'measure_quantity_snapshot'
    | 'grams_total_snapshot'
>;

const AMOUNT_DECIMAL_PLACES = 6;
const UNIT_SYMBOLS = new Set(['g', 'kg', 'mg', 'ml', 'l', 'oz', 'fl oz', 'lb', 'lbs', 'tsp', 'tbsp']);

const positiveFiniteNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const roundAmount = (value: number): number => {
    const scale = 10 ** AMOUNT_DECIMAL_PLACES;
    return Math.round((value + Number.EPSILON) * scale) / scale;
};

const normalizeUnitLabel = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const normalized = value
        .trim()
        .replace(/^per\s+/i, '')
        .replace(/^1(?:\.0+)?\s+/i, '')
        .trim();
    return normalized || null;
};

const isLegacyPer100Grams = (entry: FoodLogAmountSnapshot): boolean => {
    const measureLabel = entry.measure_label_snapshot?.trim().toLowerCase();
    const unitLabel = entry.serving_unit_label_snapshot?.replace(/\s+/g, '').toLowerCase();
    return measureLabel === 'per 100g' || unitLabel === '100g' || unitLabel === '100gram' || unitLabel === '100grams';
};

const pluralizeUnitLabel = (unitLabel: string, amount: number): string => {
    if (amount === 1 || UNIT_SYMBOLS.has(unitLabel.toLowerCase())) return unitLabel;

    const separatorIndex = unitLabel.lastIndexOf(' ');
    const prefix = separatorIndex >= 0 ? unitLabel.slice(0, separatorIndex + 1) : '';
    const unitNoun = separatorIndex >= 0 ? unitLabel.slice(separatorIndex + 1) : unitLabel;
    if (unitNoun.toLowerCase().endsWith('s')) return unitLabel;

    let pluralNoun: string;
    if (/(?:s|x|z|ch|sh)$/i.test(unitNoun)) {
        pluralNoun = `${unitNoun}es`;
    } else if (/[^aeiou]y$/i.test(unitNoun)) {
        pluralNoun = `${unitNoun.slice(0, -1)}ies`;
    } else {
        pluralNoun = `${unitNoun}s`;
    }
    return `${prefix}${pluralNoun}`;
};

/**
 * Resolve the amount users recognize from immutable serving snapshots and map edits back to servings.
 */
export function getFoodLogEditableAmount(entry: FoodLogAmountSnapshot): FoodLogEditableAmount | null {
    const measureCount =
        positiveFiniteNumber(entry.servings_consumed) ??
        positiveFiniteNumber(entry.measure_quantity_snapshot);
    const gramsPerMeasure = positiveFiniteNumber(entry.grams_per_measure_snapshot);
    const gramsTotal = positiveFiniteNumber(entry.grams_total_snapshot);

    if (isLegacyPer100Grams(entry)) {
        const gramsPerLegacyMeasure = gramsPerMeasure ?? 100;
        const amount = gramsTotal ?? (measureCount === null ? null : measureCount * gramsPerLegacyMeasure);
        if (amount === null) return null;
        return {
            amount: roundAmount(amount),
            unitLabel: 'g',
            toServings: (nextAmount) => roundAmount(nextAmount / gramsPerLegacyMeasure)
        };
    }

    if (measureCount !== null) {
        const servingSize = positiveFiniteNumber(entry.serving_size_quantity_snapshot) ?? 1;
        const unitLabel =
            normalizeUnitLabel(entry.serving_unit_label_snapshot) ??
            normalizeUnitLabel(entry.measure_label_snapshot) ??
            'serving';
        return {
            amount: roundAmount(measureCount * servingSize),
            unitLabel,
            toServings: (nextAmount) => roundAmount(nextAmount / servingSize)
        };
    }

    if (gramsTotal !== null && gramsPerMeasure !== null) {
        return {
            amount: roundAmount(gramsTotal),
            unitLabel: 'g',
            toServings: (nextAmount) => roundAmount(nextAmount / gramsPerMeasure)
        };
    }

    return null;
}

/** Format a food-log amount using its real snapshot unit instead of a generic serving count. */
export function getFoodLogAmountText(entry: FoodLogAmountSnapshot): string | null {
    const editableAmount = getFoodLogEditableAmount(entry);
    if (editableAmount) {
        return `${editableAmount.amount} ${pluralizeUnitLabel(editableAmount.unitLabel, editableAmount.amount)}`;
    }
    const gramsTotal = positiveFiniteNumber(entry.grams_total_snapshot);
    return gramsTotal === null ? null : `${roundAmount(gramsTotal)} g`;
}
