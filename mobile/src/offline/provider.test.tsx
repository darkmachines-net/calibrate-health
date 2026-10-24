/** @file Regression coverage for provider: native offline outbox provider recovery. */

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { onlineManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { OfflineOutboxProvider, useOfflineOutbox } from './provider';
import { openOutboxDatabase } from './database';
import type { ReconcileResult } from './reconciler';
import type { QueuedMutation } from './queuedMutation';

const mockOutbox = {
    discardFailedMutation: jest.fn(async (_id: string) => undefined),
    recoverInterrupted: jest.fn(async () => undefined),
    list: jest.fn(async (): Promise<QueuedMutation[]> => []),
    clear: jest.fn(async () => undefined)
};
const mockOutboxesByNamespace = new Map<string, typeof mockOutbox>();
const successfulEmptyReplay: ReconcileResult = {
    replayed: 0,
    replayedOperations: [],
    failedMutation: null,
    deferredMutation: null,
    retryAfterMs: null
};
const successfulMetricReplay: ReconcileResult = {
    replayed: 1,
    replayedOperations: ['metric.add'],
    failedMutation: null,
    deferredMutation: null,
    retryAfterMs: null
};
const mockReconcile = jest.fn(async () => successfulEmptyReplay);
const mockRetryFailed = jest.fn(async () => successfulMetricReplay);

let mockAuthState = { serverUrl: 'https://health.example', user: { id: 7 } };

jest.mock('../auth/AuthContext', () => ({
    useAuth: () => mockAuthState
}));
jest.mock('./database', () => ({ openOutboxDatabase: jest.fn(async () => ({})) }));
jest.mock('./outbox', () => ({
    SqliteOutbox: jest.fn((_database, namespace: string) => mockOutboxesByNamespace.get(namespace) ?? mockOutbox)
}));
jest.mock('./reconciler', () => ({
    OutboxReconciler: jest.fn(() => ({
        reconcile: mockReconcile,
        retryFailed: mockRetryFailed
    }))
}));
jest.mock('../wear/syncInvalidation', () => ({ queueWearSyncInvalidation: jest.fn() }));

describe('native offline outbox provider recovery', () => {
    it('reconciles remaining work after successful scoped discard', async () => {
        const wrapper = ({ children }: { children: React.ReactNode }) => <OfflineOutboxProvider executeMutation={async () => undefined}>{children}</OfflineOutboxProvider>;
        const { result } = await renderHook(() => useOfflineOutbox(), { wrapper });
        await waitFor(() => expect(result.current.isReady).toBe(true));
        mockReconcile.mockClear();
        await act(async () => { await result.current.discardFailedMutation('failed'); });
        expect(mockOutbox.discardFailedMutation).toHaveBeenCalledWith('failed');
        expect(mockReconcile).toHaveBeenCalledTimes(1);
    });
    beforeEach(async () => {
        await AsyncStorage.clear();
        jest.clearAllMocks();
        mockOutboxesByNamespace.clear();
        mockOutbox.list.mockReset().mockResolvedValue([]);
        mockAuthState = { serverUrl: 'https://health.example', user: { id: 7 } };
        onlineManager.setOnline(true);
        mockReconcile.mockReset().mockResolvedValue(successfulEmptyReplay);
        mockRetryFailed.mockReset().mockResolvedValue(successfulMetricReplay);
    });

    afterEach(() => {
        onlineManager.setOnline(true);
        jest.restoreAllMocks();
    });

    it('preserves failed barriers through foreground recovery until explicit retry', async () => {
        let appStateListener: ((state: string) => void) | null = null;
        const remove = jest.fn();
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
            appStateListener = listener as (state: string) => void;
            return { remove } as ReturnType<typeof AppState.addEventListener>;
        });
        const onReplayCompleted = jest.fn(async () => undefined);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <OfflineOutboxProvider executeMutation={jest.fn()} onReplayCompleted={onReplayCompleted}>
                {children}
            </OfflineOutboxProvider>
        );
        const { result, unmount } = await renderHook(() => useOfflineOutbox(), { wrapper });

        await waitFor(() => expect(openOutboxDatabase).toHaveBeenCalled());
        await waitFor(() => expect(mockOutbox.list).toHaveBeenCalled());
        expect(result.current.initializationError).toBeNull();
        expect(result.current.isReady).toBe(true);
        await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(1));
        expect(mockRetryFailed).not.toHaveBeenCalled();

        await act(() => appStateListener?.('background'));
        expect(mockRetryFailed).not.toHaveBeenCalled();
        await act(() => appStateListener?.('active'));
        await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(2));
        expect(mockRetryFailed).not.toHaveBeenCalled();
        await act(async () => { await result.current.retryFailed('chosen-failure'); });
        expect(mockRetryFailed).toHaveBeenCalledWith('chosen-failure');
        await waitFor(() => expect(onReplayCompleted).toHaveBeenCalledWith({
            replayed: 1,
            replayedOperations: ['metric.add'],
            failedMutation: null,
            deferredMutation: null,
            retryAfterMs: null
        }));

        await unmount();
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('uses increasing delays for repeated retryable failures while foregrounded and online', async () => {
        jest.useFakeTimers();
        try {
            const remove = jest.fn();
            jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove } as ReturnType<typeof AppState.addEventListener>);
            const deferredMutation = {
                id: 'deferred-operation',
                namespace: 'test::user:7',
                sequence: 1,
                operation: 'food.create',
                payload: {},
                state: 'pending' as const,
                attemptCount: 6,
                lastError: 'operation is still settling',
                createdAt: 1,
                updatedAt: 1
            };
            mockReconcile
                .mockResolvedValueOnce({
                    replayed: 0,
                    replayedOperations: [],
                    failedMutation: null,
                    deferredMutation,
                    retryAfterMs: 150_000
                })
                .mockResolvedValueOnce({
                    replayed: 0,
                    replayedOperations: [],
                    failedMutation: null,
                    deferredMutation: { ...deferredMutation, attemptCount: 7 },
                    retryAfterMs: 300_000
                })
                .mockResolvedValueOnce(successfulEmptyReplay);
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <OfflineOutboxProvider executeMutation={jest.fn()}>{children}</OfflineOutboxProvider>
            );
            const { unmount } = await renderHook(() => useOfflineOutbox(), { wrapper });

            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(1));
            await act(async () => {
                jest.advanceTimersByTime(150_000);
                await Promise.resolve();
            });
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(2));
            await act(async () => {
                jest.advanceTimersByTime(30_000);
                await Promise.resolve();
            });
            expect(mockReconcile).toHaveBeenCalledTimes(2);
            await act(async () => {
                jest.advanceTimersByTime(270_000);
                await Promise.resolve();
            });
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(3));

            await unmount();
            jest.runOnlyPendingTimers();
            expect(mockReconcile).toHaveBeenCalledTimes(3);
            expect(remove).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('pauses a deferred timer while native connectivity is offline and resumes on recovery', async () => {
        jest.useFakeTimers();
        try {
            jest.spyOn(AppState, 'addEventListener').mockReturnValue({
                remove: jest.fn()
            } as ReturnType<typeof AppState.addEventListener>);
            mockReconcile.mockResolvedValueOnce({
                replayed: 0,
                replayedOperations: [],
                failedMutation: null,
                deferredMutation: {
                    id: 'offline-operation',
                    namespace: 'test::user:7',
                    sequence: 1,
                    operation: 'food.create',
                    payload: {},
                    state: 'pending',
                    attemptCount: 6,
                    lastError: 'operation is still settling',
                    createdAt: 1,
                    updatedAt: 1
                },
                retryAfterMs: 150_000
            });
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <OfflineOutboxProvider executeMutation={jest.fn()}>{children}</OfflineOutboxProvider>
            );
            await renderHook(() => useOfflineOutbox(), { wrapper });
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(1));

            await act(() => onlineManager.setOnline(false));
            await act(async () => {
                jest.advanceTimersByTime(150_000);
                await Promise.resolve();
            });
            expect(mockReconcile).toHaveBeenCalledTimes(1);
            expect(mockRetryFailed).not.toHaveBeenCalled();

            await act(() => onlineManager.setOnline(true));
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(2));
            expect(mockRetryFailed).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
    it('does not let an old account completion cancel its retry or replace the current account queue', async () => {
        jest.useFakeTimers();
        try {
            jest.spyOn(AppState, 'addEventListener').mockReturnValue({
                remove: jest.fn()
            } as ReturnType<typeof AppState.addEventListener>);
            let releaseOldNotification!: () => void;
            const oldNotification = new Promise<void>((resolve) => { releaseOldNotification = resolve; });
            const onReplayCompleted = jest.fn(() => oldNotification);
            const executeMutation = jest.fn();
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <OfflineOutboxProvider executeMutation={executeMutation} onReplayCompleted={onReplayCompleted}>
                    {children}
                </OfflineOutboxProvider>
            );
            const { result, rerender, unmount } = await renderHook(() => useOfflineOutbox(), { wrapper });
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(1));

            mockReconcile.mockResolvedValueOnce(successfulMetricReplay);
            let oldReconciliation!: Promise<ReconcileResult>;
            await act(() => { oldReconciliation = result.current.reconcile(); });
            await waitFor(() => expect(onReplayCompleted).toHaveBeenCalledTimes(1));

            const currentDeferred = {
                id: 'current-account-operation',
                namespace: 'https://health.example::user:9',
                sequence: 1,
                operation: 'food.create',
                payload: {},
                state: 'pending' as const,
                attemptCount: 6,
                lastError: 'operation is still settling',
                createdAt: 1,
                updatedAt: 1
            };
            const currentOutbox = {
                recoverInterrupted: jest.fn(async () => undefined),
                list: jest.fn(async () => [currentDeferred]),
                discardFailedMutation: jest.fn(async (_id: string) => undefined),
                clear: jest.fn(async () => undefined)
            };
            mockOutboxesByNamespace.set('https://health.example::user:9', currentOutbox);
            mockReconcile
                .mockResolvedValueOnce({
                    replayed: 0,
                    replayedOperations: [],
                    failedMutation: null,
                    deferredMutation: currentDeferred,
                    retryAfterMs: 150_000
                })
                .mockResolvedValueOnce(successfulEmptyReplay);
            mockAuthState = { serverUrl: 'https://health.example', user: { id: 9 } };
            await rerender({});
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(3));
            await waitFor(() => expect(result.current.mutations).toEqual([
                expect.objectContaining({ id: 'current-account-operation' })
            ]));
            const oldAccountListCalls = mockOutbox.list.mock.calls.length;

            releaseOldNotification();
            await act(async () => { await oldReconciliation; });
            expect(mockOutbox.list).toHaveBeenCalledTimes(oldAccountListCalls);
            expect(result.current.mutations).toEqual([
                expect.objectContaining({ id: 'current-account-operation' })
            ]);
            await act(async () => {
                jest.advanceTimersByTime(150_000);
                await Promise.resolve();
            });
            await waitFor(() => expect(mockReconcile).toHaveBeenCalledTimes(4));
            await unmount();
        } finally {
            jest.useRealTimers();
        }
    });
});
