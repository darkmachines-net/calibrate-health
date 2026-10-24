/** @file cached Foods: Reuse paginated library snapshots offline without treating a partial page as a complete food list. */

import type { MyFoodSummary, MyFoodsLibraryResponse } from '@calibrate/api-client';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { SAVED_FOODS_LIBRARY_QUERY_KEY } from './queryKeys';

/** Reuse paginated library snapshots offline without treating a partial page as a complete food list. */
export function getCachedSavedFoods(queryClient: QueryClient, foods: MyFoodSummary[] | undefined, updatedAt: number) {
    const items = new Map((foods ?? []).map((food) => [food.id, food]));
    const queries = queryClient.getQueryCache()
        .findAll({ queryKey: SAVED_FOODS_LIBRARY_QUERY_KEY })
        .filter((query) => foods === undefined || query.state.dataUpdatedAt > updatedAt)
        .sort((left, right) => left.state.dataUpdatedAt - right.state.dataUpdatedAt);
    for (const query of queries) {
        const data = query.state.data as InfiniteData<MyFoodsLibraryResponse> | undefined;
        for (const page of data?.pages ?? []) {
            for (const food of page.items) items.set(food.id, food);
        }
    }
    return [...items.values()];
}
