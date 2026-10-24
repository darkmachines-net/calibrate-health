/** @file Regression coverage for use Food Delete Recovery: useFoodDeleteRecovery. */

import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { FoodLogEntry } from '@calibrate/api-client';
import { useFoodDeleteRecovery } from './useFoodDeleteRecovery';
import { OUTBOX_MUTATION_STATES, type QueuedMutation } from '../offline/queuedMutation';

let mockFocusCleanup: (() => void) | undefined;

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));
jest.mock('expo-router', () => {
    const React = jest.requireActual('react') as typeof import('react');
    return {
        useFocusEffect: (callback: () => (() => void) | undefined) => React.useEffect(() => {
            const cleanup = callback();
            mockFocusCleanup = cleanup;
            return () => {
                if (mockFocusCleanup === cleanup) mockFocusCleanup = undefined;
                cleanup?.();
            };
        }, [callback])
    };
});

const entry = (id: number): FoodLogEntry => ({
    id,
    meal_period: 'BREAKFAST',
    name: `Food ${id}`,
    calories: 100
});

async function drainPromises(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('useFoodDeleteRecovery', () => {
    let appStateListener: ((state: string) => void) | null;
    const removeAppStateListener = jest.fn();

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        appStateListener = null;
        mockFocusCleanup = undefined;
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
            appStateListener = listener as (state: string) => void;
            return { remove: removeAppStateListener } as ReturnType<typeof AppState.addEventListener>;
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function setup(deleteFoodLog = jest.fn(async () => undefined)) {
        const enqueue = jest.fn(async () => undefined);
        const retryFailed = jest.fn(async () => undefined);
        const onCommitted = jest.fn(async () => undefined);
        const ids = ['delete-1', 'delete-2', 'delete-3'];
        const entries = [entry(1), entry(2), entry(3)];
        const rendered = renderHook(() => useFoodDeleteRecovery({
            entries,
            deleteFoodLog,
            outbox: { enqueue, mutations: [], retryFailed },
            onCommitted,
            createOperationId: () => ids.shift() ?? 'unexpected'
        }));
        return { ...rendered, deleteFoodLog, enqueue, onCommitted, retryFailed };
    }

    it('optimistically hides and Undo cancels timer, server, and outbox work', async () => {
        const harness = setup();

        act(() => { harness.result.current.requestDelete(entry(1)); });
        expect(harness.result.current.visibleEntries.map(({ id }) => id)).toEqual([2, 3]);
        expect(harness.result.current.pendingDelete?.operationId).toBe('delete-1');
        act(() => { harness.result.current.undo('delete-1'); });
        expect(harness.result.current.visibleEntries.map(({ id }) => id)).toEqual([1, 2, 3]);

        await act(async () => {
            jest.advanceTimersByTime(10_000);
            await drainPromises();
        });
        expect(harness.deleteFoodLog).not.toHaveBeenCalled();
        expect(harness.enqueue).not.toHaveBeenCalled();
    });

    it('flushes pending deletes on app background and route exit', async () => {
        const harness = setup();

        act(() => { harness.result.current.requestDelete(entry(1)); });
        await act(async () => {
            appStateListener?.('background');
            await drainPromises();
        });
        expect(harness.deleteFoodLog).toHaveBeenNthCalledWith(1, 1, 'delete-1');

        act(() => { harness.result.current.requestDelete(entry(2)); });
        await act(async () => {
            mockFocusCleanup?.();
            await drainPromises();
        });
        expect(harness.deleteFoodLog).toHaveBeenNthCalledWith(2, 2, 'delete-2');
    });

    it('queues offline deletes exactly once and in request order with their stable IDs', async () => {
        const deleteFoodLog = jest.fn(async () => { throw new TypeError('Network request failed'); });
        const harness = setup(deleteFoodLog);

        act(() => {
            harness.result.current.requestDelete(entry(1));
            harness.result.current.requestDelete(entry(2));
        });
        await act(async () => {
            jest.advanceTimersByTime(6_000);
            await drainPromises();
        });

        expect(deleteFoodLog.mock.calls).toEqual([
            [1, 'delete-1'],
            [2, 'delete-2']
        ]);
        expect(harness.enqueue.mock.calls).toEqual([
            ['food.delete', { id: 1 }, 'delete-1'],
            ['food.delete', { id: 2 }, 'delete-2']
        ]);
        expect(harness.onCommitted).toHaveBeenCalledTimes(2);
        expect(harness.result.current.visibleEntries.map(({ id }) => id)).toEqual([3]);
    });

    it('restores a direct failure and exposes Retry scoped to the stable operation ID', async () => {
        const deleteFoodLog = jest.fn()
            .mockRejectedValueOnce(new Error('private server detail'))
            .mockResolvedValueOnce(undefined);
        const harness = setup(deleteFoodLog);

        act(() => { harness.result.current.requestDelete(entry(3)); });
        await act(async () => {
            jest.advanceTimersByTime(6_000);
            await drainPromises();
        });

        expect(harness.result.current.visibleEntries.map(({ id }) => id)).toEqual([1, 2, 3]);
        expect(harness.result.current.failure).toEqual({
            entry: entry(3),
            operationId: 'delete-1',
            message: 'Unable to delete this food entry.',
            source: 'direct'
        });

        await act(async () => { await harness.result.current.retry('delete-1'); });
        expect(deleteFoodLog.mock.calls).toEqual([
            [3, 'delete-1'],
            [3, 'delete-1']
        ]);
        expect(harness.result.current.failure).toBeNull();
        expect(harness.result.current.visibleEntries.map(({ id }) => id)).toEqual([1, 2]);
        expect(harness.retryFailed).not.toHaveBeenCalled();
    });

    it('restores a failed outbox delete and retries only its durable operation', async () => {
        const retryFailed = jest.fn(async () => undefined);
        const failedMutation: QueuedMutation = {
            sequence: 1,
            id: 'durable-delete-id',
            namespace: 'test::user:1',
            operation: 'food.delete',
            payload: { id: 2 },
            state: OUTBOX_MUTATION_STATES.FAILED,
            attemptCount: 1,
            lastError: 'private replay failure',
            createdAt: 1,
            updatedAt: 2
        };
        const rendered = renderHook(() => useFoodDeleteRecovery({
            entries: [entry(1), entry(2)],
            deleteFoodLog: jest.fn(async () => undefined),
            outbox: {
                enqueue: jest.fn(async () => undefined),
                mutations: [failedMutation],
                retryFailed
            }
        }));

        expect(rendered.result.current.visibleEntries.map(({ id }) => id)).toEqual([1, 2]);
        expect(rendered.result.current.failure).toEqual({
            entry: entry(2),
            operationId: 'durable-delete-id',
            message: 'Unable to delete this food entry.',
            source: 'outbox'
        });
        expect(rendered.result.current.failure?.message).not.toContain('replay failure');

        await act(async () => { await rendered.result.current.retry(); });
        expect(retryFailed).toHaveBeenCalledWith('durable-delete-id');
    });
});
