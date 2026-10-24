/** @file Provider serving normalization and conversions between selected amounts and immutable log snapshots. */

import type { FoodLogCreatePayload } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';

export type ProviderFoodMeasure = {
    label: string;
    gramWeight: number;
    quantity: number | null;
    unit: string | null;
};

export type SearchedFoodItem = {
    id: string;
    name: string;
    source: string | null;
    brand: string | null;
    barcode: string | null;
    locale: string | null;
    measures: ProviderFoodMeasure[];
    caloriesPer100g: number | null;
};

export type FoodServingCalculation = {
    quantity: number;
    calories: number;
    caloriesPerMeasure: number;
    gramsPerMeasure: number;
    gramsTotal: number;
};

export type FoodMeasureDisplayAmount = {
    quantity: number;
    unit: string;
};

export type FoodServingPayloadResult =
    | { ok: true; payload: FoodLogCreatePayload; calculation: FoodServingCalculation }
    | { ok: false; message: string };

const GENERIC_PER_100_GRAMS_LABEL = 'per 100g';
const SYNTHETIC_GRAMS_LABEL = 'grams';
const LABELED_MEASURE_AMOUNT_PATTERN = /^(\d+(?:\.\d+)?)\s*(\D.*)$/;
// Keeps low-density per-gram calorie bases precise while avoiding floating-point noise in snapshots.
const SNAPSHOT_DECIMAL_PLACES = 6;

const roundTo = (value: number, decimalPlaces: number): number => {
    const scale = 10 ** decimalPlaces;
    return Math.round((value + Number.EPSILON) * scale) / scale;
};

const optionalText = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
};

const optionalPositiveNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const optionalNonNegativeNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const isGenericPer100GramsLabel = (label: string): boolean =>
    label.trim().toLowerCase() === GENERIC_PER_100_GRAMS_LABEL;

/** Identify the client-only gram measure used in place of a provider's generic per-100g option. */
const isSyntheticGramMeasure = (measure: ProviderFoodMeasure): boolean =>
    measure.label === SYNTHETIC_GRAMS_LABEL &&
    measure.gramWeight === 1 &&
    measure.quantity === 1 &&
    measure.unit === 'g';

const isEquivalentOneGramMeasure = (measure: ProviderFoodMeasure): boolean => {
    if (measure.gramWeight !== 1) return false;
    const normalizedUnit = measure.unit?.trim().toLowerCase();
    const normalizedLabel = measure.label.replace(/\s+/g, '').toLowerCase();
    return normalizedUnit === 'g' ||
        normalizedUnit === 'gram' ||
        normalizedUnit === 'grams' ||
        normalizedLabel === '1g' ||
        normalizedLabel === 'gram' ||
        normalizedLabel === 'grams';
};

/** Normalize the provider wire object without trusting optional third-party fields. */
export function normalizeSearchedFoodItem(value: unknown): SearchedFoodItem | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = optionalText(record.id);
    const name = optionalText(record.description) ?? optionalText(record.name);
    if (!id || !name) return null;

    let rawMeasures: unknown[] = [];
    if (Array.isArray(record.availableMeasures)) {
        rawMeasures = record.availableMeasures;
    } else if (Array.isArray(record.measures)) {
        rawMeasures = record.measures;
    }
    const normalizedMeasures = rawMeasures.flatMap((rawMeasure): ProviderFoodMeasure[] => {
        if (!rawMeasure || typeof rawMeasure !== 'object') return [];
        const measure = rawMeasure as Record<string, unknown>;
        const label = optionalText(measure.label);
        const gramWeight = optionalPositiveNumber(measure.gramWeight);
        if (!label || !gramWeight) return [];
        if (isGenericPer100GramsLabel(label)) {
            return [{
                label: SYNTHETIC_GRAMS_LABEL,
                gramWeight: 1,
                quantity: 1,
                unit: 'g'
            }];
        }
        return [{
            label,
            gramWeight,
            quantity: optionalPositiveNumber(measure.quantity),
            unit: optionalText(measure.unit)
        }];
    });
    const syntheticGramIndex = normalizedMeasures.findIndex(isSyntheticGramMeasure);
    const measures = syntheticGramIndex < 0
        ? normalizedMeasures
        : normalizedMeasures.filter(
            (measure, index) => index === syntheticGramIndex || !isEquivalentOneGramMeasure(measure)
        );

    const nutrients = record.nutrientsPer100g;
    const caloriesPer100g = nutrients && typeof nutrients === 'object'
        ? optionalNonNegativeNumber((nutrients as Record<string, unknown>).calories)
        : null;

    return {
        id,
        name,
        source: optionalText(record.source),
        brand: optionalText(record.brand),
        barcode: optionalText(record.barcode),
        locale: optionalText(record.locale),
        measures,
        caloriesPer100g
    };
}

