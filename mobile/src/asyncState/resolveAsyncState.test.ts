/** @file Regression coverage for resolve Async State: resolveAsyncResourceState. */

import { ASYNC_RESOURCE_STATES, resolveAsyncResourceState } from './resolveAsyncState';

const collectionQuery = (
    overrides: Partial<Parameters<typeof resolveAsyncResourceState<string[]>>[0]> = {}
) => ({
    data: undefined,
    status: 'pending' as const,
    fetchStatus: 'fetching' as const,
    error: null,
    dataUpdatedAt: 0,
    ...overrides
});

const resolve = (
    overrides: Partial<Parameters<typeof resolveAsyncResourceState<string[]>>[0]>,
    isOnline = true
) => resolveAsyncResourceState(collectionQuery(overrides), {
    isEmpty: (items) => items.length === 0,
    isOnline
});

describe('resolveAsyncResourceState', () => {
    it('keeps loading, content, and verified empty states mutually exclusive', () => {
        expect(resolve({}).kind).toBe(ASYNC_RESOURCE_STATES.LOADING);
        expect(resolve({ data: [], status: 'pending', dataUpdatedAt: 10 }).kind)
            .toBe(ASYNC_RESOURCE_STATES.LOADING);
        expect(resolve({ data: ['cached'], status: 'pending', dataUpdatedAt: 10 }).kind)
            .toBe(ASYNC_RESOURCE_STATES.CONTENT);
        expect(resolve({ data: ['entry'], status: 'success', fetchStatus: 'idle' }).kind)
            .toBe(ASYNC_RESOURCE_STATES.CONTENT);
        expect(resolve({ data: [], status: 'success', fetchStatus: 'idle' }).kind)
            .toBe(ASYNC_RESOURCE_STATES.EMPTY);
    });

    it('shows a terminal error instead of empty reassurance after an empty refresh fails', () => {
        expect(resolve({
            data: [],
            status: 'error',
            fetchStatus: 'idle',
            error: new Error('provider details'),
            dataUpdatedAt: 10
        }).kind).toBe(ASYNC_RESOURCE_STATES.ERROR);
    });

    it('keeps cached content usable and labeled after a refresh failure', () => {
        expect(resolve({
            data: ['cached'],
            status: 'error',
            fetchStatus: 'idle',
            error: new Error('provider details'),
            dataUpdatedAt: 10
        }).kind).toBe(ASYNC_RESOURCE_STATES.DEGRADED);
    });

    it('labels cached content stale while offline', () => {
        expect(resolve({
            data: ['cached'],
            status: 'success',
            fetchStatus: 'paused',
            dataUpdatedAt: 10
        }, false).kind).toBe(ASYNC_RESOURCE_STATES.STALE);
    });

    it.each([
        ['a paused request', { fetchStatus: 'paused' as const }, true],
        ['an offline pending request', {}, false],
        ['an offline cached empty result', { data: [], status: 'success' as const, fetchStatus: 'idle' as const }, false],
        ['an offline failed request', {
            status: 'error' as const,
            fetchStatus: 'idle' as const,
            error: new Error('network details')
        }, false]
    ])('resolves %s to an explicit offline terminal state', (_label, overrides, isOnline) => {
        expect(resolve(overrides, isOnline)).toEqual({
            kind: ASYNC_RESOURCE_STATES.ERROR,
            error: 'error' in overrides ? overrides.error : null,
            terminalReason: 'offline'
        });
    });
});
