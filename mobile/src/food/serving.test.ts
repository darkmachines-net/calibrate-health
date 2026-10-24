/** @file Regression coverage for serving: searched food serving calculations. */

import { MEAL_PERIODS } from '@calibrate/shared';
import {
    buildSearchedFoodLogPayload,
    calculateFoodServing,
    getDefaultFoodMeasureQuantity,
    getFoodMeasureDisplayAmount,
    getPreferredFoodMeasureIndex,
    normalizeSearchedFoodItem
} from './serving';

const providerItem = {
    id: 'provider-food-1',
    source: 'fatsecret',
    description: 'Greek yogurt',
    brand: 'Example Dairy',
    barcode: '12345',
    locale: 'en-US',
    availableMeasures: [
        { label: 'per 100g', gramWeight: 100, quantity: 100, unit: 'g' },
        { label: '1 container', gramWeight: 170, quantity: 1, unit: 'container' }
    ],
    nutrientsPer100g: { calories: 59, protein: 10 }
};

describe('searched food serving calculations', () => {
    it('normalizes provider measures and prefers a practical one-serving default', () => {
        const item = normalizeSearchedFoodItem(providerItem);

        expect(item).not.toBeNull();
        expect(item?.name).toBe('Greek yogurt');
        expect(item?.measures).toHaveLength(2);
        expect(item?.measures[0]).toEqual({
            label: 'grams',
            gramWeight: 1,
            quantity: 1,
            unit: 'g'
        });
        expect(getPreferredFoodMeasureIndex(item!)).toBe(1);
        expect(getDefaultFoodMeasureQuantity(item!, item!.measures[1])).toBe(1);
    });

    it('defaults a grams-only food to 100 g and accepts a whole-number gram amount', () => {
        const item = normalizeSearchedFoodItem({
            id: 'grams-only',
            description: 'Spinach',
            availableMeasures: [{ label: 'per 100g', gramWeight: 100 }],
            nutrientsPer100g: { calories: 23 }
        })!;
        const measure = item.measures[0];

        expect(getPreferredFoodMeasureIndex(item)).toBe(0);
        expect(getDefaultFoodMeasureQuantity(item, measure)).toBe(100);
        expect(calculateFoodServing(item, measure, 142)).toEqual({
            quantity: 142,
            calories: 33,
            caloriesPerMeasure: 0.23,
            gramsPerMeasure: 1,
            gramsTotal: 142
        });
    });

    it('deduplicates an equivalent one-gram measure when normalizing per 100g', () => {
        const item = normalizeSearchedFoodItem({
            id: 'duplicate-grams',
            description: 'Duplicate grams',
            availableMeasures: [
                { label: '1 g', gramWeight: 1, quantity: 1, unit: 'g' },
                { label: 'per 100g', gramWeight: 100 }
            ],
            nutrientsPer100g: { calories: 20 }
        })!;

        expect(item.measures).toEqual([{
            label: 'grams',
            gramWeight: 1,
            quantity: 1,
            unit: 'g'
        }]);
    });

    it('parses numeric provider labels when explicit quantity metadata is unavailable', () => {
        const item = normalizeSearchedFoodItem({
            id: 'package-size',
            description: 'Package',
            availableMeasures: [{ label: '250g', gramWeight: 250 }],
            nutrientsPer100g: { calories: 100 }
        })!;
        expect(getFoodMeasureDisplayAmount(item.measures[0])).toEqual({ quantity: 250, unit: 'g' });

        const result = buildSearchedFoodLogPayload({
            item,
            measure: item.measures[0],
            quantity: 1,
            date: '2026-07-12',
            meal: MEAL_PERIODS.LUNCH
        });
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            payload: expect.objectContaining({
                servings_consumed: 1,
                serving_size_quantity_snapshot: 250,
                serving_unit_label_snapshot: 'g',
                grams_total_snapshot: 250
            })
        }));
    });

    it('retains a precise calorie basis for low-density gram measures', () => {
        const item = normalizeSearchedFoodItem({
            id: 'low-density',
            description: 'Broth',
            availableMeasures: [{ label: 'per 100g', gramWeight: 100 }],
            nutrientsPer100g: { calories: 4 }
        })!;
        const result = buildSearchedFoodLogPayload({
            item,
            measure: item.measures[0],
            quantity: 142,
            date: '2026-07-12',
            meal: MEAL_PERIODS.LUNCH
        });

        expect(result).toEqual({
            ok: true,
            calculation: {
                quantity: 142,
                calories: 6,
                caloriesPerMeasure: 0.04,
                gramsPerMeasure: 1,
                gramsTotal: 142
            },
            payload: expect.objectContaining({
                servings_consumed: 142,
                serving_size_quantity_snapshot: 1,
                serving_unit_label_snapshot: 'g',
                calories_per_serving_snapshot: 0.04,
                measure_label: 'grams',
                grams_per_measure_snapshot: 1,
                measure_quantity_snapshot: 142,
                grams_total_snapshot: 142
            })
        });
    });

    it('recomputes calories and grams deterministically for fractional quantities', () => {
        const item = normalizeSearchedFoodItem(providerItem)!;
        const calculation = calculateFoodServing(item, item.measures[1], 1.5);

        expect(calculation).toEqual({
            quantity: 1.5,
            calories: 150,
            caloriesPerMeasure: 100.3,
            gramsPerMeasure: 170,
            gramsTotal: 255
        });
    });

    it('preserves the complete immutable serving and provider snapshot', () => {
        const item = normalizeSearchedFoodItem(providerItem)!;
        const result = buildSearchedFoodLogPayload({
            item,
            measure: item.measures[1],
            quantity: 1.5,
            date: '2026-07-12',
            meal: MEAL_PERIODS.BREAKFAST
        });

        expect(result).toEqual({
            ok: true,
            calculation: expect.objectContaining({ calories: 150, gramsTotal: 255 }),
            payload: {
                date: '2026-07-12',
                meal_period: MEAL_PERIODS.BREAKFAST,
                name: 'Greek yogurt',
                calories: 150,
                servings_consumed: 1.5,
                serving_size_quantity_snapshot: 1,
                serving_unit_label_snapshot: 'container',
                calories_per_serving_snapshot: 100.3,
                external_source: 'fatsecret',
                external_id: 'provider-food-1',
                brand: 'Example Dairy',
                locale: 'en-US',
                barcode: '12345',
                measure_label: '1 container',
                grams_per_measure_snapshot: 170,
                measure_quantity_snapshot: 1.5,
                grams_total_snapshot: 255
            }
        });
    });

    it('rejects missing measures, nutrients, and invalid quantities without inventing snapshots', () => {
        const noData = normalizeSearchedFoodItem({ id: 'x', description: 'Unknown', availableMeasures: [] })!;
        expect(buildSearchedFoodLogPayload({
            item: noData,
            measure: null,
            quantity: 1,
            date: '2026-07-12',
            meal: MEAL_PERIODS.LUNCH
        })).toEqual({ ok: false, message: 'This food does not include a usable serving measure.' });

        const item = normalizeSearchedFoodItem(providerItem)!;
        expect(buildSearchedFoodLogPayload({
            item,
            measure: item.measures[0],
            quantity: 0,
            date: '2026-07-12',
            meal: MEAL_PERIODS.LUNCH
        })).toEqual({ ok: false, message: 'Quantity must be a positive number.' });
    });
});
