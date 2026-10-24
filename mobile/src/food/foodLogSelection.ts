/** @file Source-qualified food selections preserving provider attribution and immutable serving metadata. */

import type { FoodLogCreatePayload, MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';
import {
    buildSearchedFoodLogPayload,
    getDefaultFoodMeasureQuantity,
    getFoodMeasureDisplayAmount,
    getPreferredFoodMeasureIndex,
    type SearchedFoodItem
} from './serving';
import { getFoodQuantityStep } from './quantityInput';
import { parseDecimalInput } from '../utils/numericInput';

export type FoodLogSelection =
    | {
          kind: 'provider';
          key: string;
          name: string;
          item: SearchedFoodItem;
      }
      | {
          kind: 'recent';
          key: string;
          name: string;
          recent: RecentFoodSummary;
          currentMyFood: MyFoodSummary | null;
      }
    | {
          kind: 'my-food';
          key: string;
          name: string;
          item: MyFoodSummary;
      };

export type FoodSelectionDraft = {
    quantity: string;
    measureIndex: string;
    calories: string;
};

export type FoodSelectionPayloadResult =
    | {
          ok: true;
          payload: FoodLogCreatePayload;
          calories: number;
          amountDescription: string;
      }
    | { ok: false; message: string };

type RecentServingBasis = {
    caloriesPerDisplayUnit: number;
    defaultQuantity: number;
    gramsPerUnit: number | null;
    isSyntheticGrams: boolean;
    servingsPerDisplayUnit: number;
    unitLabel: string;
};

const GENERIC_100G_PATTERN = /^(?:per\s*)?100\s*g(?:rams?)?$/i;
const UNIT_SYMBOLS = new Set(['g', 'kg', 'mg', 'ml', 'l', 'oz', 'fl oz', 'lb', 'lbs', 'tsp', 'tbsp']);

function isFiniteNonNegative(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function roundTo(value: number, decimalPlaces: number): number {
    const scale = 10 ** decimalPlaces;
    return Math.round((value + Number.EPSILON) * scale) / scale;
}

function formatInputNumber(value: number): string {
    return roundTo(value, 6).toFixed(6).replace(/\.?0+$/, '');
}

function formatAmount(value: number): string {
    return roundTo(value, 3).toFixed(3).replace(/\.?0+$/, '');
}

function singularizeUnit(label: string): string {
    const normalized = label.trim();
    if (normalized.toLowerCase() === 'servings') return 'serving';
    return normalized;
}

function pluralizeUnit(label: string, quantity: number): string {
    const normalized = singularizeUnit(label);
    if (Math.abs(quantity - 1) < Number.EPSILON) return normalized;
    if (normalized.toLowerCase() === 'grams') return 'g';
    if (UNIT_SYMBOLS.has(normalized.toLowerCase())) return normalized;
    if (/s$/i.test(normalized)) return normalized;
    return `${normalized}s`;
}

function getRecentServingBasis(recent: RecentFoodSummary): RecentServingBasis | null {
    const snapshotLabel = recent.measure_label_snapshot ?? recent.serving_unit_label_snapshot ?? '';
    const isGeneric100g = GENERIC_100G_PATTERN.test(snapshotLabel.trim())
        || (recent.grams_per_measure_snapshot === 100 && GENERIC_100G_PATTERN.test(recent.serving_unit_label_snapshot ?? ''));
    const isPerGramSnapshot = recent.grams_per_measure_snapshot === 1
        && (
            /^(?:1\s*)?g(?:rams?)?$/i.test(snapshotLabel.trim())
            || /^(?:g|gram|grams)$/i.test(recent.serving_unit_label_snapshot?.trim() ?? '')
        );
    const sourceQuantity = isFinitePositive(recent.measure_quantity_snapshot)
        ? recent.measure_quantity_snapshot
        : isFinitePositive(recent.servings_consumed)
            ? recent.servings_consumed
            : 1;
    const sourceCaloriesPerUnit = isFiniteNonNegative(recent.calories_per_serving_snapshot)
        ? recent.calories_per_serving_snapshot
        : isFiniteNonNegative(recent.calories)
            ? recent.calories / sourceQuantity
            : null;

    if (sourceCaloriesPerUnit === null) return null;

    if (isGeneric100g || isPerGramSnapshot) {
        const gramsPerSourceUnit = isFinitePositive(recent.grams_per_measure_snapshot)
            ? recent.grams_per_measure_snapshot
            : 100;
        const defaultGrams = isFinitePositive(recent.grams_total_snapshot)
            ? recent.grams_total_snapshot
            : sourceQuantity * gramsPerSourceUnit;
        return {
            caloriesPerDisplayUnit: sourceCaloriesPerUnit / gramsPerSourceUnit,
            defaultQuantity: defaultGrams,
            gramsPerUnit: 1,
            isSyntheticGrams: true,
            servingsPerDisplayUnit: 1,
            unitLabel: 'g'
        };
    }

    const unitLabel = singularizeUnit(
        recent.serving_unit_label_snapshot
        ?? recent.measure_label_snapshot?.replace(/^per\s+/i, '')
        ?? 'serving'
    );
    const servingSizeQuantity = isFinitePositive(recent.serving_size_quantity_snapshot)
        ? recent.serving_size_quantity_snapshot
        : 1;
    return {
        caloriesPerDisplayUnit: sourceCaloriesPerUnit / servingSizeQuantity,
        defaultQuantity: sourceQuantity * servingSizeQuantity,
        gramsPerUnit: isFinitePositive(recent.grams_per_measure_snapshot)
            ? recent.grams_per_measure_snapshot / servingSizeQuantity
            : null,
        isSyntheticGrams: false,
        servingsPerDisplayUnit: 1 / servingSizeQuantity,
        unitLabel
    };
}

function getCurrentMyFoodDefaultServings(selection: Extract<FoodLogSelection, { kind: 'recent' }>): number {
    if (!selection.currentMyFood) return selection.recent.servings_consumed ?? 1;
    const recentBasis = getRecentServingBasis(selection.recent);
    const currentServingSize = selection.currentMyFood.serving_size_quantity;
    const sameUnit = recentBasis
        && singularizeUnit(recentBasis.unitLabel).toLocaleLowerCase()
            === singularizeUnit(selection.currentMyFood.serving_unit_label).toLocaleLowerCase();
    if (sameUnit && isFinitePositive(currentServingSize)) {
        return recentBasis.defaultQuantity / currentServingSize;
    }
    return selection.recent.servings_consumed ?? 1;
}

/** Creates a provider selection with a stable source-qualified key and its full serving metadata. */
export function createProviderFoodSelection(item: SearchedFoodItem): FoodLogSelection {
    return {
        kind: 'provider',
        key: `provider:${item.source ?? 'unknown'}:${item.id}`,
        name: item.name,
        item
    };
}

/** Creates a recent-log selection, attaching current library data only when its identifier matches. */
export function createRecentFoodSelection(
    recent: RecentFoodSummary,
    currentMyFood?: MyFoodSummary | null
): FoodLogSelection {
    return {
        kind: 'recent',
        key: `recent:${recent.id}`,
        name: recent.name,
        recent,
        currentMyFood: currentMyFood?.id === recent.my_food_id ? currentMyFood : null
    };
}

/**
 * Keep saved-food recents inert until My Foods has resolved. Once it has, a
 * missing source means the saved food was deleted and its historical snapshot
 * is the correct fallback.
 */
export function isRecentFoodSelectionReady(
    recent: RecentFoodSummary,
    currentMyFood: MyFoodSummary | null | undefined,
    hasResolvedMyFoods: boolean
): boolean {
    if (recent.my_food_id === null) return true;
    if (currentMyFood?.id === recent.my_food_id) return true;
    return hasResolvedMyFoods;
}

/** Creates a saved-food selection with a stable library-item key. */
export function createMyFoodSelection(item: MyFoodSummary): FoodLogSelection {
    return {
        kind: 'my-food',
        key: `my-food:${item.id}`,
        name: item.name,
        item
    };
}

/** Detects calorie-only recent entries that have no saved-food or serving snapshot metadata. */
export function isManualRecentSelection(selection: FoodLogSelection): boolean {
    return selection.kind === 'recent'
        && selection.recent.my_food_id === null
        && selection.recent.servings_consumed === null
        && selection.recent.measure_quantity_snapshot === null
        && selection.recent.serving_unit_label_snapshot === null
        && selection.recent.measure_label_snapshot === null;
}

/** Initializes quantity and measure inputs from the selected source's serving defaults. */
export function createFoodSelectionDraft(selection: FoodLogSelection): FoodSelectionDraft {
    if (selection.kind === 'provider') {
        const preferredIndex = getPreferredFoodMeasureIndex(selection.item) ?? 0;
        const measure = selection.item.measures[preferredIndex] ?? null;
        const defaultMeasureCount = getDefaultFoodMeasureQuantity(selection.item, measure);
        return {
            quantity: formatInputNumber(
                defaultMeasureCount * (measure ? getFoodMeasureDisplayAmount(measure).quantity : 1)
            ),
            measureIndex: String(preferredIndex),
            calories: ''
        };
    }

    if (selection.kind === 'my-food') {
        return { quantity: '1', measureIndex: '', calories: '' };
    }

    if (isManualRecentSelection(selection)) {
        return {
            quantity: '',
            measureIndex: '',
            calories: formatInputNumber(selection.recent.calories)
        };
    }

    if (selection.currentMyFood) {
        return {
            quantity: formatInputNumber(getCurrentMyFoodDefaultServings(selection)),
            measureIndex: '',
            calories: ''
        };
    }

    const basis = getRecentServingBasis(selection.recent);
    return {
        quantity: formatInputNumber(
            basis?.defaultQuantity
            ?? selection.recent.servings_consumed
            ?? selection.recent.measure_quantity_snapshot
            ?? 1
        ),
        measureIndex: '',
        calories: ''
    };
}

/** Preserve the selected total weight when changing between provider units. */
export function changeFoodSelectionMeasure(
    selection: FoodLogSelection,
    draft: FoodSelectionDraft,
    nextMeasureIndex: string
): FoodSelectionDraft {
    if (selection.kind !== 'provider') return draft;

    const currentMeasure = selection.item.measures[Number(draft.measureIndex)] ?? null;
    const nextMeasure = selection.item.measures[Number(nextMeasureIndex)] ?? null;
    const currentQuantity = parseDecimalInput(draft.quantity);
    if (!currentMeasure || !nextMeasure || !isFinitePositive(currentQuantity)) {
        return { ...draft, measureIndex: nextMeasureIndex };
    }

    const currentMeasureCount = currentQuantity / getFoodMeasureDisplayAmount(currentMeasure).quantity;
    const gramsTotal = currentMeasureCount * currentMeasure.gramWeight;
    const nextMeasureCount = gramsTotal / nextMeasure.gramWeight;
    return {
        ...draft,
        measureIndex: nextMeasureIndex,
        quantity: formatInputNumber(nextMeasureCount * getFoodMeasureDisplayAmount(nextMeasure).quantity)
    };
}

/** Returns the active serving unit while preserving historical snapshot units for recent entries. */
export function getFoodSelectionUnit(selection: FoodLogSelection, draft: FoodSelectionDraft): string {
    if (selection.kind === 'provider') {
        const measure = selection.item.measures[Number(draft.measureIndex)] ?? null;
        return measure ? singularizeUnit(getFoodMeasureDisplayAmount(measure).unit) : 'serving';
    }
    if (selection.kind === 'my-food') return 'serving';
    if (selection.currentMyFood) return 'serving';
    return getRecentServingBasis(selection.recent)?.unitLabel ?? 'serving';
}

/** Chooses the quantity step appropriate to the selected serving unit. */
export function getFoodSelectionStep(selection: FoodLogSelection, draft: FoodSelectionDraft): number {
    return getFoodQuantityStep(getFoodSelectionUnit(selection, draft));
}

/** Validates quantity and builds a dated meal snapshot while retaining provider and serving provenance. */
export function buildFoodSelectionPayload(options: {
    selection: FoodLogSelection;
    draft: FoodSelectionDraft;
    date: string;
    meal: MealPeriod;
}): FoodSelectionPayloadResult {
    const { selection, draft, date, meal } = options;

    if (selection.kind === 'provider') {
        const measure = selection.item.measures[Number(draft.measureIndex)] ?? null;
        const displayQuantity = parseDecimalInput(draft.quantity);
        const measureCount = measure
            ? displayQuantity / getFoodMeasureDisplayAmount(measure).quantity
            : displayQuantity;
        const result = buildSearchedFoodLogPayload({
            item: selection.item,
            measure,
            quantity: measureCount,
            date,
            meal
        });
        if (!result.ok) return result;
        const selectedUnit = measure
            ? singularizeUnit(getFoodMeasureDisplayAmount(measure).unit)
            : 'serving';
        const isDisplayedInGrams = ['g', 'gram', 'grams'].includes(selectedUnit.trim().toLowerCase());
        return {
            ok: true,
            payload: result.payload,
            calories: result.calculation.calories,
            amountDescription: `${formatAmount(displayQuantity)} ${pluralizeUnit(
                selectedUnit,
                displayQuantity
            )}${isDisplayedInGrams ? '' : ` | ${formatAmount(result.calculation.gramsTotal)} g total`}`
        };
    }

    if (selection.kind === 'my-food') {
        const servings = parseDecimalInput(draft.quantity);
        if (!isFinitePositive(servings)) return { ok: false, message: 'Servings must be a positive number.' };
        return {
            ok: true,
            payload: {
                date,
                meal_period: meal,
                my_food_id: selection.item.id,
                servings_consumed: servings
            },
            calories: Math.round(selection.item.calories_per_serving * servings),
            amountDescription: `${formatAmount(servings)} ${pluralizeUnit('serving', servings)} (${formatAmount(
                selection.item.serving_size_quantity * servings
            )} ${pluralizeUnit(
                selection.item.serving_unit_label,
                selection.item.serving_size_quantity * servings
            )})`
        };
    }

    const { recent } = selection;
    if (isManualRecentSelection(selection)) {
        if (!draft.calories.trim()) return { ok: false, message: 'Calories are required.' };
        const calories = parseDecimalInput(draft.calories);
        if (!isFiniteNonNegative(calories)) return { ok: false, message: 'Calories must be zero or greater.' };
        return {
            ok: true,
            payload: {
                date,
                meal_period: meal,
                name: recent.name,
                calories: Math.round(calories)
            },
            calories: Math.round(calories),
            amountDescription: 'Manual calorie entry'
        };
    }

    const quantity = parseDecimalInput(draft.quantity);
    if (!isFinitePositive(quantity)) return { ok: false, message: 'Amount must be a positive number.' };
    if (selection.currentMyFood) {
        return {
            ok: true,
            payload: {
                date,
                meal_period: meal,
                my_food_id: selection.currentMyFood.id,
                servings_consumed: quantity
            },
            calories: Math.round(selection.currentMyFood.calories_per_serving * quantity),
            amountDescription: `${formatAmount(quantity)} ${pluralizeUnit('serving', quantity)} (${formatAmount(
                selection.currentMyFood.serving_size_quantity * quantity
            )} ${pluralizeUnit(
                selection.currentMyFood.serving_unit_label,
                selection.currentMyFood.serving_size_quantity * quantity
            )})`
        };
    }

    const basis = getRecentServingBasis(recent);
    if (!basis) return { ok: false, message: 'This recent food does not include enough serving data.' };
    const servingsConsumed = roundTo(quantity * basis.servingsPerDisplayUnit, 6);
    const calories = Math.round(basis.caloriesPerDisplayUnit * quantity);
    const gramsTotal = basis.gramsPerUnit === null ? null : roundTo(basis.gramsPerUnit * quantity, 6);
    const hasMeasureSnapshot = basis.isSyntheticGrams
        || recent.measure_quantity_snapshot !== null
        || recent.measure_label_snapshot !== null
        || recent.grams_per_measure_snapshot !== null
        || recent.grams_total_snapshot !== null;
    return {
        ok: true,
        payload: {
            date,
            meal_period: meal,
            name: recent.name,
            calories,
            servings_consumed: servingsConsumed,
            serving_size_quantity_snapshot: basis.isSyntheticGrams ? 1 : recent.serving_size_quantity_snapshot,
            serving_unit_label_snapshot: basis.isSyntheticGrams ? 'g' : recent.serving_unit_label_snapshot,
            calories_per_serving_snapshot: roundTo(
                basis.caloriesPerDisplayUnit / basis.servingsPerDisplayUnit,
                6
            ),
            external_source: recent.external_source,
            external_id: recent.external_id,
            brand: recent.brand_snapshot,
            locale: recent.locale_snapshot,
            barcode: recent.barcode_snapshot,
            measure_label: basis.isSyntheticGrams ? 'grams' : recent.measure_label_snapshot,
            grams_per_measure_snapshot: basis.gramsPerUnit === null
                ? null
                : roundTo(basis.gramsPerUnit / basis.servingsPerDisplayUnit, 6),
            measure_quantity_snapshot: hasMeasureSnapshot ? servingsConsumed : null,
            grams_total_snapshot: gramsTotal
        },
        calories,
        amountDescription: `${formatAmount(quantity)} ${pluralizeUnit(basis.unitLabel, quantity)}${
            gramsTotal === null || basis.isSyntheticGrams ? '' : ` | ${formatAmount(gramsTotal)} g total`
        }`
    };
}

/** Builds concise source and serving context for the selected food. */
export function describeFoodSelection(selection: FoodLogSelection): string {
    if (selection.kind === 'provider') {
        return selection.item.brand ?? 'Food provider result';
    }
    if (selection.kind === 'my-food') {
        const kind = selection.item.type === 'RECIPE' ? 'Saved recipe' : 'Saved food';
        return `${kind} | ${Math.round(selection.item.calories_per_serving)} kcal per serving`;
    }
    return `Recent | ${Math.round(selection.recent.calories)} kcal last logged`;
}
