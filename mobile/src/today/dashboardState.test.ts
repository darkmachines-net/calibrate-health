/** @file Regression coverage for dashboard State: resolveTodayDashboardState. */

import { ASYNC_RESOURCE_STATES } from '../asyncState/resolveAsyncState';
import {
    hasTodayDashboardFailure,
    resolveTodayDashboardState,
    type TodayDashboardQuerySnapshot
} from './dashboardState';

const resolvedQuery = (
    data: unknown,
    overrides: Partial<TodayDashboardQuerySnapshot> = {}
): TodayDashboardQuerySnapshot => ({
    data,
    status: 'success',
    fetchStatus: 'idle',
    error: null,
    dataUpdatedAt: 10,
    ...overrides
});

const populatedDashboard = () => [
    resolvedQuery({ calorieSummary: {} }),
    resolvedQuery([{ id: 1 }]),
    resolvedQuery({ status: 'OPEN' }),
    resolvedQuery([{ id: 1 }])
];

describe('resolveTodayDashboardState', () => {
    it('renders content for populated data and verified empty food and weight collections', () => {
        expect(resolveTodayDashboardState(populatedDashboard(), true).kind)
            .toBe(ASYNC_RESOURCE_STATES.CONTENT);
        expect(resolveTodayDashboardState([
            resolvedQuery({ calorieSummary: {} }),
            resolvedQuery([]),
            resolvedQuery({ status: 'OPEN' }),
            resolvedQuery([])
        ], true).kind).toBe(ASYNC_RESOURCE_STATES.CONTENT);
    });

    it('renders a terminal error when a failed empty resource has no truthful cached value', () => {
        const queries = populatedDashboard();
        queries[1] = resolvedQuery([], {
            status: 'error',
            error: new Error('private provider details')
        });

        expect(resolveTodayDashboardState(queries, true).kind)
            .toBe(ASYNC_RESOURCE_STATES.ERROR);
    });

    it('keeps non-empty cached content visible but marks a failed refresh degraded', () => {
        const queries = populatedDashboard();
        queries[1] = resolvedQuery([{ id: 1 }], {
            status: 'error',
            error: new Error('private provider details')
        });

        expect(resolveTodayDashboardState(queries, true).kind)
            .toBe(ASYNC_RESOURCE_STATES.DEGRADED);
        expect(hasTodayDashboardFailure(queries)).toBe(true);
    });

    it('marks cached content stale offline and uses a terminal offline state without cache', () => {
        expect(resolveTodayDashboardState(populatedDashboard(), false).kind)
            .toBe(ASYNC_RESOURCE_STATES.STALE);

        const uncached = populatedDashboard();
        uncached[1] = resolvedQuery(undefined, {
            status: 'pending',
            fetchStatus: 'paused',
            dataUpdatedAt: 0
        });
        expect(resolveTodayDashboardState(uncached, false)).toEqual({
            kind: ASYNC_RESOURCE_STATES.ERROR,
            error: null,
            terminalReason: 'offline'
        });
    });
});
