/** @file Regression coverage for my Foods: sortMyFoodsPinnedFirst is deterministic with pinned items first. */

import type { MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';
import { selectQuickRecentFoods, sortMyFoodsPinnedFirst } from './myFoods';

function item(id: number, name: string, isPinned: boolean): MyFoodSummary {
    return {
        id,
        name,
        is_pinned: isPinned,
        type: 'FOOD',
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        calories_per_serving: 100
    };
}

test('sortMyFoodsPinnedFirst is deterministic with pinned items first', () => {
    const original = [item(3, 'banana', false), item(2, 'Apple', true), item(1, 'Apple', true)];
    expect(sortMyFoodsPinnedFirst(original).map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(original.map(({ id }) => id)).toEqual([3, 2, 1]);
});

test('selectQuickRecentFoods removes pinned duplicates without reordering recency', () => {
    const recent = [
        { id: 'recent-1', my_food_id: 2, name: 'Apple' },
        { id: 'recent-2', my_food_id: null, name: 'Soup' },
        { id: 'recent-3', my_food_id: 3, name: 'Banana' }
    ] as unknown as RecentFoodSummary[];
    expect(selectQuickRecentFoods(recent, [item(2, 'Apple', true)], 2).map(({ id }) => id))
        .toEqual(['recent-2', 'recent-3']);
});
