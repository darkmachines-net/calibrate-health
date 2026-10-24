/** @file Regression coverage for provider web: browser offline outbox provider. */

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { ApiError } from '@calibrate/api-client';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOutbox, openIndexedDbOutboxDatabase } from './indexedDbOutbox.web';
import { OfflineOutboxProvider, useOfflineOutbox } from './provider.web';
import { getOutboxRetryDelayMs } from './reconciler';
import { createOutboxNamespace } from './queuedMutation';
import { hasPendingWeightMutation } from './pendingWeight';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

let mockAuthState: { serverUrl: string; user: { id: number; account_access?: { state: string } } | null } = {
    serverUrl: 'https://health.example',
    user: { id: 7 }
};

jest.mock('../auth/AuthContext', () => ({
    useAuth: () => mockAuthState
}));

/** Provide deterministic page visibility transitions to the browser provider. */
function createVisibility(initialVisible: boolean) {
    let visible = initialVisible;
    const listeners = new Set<() => void>();
    return {
        value: {
            isVisible: () => visible,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        },
        show: () => {
            visible = true;
            listeners.forEach((listener) => listener());
        },
        hide: () => {
            visible = false;
            listeners.forEach((listener) => listener());
        }
    };
}
function createConnectivity(initialOnline: boolean) {
    let online = initialOnline;
    const listeners = new Set<() => void>();
    return {
        value: {
            isOnline: () => online,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        },
        goOnline: () => {
            online = true;
            listeners.forEach((listener) => listener());
        }
    };
}

