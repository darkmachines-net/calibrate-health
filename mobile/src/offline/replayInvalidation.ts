/** @file replay Invalidation: Refresh every surface whose server-owned state may change after a queued weigh-in replays. */

import type { QueryClient } from '@tanstack/react-query';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { OFFLINE_MUTATION_OPERATIONS } from './operations';
import { isCalibrationEvidenceMutationOperation } from './pendingCalibrationEvidence';
import type { ReconcileResult } from './reconciler';
import { foodTrackingPauseQueryKey } from '../food/queryKeys';
import { foodDayRangeQueryRoot } from '../food/calendar';

const METRIC_REPLAY_QUERY_KEYS = [
    ['mobile-metrics'],
    ['mobile-metrics-trend'],
    ['mobile-profile'],
    ['mobile-goal'],
    ['mobile-in-app-notifications'],
    calibrationStatusQueryKey
] as const;

/** Refresh every surface whose server-owned state may change after a queued weigh-in replays. */
export async function invalidateQueriesAfterOfflineReplay(
    queryClient: Pick<QueryClient, 'invalidateQueries'>,
    result: ReconcileResult
): Promise<void> {
    const replayedTrackingMutation = result.replayedOperations.some(operation =>
        operation === OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE ||
        operation === OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE ||
        operation === OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING ||
        operation === OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS
    );
    const replayedMetricMutation = result.replayedOperations.some((operation) =>
        operation === OFFLINE_MUTATION_OPERATIONS.ADD_METRIC ||
        operation === OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC
    );
    const replayedEvidenceMutation = result.replayedOperations.some(isCalibrationEvidenceMutationOperation);
    if (!replayedEvidenceMutation) return;

    const queryKeys = [
        ...(replayedMetricMutation ? METRIC_REPLAY_QUERY_KEYS : [calibrationStatusQueryKey]),
        ...(replayedTrackingMutation ? [foodTrackingPauseQueryKey, foodDayRangeQueryRoot, ['mobile-food-day']] : [])
    ];
    await Promise.all(queryKeys.map((queryKey) =>
        queryClient.invalidateQueries({ queryKey: [...queryKey] })
    ));
}
