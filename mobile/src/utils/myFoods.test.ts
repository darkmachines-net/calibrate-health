/** @file Regression coverage for quick-log recency and pinned item deduplication. */

import type { MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';
import { selectQuickRecentFoods } from './myFoods';

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

test('selectQuickRecentFoods removes pinned duplicates without reordering recency', () => {
    const recent = [
        { id: 'recent-1', my_food_id: 2, name: 'Apple' },
        { id: 'recent-2', my_food_id: null, name: 'Soup' },
        { id: 'recent-3', my_food_id: 3, name: 'Banana' }
    ] as unknown as RecentFoodSummary[];
    expect(selectQuickRecentFoods(recent, [item(2, 'Apple', true)], 2).map(({ id }) => id))
        .toEqual(['recent-2', 'recent-3']);
});
