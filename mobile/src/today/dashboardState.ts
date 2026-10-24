/** @file dashboard State: Reports whether any Today dashboard query has failed, including a retained error on cached data. */

import {
    resolveAsyncResourceState,
    type AsyncQuerySnapshot,
    type AsyncResourceState
} from '../asyncState/resolveAsyncState';

export type TodayDashboardQuerySnapshot = AsyncQuerySnapshot<unknown>;

/** Reports whether any Today dashboard query has failed, including a retained error on cached data. */
export function hasTodayDashboardFailure(
    queries: readonly TodayDashboardQuerySnapshot[]
): boolean {
    return queries.some((query) => query.status === 'error' || query.error != null);
}

/** Treat all Today resources as one truthful dashboard without losing cached-content states. */
export function resolveTodayDashboardState(
    queries: readonly TodayDashboardQuerySnapshot[],
    isOnline: boolean
): AsyncResourceState {
    const failedQueries = queries.filter((query) => query.status === 'error' || query.error != null);
    const allDataResolved = queries.every((query) => query.data !== undefined);
    const failedResourcesHaveUsableCache = failedQueries.every((query) =>
        query.data != null && (!Array.isArray(query.data) || query.data.length > 0)
    );
    const hasUsableDashboardData = allDataResolved && failedResourcesHaveUsableCache;

    return resolveAsyncResourceState({
        data: hasUsableDashboardData ? true : undefined,
        status: failedQueries.length > 0
            ? 'error'
            : queries.every((query) => query.status === 'success') ? 'success' : 'pending',
        fetchStatus: queries.some((query) => query.fetchStatus === 'paused')
            ? 'paused'
            : queries.some((query) => query.fetchStatus === 'fetching') ? 'fetching' : 'idle',
        error: failedQueries[0]?.error ?? null,
        dataUpdatedAt: hasUsableDashboardData ? 1 : 0,
        isPlaceholderData: queries.some((query) => query.isPlaceholderData)
    }, {
        isEmpty: () => false,
        isOnline
    });
}
