/** @file Regression coverage for my Food Editing: recipe editing restores live source foods and preserves orphan snapshots. */

import type { MyFoodDetail, MyFoodSummary } from '@calibrate/api-client';
import { hydrateRecipeIngredientDrafts, serializeRecipeIngredientDrafts } from './myFoodEditing';

const savedFood = { id: 4, name: 'Oats', type: 'FOOD', is_pinned: false } as MyFoodSummary;

test('recipe editing restores live source foods and preserves orphan snapshots', () => {
    const detail = {
        recipe_ingredients: [
            { id: 1, source: 'MY_FOOD', source_my_food_id: 4, quantity_servings: 2 },
            {
                id: 2,
                source: 'MY_FOOD',
                source_my_food_id: null,
                quantity_servings: 1,
                name_snapshot: 'Deleted food',
                calories_total_snapshot: 90,
                external_source: null,
                external_id: null,
                brand_snapshot: null,
                locale_snapshot: null,
                barcode_snapshot: null,
                measure_label_snapshot: null,
                grams_per_measure_snapshot: null,
                measure_quantity_snapshot: null,
                grams_total_snapshot: null
            },
            {
                id: 3,
                source: 'EXTERNAL',
                source_my_food_id: null,
                quantity_servings: 142,
                serving_size_quantity_snapshot: 1,
                serving_unit_label_snapshot: 'g',
                calories_per_serving_snapshot: 0.59,
                name_snapshot: 'Logged yogurt',
                calories_total_snapshot: 84,
                external_source: 'fatsecret',
                external_id: 'yogurt-1',
                brand_snapshot: 'Example Dairy',
                locale_snapshot: 'en-US',
                barcode_snapshot: '012345678905',
                measure_label_snapshot: 'grams',
                grams_per_measure_snapshot: 1,
                measure_quantity_snapshot: 142,
                grams_total_snapshot: 142
            }
        ]
    } as unknown as MyFoodDetail;
    const drafts = hydrateRecipeIngredientDrafts(detail, [savedFood]);
    const serialized = serializeRecipeIngredientDrafts(drafts);
    expect(serialized[0]).toEqual(expect.objectContaining({ source: 'MY_FOOD', my_food_id: 4, quantity_servings: 2 }));
    expect(serialized[1]).toEqual(expect.objectContaining({ source: 'EXTERNAL', name: 'Deleted food', calories_total: 90 }));
    expect(serialized[2]).toEqual(expect.objectContaining({
        source: 'EXTERNAL',
        name: 'Logged yogurt',
        calories_total: 84,
        quantity_servings: 142,
        serving_size_quantity: 1,
        serving_unit_label: 'g',
        calories_per_serving: 0.59,
        measure_label: 'grams',
        grams_per_measure: 1,
        measure_quantity: 142,
        grams_total: 142
    }));
});

test('recipe editing keeps an off-page owned source attached using its persisted snapshot', () => {
    const detail = {
        recipe_ingredients: [{
            id: 9,
            source: 'MY_FOOD',
            source_my_food_id: 44,
            quantity_servings: 1.5,
            name_snapshot: 'Deep library oats',
            calories_total_snapshot: 225,
            serving_size_quantity_snapshot: 0.5,
            serving_unit_label_snapshot: 'cup',
            calories_per_serving_snapshot: 150
        }]
    } as unknown as MyFoodDetail;

    const drafts = hydrateRecipeIngredientDrafts(detail, []);

    expect(drafts[0]).toEqual(expect.objectContaining({
        source: 'MY_FOOD',
        servings: 1.5,
        myFood: expect.objectContaining({
            id: 44,
            name: 'Deep library oats',
            serving_size_quantity: 0.5,
            serving_unit_label: 'cup',
            calories_per_serving: 150
        })
    }));
    expect(serializeRecipeIngredientDrafts(drafts)[0]).toEqual(expect.objectContaining({
        source: 'MY_FOOD',
        my_food_id: 44,
        quantity_servings: 1.5
    }));
});
