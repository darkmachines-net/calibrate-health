/** @file Regression coverage for replay Calibration Evidence: calibration evidence replay invalidation. */

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

describe('calibration evidence replay invalidation', () => {
    it.each([
        OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG,
        OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG,
        OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG,
        OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_DAY,
        OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS,
        OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE,
        OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE,
        OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING
    ])('awaits calibration refresh after replaying %s', async (operation) => {
        let finishRefresh: (() => void) | undefined;
        const refreshFinished = new Promise<void>((resolve) => { finishRefresh = resolve; });
        const invalidateQueries = jest.fn(() => refreshFinished);
        let invalidationFinished = false;

        const invalidation = invalidateQueriesAfterOfflineReplay(
            { invalidateQueries } as never,
            replayResult([operation])
        ).then(() => { invalidationFinished = true; });

        await Promise.resolve();
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mobile-calibration-status'] });
        expect(invalidationFinished).toBe(false);

        finishRefresh?.();
        await invalidation;
        expect(invalidationFinished).toBe(true);
    });

    it.each([
        OFFLINE_MUTATION_OPERATIONS.ADD_METRIC,
        OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC
    ])('refreshes goal and calibration after replaying %s', async (operation) => {
        const invalidateQueries = jest.fn(async () => undefined);

        await invalidateQueriesAfterOfflineReplay(
            { invalidateQueries } as never,
            replayResult([operation])
        );

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mobile-goal'] });
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mobile-calibration-status'] });
    });
});
