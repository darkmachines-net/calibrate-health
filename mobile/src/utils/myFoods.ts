/** @file Selects recent quick-log foods without duplicating pinned items. */

import type { MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';

/** Avoids showing the same saved item in both quick-log sections while preserving recency order. */
export function selectQuickRecentFoods(
    recentFoods: RecentFoodSummary[],
    pinnedFoods: MyFoodSummary[],
    limit: number
): RecentFoodSummary[] {
    const pinnedIds = new Set(pinnedFoods.map(({ id }) => id));
    return recentFoods
        .filter((recent) => !recent.my_food_id || !pinnedIds.has(recent.my_food_id))
        .slice(0, limit);
}