/** Resolve the amount represented by one measure for consistent input and snapshot labels. */
export function getFoodMeasureDisplayAmount(measure: ProviderFoodMeasure): FoodMeasureDisplayAmount {
    const explicitUnit = optionalText(measure.unit);
    if (explicitUnit) {
        return {
            quantity: optionalPositiveNumber(measure.quantity) ?? 1,
            unit: explicitUnit
        };
    }

    const normalizedLabel = measure.label.replace(/^per\s+/i, '').trim();
    const labeledAmount = normalizedLabel.match(LABELED_MEASURE_AMOUNT_PATTERN);
    if (labeledAmount) {
        const quantity = Number(labeledAmount[1]);
        const unit = labeledAmount[2].trim();
        if (Number.isFinite(quantity) && quantity > 0 && unit) {
            return { quantity, unit };
        }
    }

    return {
        quantity: optionalPositiveNumber(measure.quantity) ?? 1,
        unit: normalizedLabel || 'serving'
    };
}

/** Prefer a practical serving over a provider's generic per-100g measure. */
export function getPreferredFoodMeasureIndex(item: SearchedFoodItem): number | null {
    if (item.measures.length === 0) return null;
    const practicalIndex = item.measures.findIndex(
        (measure) => !isSyntheticGramMeasure(measure)
    );
    return practicalIndex >= 0 ? practicalIndex : 0;
}

/** Start grams-only foods at a familiar 100 g amount; practical measures start at one. */
export function getDefaultFoodMeasureQuantity(
    item: SearchedFoodItem,
    measure: ProviderFoodMeasure | null
): number {
    if (!measure) return 1;
    const hasOnlySyntheticGramMeasures = item.measures.length > 0 && item.measures.every(isSyntheticGramMeasure);
    return hasOnlySyntheticGramMeasures && isSyntheticGramMeasure(measure) ? 100 : 1;
}

/** Scale provider per-100g energy into the selected measure and user-entered quantity. */
export function calculateFoodServing(
    item: SearchedFoodItem,
    measure: ProviderFoodMeasure,
    quantity: number
): FoodServingCalculation | null {
    if (!Number.isFinite(quantity) || quantity <= 0 || item.caloriesPer100g === null) return null;

    const gramsPerMeasure = roundTo(measure.gramWeight, SNAPSHOT_DECIMAL_PLACES);
    const gramsTotal = roundTo(gramsPerMeasure * quantity, SNAPSHOT_DECIMAL_PLACES);
    const caloriesPerMeasure = roundTo(
        (item.caloriesPer100g * gramsPerMeasure) / 100,
        SNAPSHOT_DECIMAL_PLACES
    );
    const caloriesTotal = (item.caloriesPer100g * gramsTotal) / 100;
    return {
        quantity,
        calories: Math.round(caloriesTotal),
        caloriesPerMeasure,
        gramsPerMeasure,
        gramsTotal
    };
}

/** Build an immutable external-food snapshot from one deterministic serving calculation. */
export function buildSearchedFoodLogPayload(options: {
    item: SearchedFoodItem;
    measure: ProviderFoodMeasure | null;
    quantity: number;
    date: string;
    meal: MealPeriod;
}): FoodServingPayloadResult {
    if (!options.measure) {
        return { ok: false, message: 'This food does not include a usable serving measure.' };
    }
    if (!Number.isFinite(options.quantity) || options.quantity <= 0) {
        return { ok: false, message: 'Quantity must be a positive number.' };
    }

    const calculation = calculateFoodServing(options.item, options.measure, options.quantity);
    if (!calculation) {
        return { ok: false, message: 'This food does not include enough nutrition data to calculate calories.' };
    }
    const displayAmount = getFoodMeasureDisplayAmount(options.measure);

    return {
        ok: true,
        calculation,
        payload: {
            date: options.date,
            meal_period: options.meal,
            name: options.item.name,
            calories: calculation.calories,
            servings_consumed: calculation.quantity,
            serving_size_quantity_snapshot: displayAmount.quantity,
            serving_unit_label_snapshot: displayAmount.unit,
            calories_per_serving_snapshot: calculation.caloriesPerMeasure,
            external_source: options.item.source,
            external_id: options.item.id,
            brand: options.item.brand,
            locale: options.item.locale,
            barcode: options.item.barcode,
            measure_label: options.measure.label,
            grams_per_measure_snapshot: calculation.gramsPerMeasure,
            measure_quantity_snapshot: calculation.quantity,
            grams_total_snapshot: calculation.gramsTotal
        }
    };
}
