/** @file Regression coverage for query Invalidation: profile planning query invalidation. */

import { invalidateProfilePlanningQueries } from './queryInvalidation';

describe('profile planning query invalidation', () => {
    it('refreshes the profile, goal projection, and calibration together', async () => {
        const receivedQueryKeys: unknown[] = [];
        const invalidateQueries = jest.fn(async (filters: { queryKey?: readonly unknown[] }) => {
            receivedQueryKeys.push(filters.queryKey);
        });

        await invalidateProfilePlanningQueries({ invalidateQueries } as never);

        expect(receivedQueryKeys).toEqual([
            ['mobile-profile'],
            ['mobile-goal'],
            ['mobile-calibration-status']
        ]);
    });
});
