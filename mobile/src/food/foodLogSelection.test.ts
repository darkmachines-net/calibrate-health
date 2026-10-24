/** @file Regression coverage for food Log Selection: food log selection. */

import type { MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';
import { MEAL_PERIODS } from '@calibrate/shared';
import {
    buildFoodSelectionPayload,
    changeFoodSelectionMeasure,
    createFoodSelectionDraft,
    createMyFoodSelection,
    createProviderFoodSelection,
    createRecentFoodSelection,
    isRecentFoodSelectionReady
} from './foodLogSelection';
import { normalizeSearchedFoodItem } from './serving';

const date = '2026-08-03';
const meal = MEAL_PERIODS.DINNER;

function recent(overrides: Partial<RecentFoodSummary> = {}): RecentFoodSummary {
    return {
        id: 'recent-1',
        name: 'Greek yogurt',
        meal_period: MEAL_PERIODS.BREAKFAST,
        calories: 150,
        my_food_id: null,
        servings_consumed: 1.5,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'container',
        calories_per_serving_snapshot: 100.3,
        external_source: 'fatsecret',
        external_id: 'provider-food-1',
        brand_snapshot: 'Example Dairy',
        locale_snapshot: 'en-US',
        barcode_snapshot: '12345',
        measure_label_snapshot: '1 container',
        grams_per_measure_snapshot: 170,
        measure_quantity_snapshot: 1.5,
        grams_total_snapshot: 255,
        last_logged_at: '2026-08-03T12:00:00.000Z',
        times_logged: 4,
        ...overrides
    };
}

describe('food log selection', () => {
    it('logs a provider grams-only food using whole grams and precise snapshots', () => {
        const item = normalizeSearchedFoodItem({
            id: 'provider-food-1',
            source: 'fatsecret',
            description: 'Greek yogurt',
            availableMeasures: [{ label: 'per 100g', gramWeight: 100, quantity: 100, unit: 'g' }],
            nutrientsPer100g: { calories: 59 }
        })!;
        const selection = createProviderFoodSelection(item);
        const initialDraft = createFoodSelectionDraft(selection);

        expect(initialDraft.quantity).toBe('100');
        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, quantity: '142' },
            date,
            meal
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 84,
            amountDescription: '142 g'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual(expect.objectContaining({
            calories: 84,
            servings_consumed: 142,
            serving_size_quantity_snapshot: 1,
            serving_unit_label_snapshot: 'g',
            calories_per_serving_snapshot: 0.59,
            measure_label: 'grams',
            grams_per_measure_snapshot: 1,
            measure_quantity_snapshot: 142,
            grams_total_snapshot: 142
        }));
    });

    it('accepts whole grams for a numeric 100 g provider label without repeating the total', () => {
        const item = normalizeSearchedFoodItem({
            id: 'provider-food-100g',
            source: 'fatsecret',
            description: 'Chicken breast',
            availableMeasures: [{ label: '100 g', gramWeight: 100 }],
            nutrientsPer100g: { calories: 110 }
        })!;
        const selection = createProviderFoodSelection(item);
        const initialDraft = createFoodSelectionDraft(selection);

        expect(initialDraft.quantity).toBe('100');
        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, quantity: '142' },
            date,
            meal
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 156,
            amountDescription: '142 g'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual(expect.objectContaining({
            servings_consumed: 1.42,
            serving_size_quantity_snapshot: 100,
            serving_unit_label_snapshot: 'g',
            measure_label: '100 g',
            grams_per_measure_snapshot: 100,
            measure_quantity_snapshot: 1.42,
            grams_total_snapshot: 142
        }));
    });

    it('preserves total grams when switching provider units', () => {
        const item = normalizeSearchedFoodItem({
            id: 'provider-food-1',
            description: 'Greek yogurt',
            availableMeasures: [
                { label: 'per 100g', gramWeight: 100, quantity: 100, unit: 'g' },
                { label: '1 container', gramWeight: 170, quantity: 1, unit: 'container' }
            ],
            nutrientsPer100g: { calories: 59 }
        })!;
        const selection = createProviderFoodSelection(item);
        const initialDraft = createFoodSelectionDraft(selection);

        expect(initialDraft).toEqual(expect.objectContaining({ measureIndex: '1', quantity: '1' }));
        expect(changeFoodSelectionMeasure(selection, initialDraft, '0')).toEqual(expect.objectContaining({
            measureIndex: '0',
            quantity: '170'
        }));
    });

    it('shows a provider measure in its declared unit instead of treating it as a serving count', () => {
        const item = normalizeSearchedFoodItem({
            id: 'provider-food-kg',
            description: 'Kilogram serving',
            availableMeasures: [
                { label: '0.1 kg', gramWeight: 100, quantity: 0.1, unit: 'kg' },
                { label: 'per 100g', gramWeight: 100 }
            ],
            nutrientsPer100g: { calories: 200 }
        })!;
        const selection = createProviderFoodSelection(item);
        const initialDraft = createFoodSelectionDraft(selection);

        expect(initialDraft).toEqual(expect.objectContaining({ measureIndex: '0', quantity: '0.1' }));
        const result = buildFoodSelectionPayload({ selection, draft: initialDraft, date, meal });
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 200,
            amountDescription: '0.1 kg | 100 g total'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual(expect.objectContaining({
            servings_consumed: 1,
            serving_size_quantity_snapshot: 0.1,
            serving_unit_label_snapshot: 'kg',
            measure_quantity_snapshot: 1,
            grams_total_snapshot: 100
        }));
        expect(changeFoodSelectionMeasure(selection, initialDraft, '1')).toEqual(expect.objectContaining({
            measureIndex: '1',
            quantity: '100'
        }));
    });

    it('prefills and rescales the exact recent external serving snapshot', () => {
        const selection = createRecentFoodSelection(recent());
        const initialDraft = createFoodSelectionDraft(selection);
        expect(initialDraft.quantity).toBe('1.5');

        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, quantity: '2' },
            date,
            meal
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 201,
            amountDescription: '2 containers | 340 g total'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual(expect.objectContaining({
            calories: 201,
            servings_consumed: 2,
            measure_quantity_snapshot: 2,
            grams_total_snapshot: 340,
            external_id: 'provider-food-1'
        }));
    });

    it('prefills recent provider food in its captured display unit and maps it back to servings', () => {
        const selection = createRecentFoodSelection(recent({
            calories: 150,
            servings_consumed: 1.5,
            serving_size_quantity_snapshot: 3,
            serving_unit_label_snapshot: 'oz',
            calories_per_serving_snapshot: 100,
            measure_label_snapshot: '3 oz',
            grams_per_measure_snapshot: 85,
            measure_quantity_snapshot: 1.5,
            grams_total_snapshot: 127.5
        }));
        const initialDraft = createFoodSelectionDraft(selection);
        expect(initialDraft.quantity).toBe('4.5');

        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, quantity: '6' },
            date,
            meal
        });
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 200,
            amountDescription: '6 oz | 170 g total'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual(expect.objectContaining({
            servings_consumed: 2,
            serving_size_quantity_snapshot: 3,
            calories_per_serving_snapshot: 100,
            grams_per_measure_snapshot: 85,
            measure_quantity_snapshot: 2,
            grams_total_snapshot: 170
        }));
    });

    it('uses the current saved-food basis while retaining the last logged serving count', () => {
        const recentItem = recent({
            name: 'Chocolate cookies',
            calories: 200,
            my_food_id: 12,
            servings_consumed: 2,
            serving_size_quantity_snapshot: 2,
            serving_unit_label_snapshot: 'cookie',
            calories_per_serving_snapshot: 100,
            external_source: null,
            external_id: null,
            brand_snapshot: null,
            locale_snapshot: null,
            barcode_snapshot: null,
            measure_label_snapshot: null,
            grams_per_measure_snapshot: null,
            measure_quantity_snapshot: null,
            grams_total_snapshot: null
        });
        const currentMyFood: MyFoodSummary = {
            id: 12,
            type: 'FOOD',
            name: 'Chocolate cookies',
            serving_size_quantity: 3,
            serving_unit_label: 'cookie',
            calories_per_serving: 120,
            is_pinned: false
        };
        const selection = createRecentFoodSelection(recentItem, currentMyFood);
        const initialDraft = createFoodSelectionDraft(selection);
        expect(initialDraft.quantity).toBe('1.333333');

        const result = buildFoodSelectionPayload({
            selection,
            draft: initialDraft,
            date,
            meal
        });
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 160,
            amountDescription: '1.333 servings (4 cookies)'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual({
            date,
            meal_period: meal,
            my_food_id: 12,
            servings_consumed: 1.333333
        });
    });

    it('waits for My Foods before enabling a linked recent selection', () => {
        const linkedRecent = recent({ my_food_id: 12 });
        const currentMyFood: MyFoodSummary = {
            id: 12,
            type: 'FOOD',
            name: 'Greek yogurt',
            serving_size_quantity: 1,
            serving_unit_label: 'container',
            calories_per_serving: 120,
            is_pinned: false
        };

        expect(isRecentFoodSelectionReady(linkedRecent, null, false)).toBe(false);
        expect(isRecentFoodSelectionReady(linkedRecent, currentMyFood, false)).toBe(true);
        expect(isRecentFoodSelectionReady(linkedRecent, null, true)).toBe(true);
        expect(isRecentFoodSelectionReady(recent({ my_food_id: null }), null, false)).toBe(true);
    });

    it('converts legacy per-100g recent snapshots to grams', () => {
        const selection = createRecentFoodSelection(recent({
            calories: 84,
            servings_consumed: 1.42,
            serving_size_quantity_snapshot: 100,
            serving_unit_label_snapshot: 'g',
            calories_per_serving_snapshot: 59,
            measure_label_snapshot: 'per 100g',
            grams_per_measure_snapshot: 100,
            measure_quantity_snapshot: 1.42,
            grams_total_snapshot: 142
        }));
        const initialDraft = createFoodSelectionDraft(selection);
        expect(initialDraft.quantity).toBe('142');

        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, quantity: '200' },
            date,
            meal
        });
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 118,
            amountDescription: '200 g'
        }));
        if (!result.ok) throw new Error(result.message);
        expect(result.payload).toEqual(expect.objectContaining({
            serving_size_quantity_snapshot: 1,
            serving_unit_label_snapshot: 'g',
            calories_per_serving_snapshot: 0.59,
            measure_label: 'grams',
            grams_per_measure_snapshot: 1,
            measure_quantity_snapshot: 200,
            grams_total_snapshot: 200
        }));
    });

    it('keeps already-normalized gram recents concise', () => {
        const selection = createRecentFoodSelection(recent({
            calories: 84,
            servings_consumed: 142,
            serving_size_quantity_snapshot: 1,
            serving_unit_label_snapshot: 'g',
            calories_per_serving_snapshot: 0.59,
            measure_label_snapshot: 'grams',
            grams_per_measure_snapshot: 1,
            measure_quantity_snapshot: 142,
            grams_total_snapshot: 142
        }));
        const result = buildFoodSelectionPayload({
            selection,
            draft: createFoodSelectionDraft(selection),
            date,
            meal
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            calories: 84,
            amountDescription: '142 g'
        }));
    });

    it('keeps manual recents on an editable calorie input', () => {
        const selection = createRecentFoodSelection(recent({
            name: 'Quick entry',
            calories: 300,
            servings_consumed: null,
            serving_size_quantity_snapshot: null,
            serving_unit_label_snapshot: null,
            calories_per_serving_snapshot: null,
            external_source: null,
            external_id: null,
            brand_snapshot: null,
            locale_snapshot: null,
            barcode_snapshot: null,
            measure_label_snapshot: null,
            grams_per_measure_snapshot: null,
            measure_quantity_snapshot: null,
            grams_total_snapshot: null
        }));
        const initialDraft = createFoodSelectionDraft(selection);
        expect(initialDraft).toEqual(expect.objectContaining({ calories: '300', quantity: '' }));

        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, calories: '325' },
            date,
            meal
        });
        expect(result).toEqual({
            ok: true,
            calories: 325,
            amountDescription: 'Manual calorie entry',
            payload: {
                date,
                meal_period: meal,
                name: 'Quick entry',
                calories: 325
            }
        });
        expect(buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, calories: '' },
            date,
            meal
        })).toEqual({ ok: false, message: 'Calories are required.' });
    });

    it('defaults saved foods to one serving and logs an explicit serving count', () => {
        const item: MyFoodSummary = {
            id: 12,
            type: 'RECIPE',
            name: 'Margarita',
            serving_size_quantity: 8,
            serving_unit_label: 'fl oz',
            calories_per_serving: 240,
            is_pinned: true
        };
        const selection = createMyFoodSelection(item);
        const initialDraft = createFoodSelectionDraft(selection);
        expect(initialDraft.quantity).toBe('1');

        const result = buildFoodSelectionPayload({
            selection,
            draft: { ...initialDraft, quantity: '1.5' },
            date,
            meal
        });
        expect(result).toEqual({
            ok: true,
            calories: 360,
            amountDescription: '1.5 servings (12 fl oz)',
            payload: {
                date,
                meal_period: meal,
                my_food_id: 12,
                servings_consumed: 1.5
            }
        });
    });
});
