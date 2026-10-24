/** @file Regression coverage for cached Foods: uses every cached page and the latest duplicate without overwriting the complete query. */

import { QueryClient } from '@tanstack/react-query';
import type { MyFoodSummary } from '@calibrate/api-client';
import { getCachedSavedFoods } from './cachedFoods';
import { getSavedFoodsLibraryQueryKey } from './queryKeys';

const recipe: MyFoodSummary = {
    id: 14, type: 'RECIPE', name: 'Oats', is_pinned: false,
    serving_size_quantity: 1, serving_unit_label: 'serving',
    calories_per_serving: 320, recipe_total_calories: 640, yield_servings: 2
};

it('uses every cached page and the latest duplicate without overwriting the complete query', () => {
    const client = new QueryClient();
    client.setQueryData(getSavedFoodsLibraryQueryKey('', 'RECIPE'), {
        pages: [{ items: [recipe] }, { items: [{ ...recipe, id: 15 }] }], pageParams: [undefined, '2']
    }, { updatedAt: 100 });
    client.setQueryData(getSavedFoodsLibraryQueryKey('oats', 'ALL'), {
        pages: [{ items: [{ ...recipe, calories_per_serving: 350 }] }], pageParams: [undefined]
    }, { updatedAt: 200 });
    expect(getCachedSavedFoods(client, undefined, 0).map(food => [food.id, food.calories_per_serving]))
        .toEqual([[14, 350], [15, 320]]);
    expect(client.getQueryData(['mobile-my-foods'])).toBeUndefined();
    client.clear();
});

it('does not resurrect deleted foods from pages older than a complete refresh', () => {
    const client = new QueryClient();
    client.setQueryData(getSavedFoodsLibraryQueryKey('', 'RECIPE'), {
        pages: [{ items: [recipe] }], pageParams: [undefined]
    }, { updatedAt: 100 });
    expect(getCachedSavedFoods(client, [], 200)).toEqual([]);
    client.clear();
});
