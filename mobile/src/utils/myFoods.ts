/** @file my Foods: Mirrors the API's pinned/name/id order while updating the React Query cache. */

import type { MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';

function compareNames(left: string, right: string): number {
    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    if (normalizedLeft < normalizedRight) return -1;
    if (normalizedLeft > normalizedRight) return 1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/** Mirrors the API's pinned/name/id order while updating the React Query cache. */
export function sortMyFoodsPinnedFirst(items: MyFoodSummary[]): MyFoodSummary[] {
    return [...items].sort((left, right) => {
        if (left.is_pinned !== right.is_pinned) return left.is_pinned ? -1 : 1;
        return compareNames(left.name, right.name) || left.id - right.id;
    });
}

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
