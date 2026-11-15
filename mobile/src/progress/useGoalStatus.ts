/** @file Account-scoped goal status, server capability state, and coordinated tracking refresh. */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { GoalStatus } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { foodTrackingPauseQueryKey } from '../food/queryKeys';
import { invalidateProfilePlanningQueries } from '../caloriePlanning/queryInvalidation';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';
import { foodDayRangeQueryRoot } from '../food/calendar';

export const goalStatusQueryKey = ['mobile-goal-status'] as const;

/** Convert confirmed bounds to full precision chart units. */
export function getMaintenanceChartRange(status?: GoalStatus | null) {
    if (!status?.maintenance || status.maintenance.status === 'range_required') return undefined;
    const divisor = status.weight_unit === 'LB' ? 453.59237 : 1000;
    return { lower: status.maintenance.range.lower_weight_grams / divisor, upper: status.maintenance.range.upper_weight_grams / divisor };
}

/** Read the feature capability independently of the logged-in user's plan. */
export function useMaintenanceCapability(enabled = true) {
    const { api, serverUrl } = useAuth();
    return useQuery({
        queryKey: ['mobile-maintenance-capability', serverUrl], enabled: enabled && typeof api.getClientConfig === 'function',
        queryFn: async () => (await api.getClientConfig({ cache: 'no-store' })).capabilities.maintenance_goals === true,
        staleTime: 5 * 60 * 1000, retry: false
    });
}

/** Fetch account-local lifecycle and range decisions after the server capability resolves. */
export function useGoalStatus(enabled = true) {
    const { api, user, serverUrl } = useAuth();
    const capability = useMaintenanceCapability(enabled);
    const today = useCurrentLocalDate(user?.timezone);
    const query = useQuery({
        queryKey: [...goalStatusQueryKey, serverUrl, user?.id, today],
        enabled: enabled && capability.data === true,
        queryFn: () => api.getGoalStatus(),
        retry: false
    });
    return { ...query, supported: capability.data === true, capability };
}

/** Refresh both plan and food-day surfaces after an acknowledged goal change. */
export async function refreshGoalViews(client: QueryClient) {
    await Promise.all([
        invalidateProfilePlanningQueries(client),
        ...[foodTrackingPauseQueryKey, ['mobile-food-day'], foodDayRangeQueryRoot, ['mobile-in-app-notifications']]
            .map(queryKey => client.invalidateQueries({ queryKey }))
    ]);
}