describe('browser offline outbox provider', () => {
    let database: IDBDatabase;
    let openDatabase: jest.Mock<Promise<IDBDatabase>, []>;

    beforeEach(async () => {
        await AsyncStorage.clear();
        mockAuthState = { serverUrl: 'https://health.example', user: { id: 7 } };
        database = await openIndexedDbOutboxDatabase({
            factory: new IDBFactory(),
            databaseName: 'provider-test-outbox'
        });
        openDatabase = jest.fn(async () => database);
    });

    afterEach(() => database.close());

    it('resumes remaining ordered intent immediately after explicit failed-weight discard', async () => {
        const queue = new IndexedDbOutbox(database, createOutboxNamespace('https://health.example', 7));
        await queue.enqueue({ id: 'failed', operation: 'metric.add', payload: { date: '2026-07-21', weight: 88 } });
        await queue.enqueue({ id: 'next-day', operation: 'metric.add', payload: { date: '2026-07-22', weight: 90 } });
        await queue.claimNext(); await queue.fail('failed', 'Rejected');
        const executeMutation = jest.fn(async () => undefined);
        const wrapper = ({ children }: { children: React.ReactNode }) => <OfflineOutboxProvider executeMutation={executeMutation} openDatabase={openDatabase}>{children}</OfflineOutboxProvider>;
        const { result } = renderHook(() => useOfflineOutbox(), { wrapper });
        await waitFor(() => expect(result.current.mutations).toHaveLength(2));
        expect(executeMutation).not.toHaveBeenCalled();
        await act(async () => { await result.current.discardFailedMutation('failed'); });
        expect(executeMutation).toHaveBeenCalledTimes(1);
        expect(executeMutation).toHaveBeenCalledWith(expect.objectContaining({ id: 'next-day' }));
        expect(await queue.list()).toEqual([]);
    });

    it('does not open or replay the browser outbox while account access is restricted', async () => {
        mockAuthState = {
            serverUrl: 'https://health.example',
            user: { id: 7, account_access: { state: 'email_verification_required' } }
        };
        const executeMutation = jest.fn(async () => undefined);
        const connectivity = createConnectivity(true);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={executeMutation}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result } = renderHook(() => useOfflineOutbox(), { wrapper });

        await waitFor(() => expect(result.current.isReady).toBe(false));
        expect(openDatabase).not.toHaveBeenCalled();
        expect(executeMutation).not.toHaveBeenCalled();
    });

    it('isolates account switches immediately and restores each account queue deterministically', async () => {
        const connectivity = createConnectivity(false);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={jest.fn()}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result, rerender } = renderHook(() => useOfflineOutbox(), { wrapper });
        await waitFor(() => expect(result.current.isReady).toBe(true));
        await act(async () => {
            await result.current.enqueue('food.create', { calories: 100 }, 'user-7-operation');
        });
        expect(result.current.mutations).toEqual([
            expect.objectContaining({ id: 'user-7-operation', namespace: createOutboxNamespace('https://health.example', 7) })
        ]);

        mockAuthState = { serverUrl: 'https://health.example', user: { id: 9 } };
        rerender({});
        expect(result.current.isReady).toBe(false);
        await waitFor(() => expect(result.current.isReady).toBe(true));
        expect(result.current.mutations).toEqual([]);
        await act(async () => {
            await result.current.enqueue('metric.add', { date: '2026-07-18', weight: 88 }, 'user-9-operation');
        });

        mockAuthState = { serverUrl: 'https://health.example', user: { id: 7 } };
        rerender({});
        await waitFor(() => expect(result.current.isReady).toBe(true));
        expect(result.current.mutations).toEqual([expect.objectContaining({ id: 'user-7-operation' })]);
        await act(async () => { await result.current.discardAll(); });

        const userNine = new IndexedDbOutbox(database, createOutboxNamespace('https://health.example', 9));
        await expect(userNine.list()).resolves.toEqual([expect.objectContaining({ id: 'user-9-operation' })]);
    });

    it('does not let a late account replay replace the current account queue', async () => {
        const accountA = createOutboxNamespace('https://health.example', 7);
        const accountB = createOutboxNamespace('https://health.example', 9);
        await new IndexedDbOutbox(database, accountA).enqueue({
            id: 'old-account-operation',
            operation: 'food.create',
            payload: { calories: 100 }
        });
        await new IndexedDbOutbox(database, accountB).enqueue({
            id: 'current-account-operation',
            operation: 'metric.add',
            payload: { date: '2026-07-18', weight: 88 }
        });
        let releaseOldNotification!: () => void;
        const oldNotification = new Promise<void>((resolve) => { releaseOldNotification = resolve; });
        const onReplayCompleted = jest.fn(() => oldNotification);
        const connectivity = createConnectivity(false);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={jest.fn(async () => undefined)}
                onReplayCompleted={onReplayCompleted}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result, rerender } = renderHook(() => useOfflineOutbox(), { wrapper });
        await waitFor(() => expect(result.current.mutations).toEqual([
            expect.objectContaining({ id: 'old-account-operation' })
        ]));

        let oldReconciliation!: Promise<unknown>;
        act(() => { oldReconciliation = result.current.reconcile(); });
        await waitFor(() => expect(onReplayCompleted).toHaveBeenCalledTimes(1));

        mockAuthState = { serverUrl: 'https://health.example', user: { id: 9 } };
        rerender({});
        expect(result.current.isReady).toBe(false);
        await waitFor(() => expect(result.current.mutations).toEqual([
            expect.objectContaining({ id: 'current-account-operation' })
        ]));

        releaseOldNotification();
        await act(async () => { await oldReconciliation; });
        expect(result.current.mutations).toEqual([
            expect.objectContaining({ id: 'current-account-operation' })
        ]);
    });

    it('replays pending writes on startup when the browser is online', async () => {
        const namespace = createOutboxNamespace(mockAuthState.serverUrl, mockAuthState.user!.id);
        await new IndexedDbOutbox(database, namespace).enqueue({
            id: 'startup-operation',
            operation: 'food-day.update',
            payload: { date: '2026-07-18', is_complete: true }
        });
        const executeMutation = jest.fn(async () => ({ currentControl: { day: { date: '2026-07-18', status: 'COMPLETE' as const } } }));
        const onReplayCompleted = jest.fn(async () => undefined);
        const connectivity = createConnectivity(true);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={executeMutation}
                onReplayCompleted={onReplayCompleted}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result } = renderHook(() => useOfflineOutbox(), { wrapper });

        await waitFor(() => expect(executeMutation).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'startup-operation', operation: 'food-day.update' })
        ));
        await waitFor(() => expect(result.current.mutations).toEqual([]));
        expect(onReplayCompleted).toHaveBeenCalledWith({
            replayed: 1,
            replayedOperations: ['food-day.update'],
            failedMutation: null,
            deferredMutation: null,
            retryAfterMs: null
        });
    });

    it('preserves durable failed intent across connectivity and visibility until explicit retry', async () => {
        const namespace = createOutboxNamespace(mockAuthState.serverUrl, mockAuthState.user!.id);
        await new IndexedDbOutbox(database, namespace).enqueue({
            id: 'retry-operation',
            operation: 'food.delete',
            payload: { id: 3 }
        });
        let shouldFail = true;
        const executeMutation = jest.fn(async () => {
            if (shouldFail) throw new Error('network unavailable');
        });
        const connectivity = createConnectivity(true);
        const visibility = createVisibility(true);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={executeMutation}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
                visibility={visibility.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result } = renderHook(() => useOfflineOutbox(), { wrapper });
        await waitFor(() => expect(result.current.mutations).toEqual([
            expect.objectContaining({ id: 'retry-operation', state: 'failed', attemptCount: 1 })
        ]));

        shouldFail = false;
        await act(async () => { connectivity.goOnline(); await new Promise(resolve => setTimeout(resolve, 30)); });
        await act(async () => { visibility.hide(); visibility.show(); await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(executeMutation).toHaveBeenCalledTimes(1);
        expect(result.current.mutations).toEqual([expect.objectContaining({ id: 'retry-operation', state: 'failed', attemptCount: 1 })]);
        await act(async () => { await result.current.retryFailed('retry-operation'); });
        await waitFor(() => expect(result.current.mutations).toEqual([]));
        expect(executeMutation).toHaveBeenCalledTimes(2);
    });

    it('uses increasing delays for repeated retryable failures while online and visible', async () => {
        const namespace = createOutboxNamespace(mockAuthState.serverUrl, mockAuthState.user!.id);
        const seededOutbox = new IndexedDbOutbox(database, namespace);
        const mutation = await seededOutbox.enqueue({
            id: 'deferred-online-operation',
            operation: 'food.create',
            payload: { calories: 100 }
        });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await seededOutbox.claimNext();
            await seededOutbox.defer(mutation.id, 'operation is still settling');
        }
        const firstDelay = getOutboxRetryDelayMs(6, mutation.id);
        const secondDelay = getOutboxRetryDelayMs(7, mutation.id);
        expect(firstDelay).toBeGreaterThan(2 * 60_000);
        expect(secondDelay).toBeGreaterThan(firstDelay);

        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        try {
            let failuresRemaining = 2;
            const executeMutation = jest.fn(async () => {
                if (failuresRemaining > 0) {
                    failuresRemaining -= 1;
                    throw new ApiError('operation is still settling', 409, { retryable: true });
                }
            });
            const connectivity = createConnectivity(true);
            const visibility = createVisibility(true);
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <OfflineOutboxProvider
                    executeMutation={executeMutation}
                    openDatabase={openDatabase}
                    connectivity={connectivity.value}
                    visibility={visibility.value}
                >
                    {children}
                </OfflineOutboxProvider>
            );
            const { result, unmount } = renderHook(() => useOfflineOutbox(), { wrapper });

            await waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(result.current.mutations).toEqual([
                expect.objectContaining({ id: mutation.id, state: 'pending', attemptCount: 6 })
            ]));
            await act(async () => {
                jest.advanceTimersByTime(firstDelay);
                await Promise.resolve();
            });
            await waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(2));
            await waitFor(() => expect(result.current.mutations).toEqual([
                expect.objectContaining({ id: mutation.id, state: 'pending', attemptCount: 7 })
            ]));
            await act(async () => {
                jest.advanceTimersByTime(30_000);
                await Promise.resolve();
            });
            expect(executeMutation).toHaveBeenCalledTimes(2);
            await act(async () => {
                jest.advanceTimersByTime(secondDelay - 30_000);
                await Promise.resolve();
            });
            await waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(3));
            await waitFor(() => expect(result.current.mutations).toEqual([]));

            unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('pauses automatic replay while the page is hidden and resumes when visible', async () => {
        const namespace = createOutboxNamespace(mockAuthState.serverUrl, mockAuthState.user!.id);
        await new IndexedDbOutbox(database, namespace).enqueue({
            id: 'hidden-operation',
            operation: 'food.create',
            payload: { calories: 100 }
        });
        const executeMutation = jest.fn(async () => undefined);
        const connectivity = createConnectivity(true);
        const visibility = createVisibility(false);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={executeMutation}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
                visibility={visibility.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        renderHook(() => useOfflineOutbox(), { wrapper });
        await waitFor(() => expect(openDatabase).toHaveBeenCalled());
        expect(executeMutation).not.toHaveBeenCalled();

        act(() => visibility.show());
        await waitFor(() => expect(executeMutation).toHaveBeenCalledTimes(1));
    });
    it('keeps calorie outputs suppressed until a queued weight replay and refetch complete', async () => {
        const connectivity = createConnectivity(false);
        let finishRefetch: (() => void) | undefined;
        const refetchComplete = new Promise<void>((resolve) => { finishRefetch = resolve; });
        const executeMutation = jest.fn(async () => undefined);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={executeMutation}
                onReplayCompleted={() => refetchComplete}
                openDatabase={openDatabase}
                connectivity={connectivity.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result } = renderHook(() => ({
            outbox: useOfflineOutbox(),
            weightPending: hasPendingWeightMutation(useOfflineOutbox().mutations)
        }), { wrapper });
        await waitFor(() => expect(result.current.outbox.isReady).toBe(true));
        await act(async () => {
            await result.current.outbox.enqueue('metric.add', { date: '2026-07-18', weight: 88 });
        });
        expect(result.current.weightPending).toBe(true);

        act(() => connectivity.goOnline());
        await waitFor(() => expect(executeMutation).toHaveBeenCalled());
        expect(result.current.weightPending).toBe(true);

        finishRefetch?.();
        await waitFor(() => expect(result.current.weightPending).toBe(false));
    });

    it('surfaces IndexedDB initialization failures and rejects writes honestly', async () => {
        const connectivity = createConnectivity(false);
        const error = new Error('Browser offline storage is unavailable: site storage is blocked.');
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider
                executeMutation={jest.fn()}
                openDatabase={jest.fn(async () => { throw error; })}
                connectivity={connectivity.value}
            >
                {children}
            </OfflineOutboxProvider>
        );
        const { result } = renderHook(() => useOfflineOutbox(), { wrapper });

        await waitFor(() => expect(result.current.initializationError).toBe(error.message));
        expect(result.current.isReady).toBe(false);
        await expect(result.current.enqueue('food.create', { calories: 100 }))
            .rejects.toThrow(error.message);
    });
});
