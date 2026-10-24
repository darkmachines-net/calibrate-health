/** @file Canonical saved-food library query keys with search and food-kind identity. */

import type { MyFoodSummary } from '@calibrate/api-client';

export type SavedFoodsFilter = 'ALL' | MyFoodSummary['type'];

export const SAVED_FOODS_LIBRARY_QUERY_KEY = ['mobile-my-foods-library'] as const;
// Shared by every paginated consumer so cached cursors and page boundaries stay aligned.
export const SAVED_FOODS_LIBRARY_PAGE_SIZE = 24;

/** Builds a library query key that distinguishes search text and food-kind filters. */
export function getSavedFoodsLibraryQueryKey(query: string, filter: SavedFoodsFilter) {
    return [...SAVED_FOODS_LIBRARY_QUERY_KEY, query, filter] as const;
}
