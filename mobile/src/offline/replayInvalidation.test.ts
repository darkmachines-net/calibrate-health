/** @file Regression coverage for replay Invalidation: offline replay query invalidation. */

import { OFFLINE_MUTATION_OPERATIONS } from './operations';
import { invalidateQueriesAfterOfflineReplay } from './replayInvalidation';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

function replayResult(replayedOperations: string[]) {
    return {
        replayed: replayedOperations.length,
        replayedOperations,
        failedMutation: null,
        deferredMutation: null,
        retryAfterMs: null
    };
}

describe('offline replay query invalidation', () => {
    it.each([
        OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE,
        OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE,
        OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING,
        OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS
    ])('refreshes the shared pause, actual day and history after %s replays', async operation => {
        const invalidateQueries = jest.fn(async () => undefined);
        await invalidateQueriesAfterOfflineReplay({ invalidateQueries } as never, replayResult([operation]));
        for (const queryKey of [['mobile-food-tracking-pause'], ['mobile-food-day'], ['mobile-food-days']]) {
            expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
        }
    });
    it.each([
        OFFLINE_MUTATION_OPERATIONS.ADD_METRIC,
        OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC
    ])('refreshes metric-derived and notification state after %s', async (operation) => {
        const receivedQueryKeys: unknown[] = [];
        const invalidateQueries = jest.fn(async (filters: { queryKey?: readonly unknown[] }) => {
            receivedQueryKeys.push(filters.queryKey);
        });

        await invalidateQueriesAfterOfflineReplay(
            { invalidateQueries } as never,
            replayResult([operation])
        );

        expect(receivedQueryKeys).toEqual([
            ['mobile-metrics'],
            ['mobile-metrics-trend'],
            ['mobile-profile'],
            ['mobile-goal'],
            ['mobile-in-app-notifications'],
            ['mobile-calibration-status']
        ]);
    });

    it('refreshes calibration after a replayed food or day-evidence mutation', async () => {
        const invalidateQueries = jest.fn(async () => undefined);

        await invalidateQueriesAfterOfflineReplay(
            { invalidateQueries } as never,
            replayResult([OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG])
        );

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mobile-calibration-status'] });
    });

    it('does not refresh calibration for unrelated replayed operations', async () => {
        const invalidateQueries = jest.fn(async () => undefined);

        await invalidateQueriesAfterOfflineReplay(
            { invalidateQueries } as never,
            replayResult(['unrelated.future-operation'])
        );

        expect(invalidateQueries).not.toHaveBeenCalled();
    });
});
