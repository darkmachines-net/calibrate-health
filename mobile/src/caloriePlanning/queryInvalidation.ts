/** @file query Invalidation: Refresh every server-owned planning view after a profile or unit change. */

import type { QueryClient } from '@tanstack/react-query';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';

const PROFILE_PLANNING_QUERY_KEYS = [
    ['mobile-profile'],
    ['mobile-goal'],
    calibrationStatusQueryKey
] as const;

/** Refresh every server-owned planning view after a profile or unit change. */
export async function invalidateProfilePlanningQueries(
    queryClient: Pick<QueryClient, 'invalidateQueries'>
): Promise<void> {
    await Promise.all(PROFILE_PLANNING_QUERY_KEYS.map((queryKey) =>
        queryClient.invalidateQueries({ queryKey: [...queryKey] })
    ));
}
