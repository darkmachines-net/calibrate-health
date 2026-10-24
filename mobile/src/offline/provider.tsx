/** @file provider: Binds SQLite queue access to the currently authenticated server and user. */

import type { FoodLogDay, FoodLogDayRange, FoodTrackingPause } from '@calibrate/api-client';
import { readFoodDayReceipts, readAndRecordFoodDay, readAndRecordFoodDays, readAndRecordFoodPause } from './foodDayReceipts';
import { createOutboxDispatch, type OutboxDispatch } from './mutationDispatch';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { hasFullAccountAccess } from '../auth/accountAccess';
import { openOutboxDatabase } from './database';
import { SqliteOutbox } from './outbox';
import { OutboxReconciler, type QueuedMutationExecutor, type ReconcileResult } from './reconciler';
import { createOutboxNamespace, type QueuedMutation } from './queuedMutation';
import { queueWearSyncInvalidation } from '../wear/syncInvalidation';

type OfflineOutboxContextValue = {
    isReady: boolean;
    withOutbox: OutboxDispatch;
    dayIntents: QueuedMutation[];
    readFoodPause: (fetch: () => Promise<{ pause: FoodTrackingPause }>) => Promise<{ pause: FoodTrackingPause }>;
    readFoodDays: (fetch: () => Promise<FoodLogDayRange>) => Promise<FoodLogDayRange>;
    readFoodDay: (date: string, fetch: () => Promise<FoodLogDay>) => Promise<FoodLogDay>;
    initializationError: string | null;
    mutations: QueuedMutation[];
    enqueue: (operation: string, payload: unknown, operationId?: string) => Promise<QueuedMutation>;
    reconcile: () => Promise<ReconcileResult>;
    retryFailed: (id?: string) => Promise<ReconcileResult>;
    discardAll: () => Promise<void>;
    discardFailedFood: (id: string) => Promise<void>;
    discardFailedMutation: (id: string) => Promise<void>;
    refresh: () => Promise<void>;
};

type OfflineOutboxProviderProps = {
    children: React.ReactNode;
    executeMutation: QueuedMutationExecutor;
    onReplayCompleted?: (result: ReconcileResult) => void | Promise<void>;
};

const OfflineOutboxContext = createContext<OfflineOutboxContextValue | null>(null);

/** Binds SQLite queue access to the currently authenticated server and user. */
export function OfflineOutboxProvider({ children, executeMutation, onReplayCompleted }: OfflineOutboxProviderProps) {
    const { serverUrl, user } = useAuth();
    const userId = hasFullAccountAccess(user) ? user?.id : undefined;
    const namespace = userId === undefined ? null : createOutboxNamespace(serverUrl, userId);
    const [outboxBinding, setOutboxBinding] = useState<{ namespace: string; store: SqliteOutbox } | null>(null);
    // Concurrent rendering can observe the new account before the old store's effect is cleaned up.
    const outbox = outboxBinding?.namespace === namespace ? outboxBinding.store : null;
    const [dayIntents, setDayIntents] = useState<QueuedMutation[]>([]);
    const [mutations, setMutations] = useState<QueuedMutation[]>([]);
    const [newEnqueue, setNewEnqueue] = useState<{ store: SqliteOutbox } | null>(null);
    const [initializationError, setInitializationError] = useState<string | null>(null);
    const retrySchedulerRef = useRef<(result: ReconcileResult) => void>(() => undefined);
    const currentBindingRef = useRef({ serverUrl, userId, outbox });
    currentBindingRef.current = { serverUrl, userId, outbox };

    useEffect(() => {
        let active = true;
        setOutboxBinding(null);
        setMutations([]);
        setDayIntents([]);
        setInitializationError(null);
        if (userId === undefined) return () => { active = false; };

        const namespace = createOutboxNamespace(serverUrl, userId);
        void openOutboxDatabase().then(async (database) => {
            const nextOutbox = new SqliteOutbox(database, namespace);
            const receipts = await readFoodDayReceipts(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId));
            const nextMutations = await nextOutbox.list();
            if (active) {
                setOutboxBinding({ namespace, store: nextOutbox });
                setMutations(nextMutations);
                setDayIntents(receipts);
            }
        }).catch((error: unknown) => {
            if (active) {
                setInitializationError(error instanceof Error ? error.message : 'Unable to open the offline outbox.');
            }
        });

        return () => { active = false; };
    }, [serverUrl, userId]);

    const reconciler = useMemo(
        () => outbox ? new OutboxReconciler(outbox, executeMutation, userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId)) : null,
        [executeMutation, outbox, serverUrl, userId]
    );

    const requireOutbox = useCallback(() => {
        if (!outbox) throw new Error('Offline outbox is unavailable until authentication is ready.');
        return outbox;
    }, [outbox]);

    const refresh = useCallback(async () => {
        const sourceOutbox = requireOutbox();
        /** Match a delayed queue read to the account and server binding that started it. */
        const isCurrentBinding = () => {
            const current = currentBindingRef.current;
            return current.serverUrl === serverUrl && current.userId === userId && current.outbox === sourceOutbox;
        };
        if (!isCurrentBinding()) return;
        const nextMutations = await sourceOutbox.list();
        const receipts = await readFoodDayReceipts(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId));
        if (isCurrentBinding()) { setMutations(nextMutations); setDayIntents(receipts); }
    }, [requireOutbox, serverUrl, userId]);

    const notifyWearAfterReplay = useCallback((result: ReconcileResult) => {
        if (result.replayed > 0 && userId !== undefined) {
            void queueWearSyncInvalidation({ serverOrigin: serverUrl, userId });
        }
    }, [serverUrl, userId]);

    const notifyAfterReplay = useCallback(async (result: ReconcileResult) => {
        notifyWearAfterReplay(result);
        if (result.replayed === 0 || !onReplayCompleted) return;
        await onReplayCompleted(result);
    }, [notifyWearAfterReplay, onReplayCompleted]);

    const enqueueUnlocked = useCallback(async (operation: string, payload: unknown, operationId?: string) => {
        const store = requireOutbox();
        const mutation = await store.enqueue({ id: operationId, operation, payload });
        await refresh();
        setNewEnqueue({ store });
        return mutation;
    }, [refresh, requireOutbox]);

    const withOutbox = useMemo(() => createOutboxDispatch(
        userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId), () => requireOutbox().list(), enqueueUnlocked,
        () => currentBindingRef.current.serverUrl === serverUrl && currentBindingRef.current.userId === userId && currentBindingRef.current.outbox === outbox, true, setDayIntents
    ), [serverUrl, userId, outbox, requireOutbox, enqueueUnlocked]);
    const readFoodDay = useCallback(async (date: string, fetch: () => Promise<FoodLogDay>) => {
        const result = await readAndRecordFoodDay(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId), date, fetch);
        const receipts = await readFoodDayReceipts(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId));
        if (currentBindingRef.current.serverUrl === serverUrl && currentBindingRef.current.userId === userId) setDayIntents(receipts);
        return result;
    }, [serverUrl, userId]);
    const readFoodDays = useCallback(async (fetch: () => Promise<FoodLogDayRange>) => {
        const result = await readAndRecordFoodDays(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId), fetch);
        const receipts = await readFoodDayReceipts(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId));
        if (currentBindingRef.current.serverUrl === serverUrl && currentBindingRef.current.userId === userId) setDayIntents(receipts);
        return result;
    }, [serverUrl, userId]);
    const readFoodPause = useCallback(async (fetch: () => Promise<{ pause: FoodTrackingPause }>) => {
        const result = await readAndRecordFoodPause(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId), fetch);
        const receipts = await readFoodDayReceipts(userId === undefined ? 'unavailable' : createOutboxNamespace(serverUrl, userId));
        if (currentBindingRef.current.serverUrl === serverUrl && currentBindingRef.current.userId === userId) setDayIntents(receipts);
        return result;
    }, [serverUrl, userId]);
    const enqueue = useCallback((operation: string, payload: unknown, operationId?: string) =>
        withOutbox(write => write(operation, payload, operationId)) as Promise<QueuedMutation>, [withOutbox]);

    const reconcile = useCallback(async () => {
        if (!reconciler) throw new Error('Offline outbox is unavailable until authentication is ready.');
        const scheduleRetry = retrySchedulerRef.current;
        const result = await reconciler.reconcile();
        scheduleRetry(result);
        await notifyAfterReplay(result);
        await refresh();
        return result;
    }, [notifyAfterReplay, reconciler, refresh]);

    const retryFailed = useCallback(async (id?: string) => {
        if (!reconciler) throw new Error('Offline outbox is unavailable until authentication is ready.');
        const scheduleRetry = retrySchedulerRef.current;
        const result = await reconciler.retryFailed(id);
        scheduleRetry(result);
        await notifyAfterReplay(result);
        await refresh();
        return result;
    }, [notifyAfterReplay, reconciler, refresh]);

    const discardFailedMutation = useCallback(async (id: string) => {
        await requireOutbox().discardFailedMutation(id);
        await refresh();
        // Removing a failed barrier should resume remaining intent without waiting for another lifecycle event.
        await reconcile().catch(() => undefined);
    }, [reconcile, refresh, requireOutbox]);

    const discardFailedFood = discardFailedMutation;

    const discardAll = useCallback(async () => {
        await requireOutbox().clear();
        setMutations([]);
    }, [requireOutbox]);

    useEffect(() => {
        if (!reconciler) return;
        let active = true;
        let isForegrounded = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
        let isOnline = onlineManager.isOnline();
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        /** Cancel the single provider-owned deferred replay timer. */
        const clearRetry = () => {
            if (retryTimer !== null) clearTimeout(retryTimer);
            retryTimer = null;
        };
        /** Schedule one eligible retry using the reconciler's bounded backoff. */
        const scheduleRetry = (result: ReconcileResult) => {
            clearRetry();
            if (!active || !isForegrounded || !isOnline || result.retryAfterMs === null) return;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (active && isForegrounded && isOnline) void replayPending();
            }, result.retryAfterMs);
        };
        /** Reconcile this provider generation and apply retry timing before post-replay work. */
        const replayPending = async () => {
            try {
                const result = await reconciler.reconcile();
                // Apply retry state before any slower invalidation or queue refresh can reorder completions.
                scheduleRetry(result);
                await notifyAfterReplay(result);
                if (active) await refresh();
            } catch {
                if (active) await refresh().catch(() => undefined);
            }
        };
        retrySchedulerRef.current = scheduleRetry;

        // Replay on startup, after backoff, and after foreground or connectivity recovery.
        if (isForegrounded && isOnline) void replayPending();
        const appStateSubscription = AppState.addEventListener('change', (state) => {
            isForegrounded = state === 'active';
            if (!isForegrounded) {
                clearRetry();
                return;
            }
            if (isOnline) void replayPending();
        });
        const unsubscribeOnline = onlineManager.subscribe(() => {
            isOnline = onlineManager.isOnline();
            if (!isOnline) {
                clearRetry();
                return;
            }
            if (isForegrounded) void replayPending();
        });
        return () => {
            active = false;
            clearRetry();
            if (retrySchedulerRef.current === scheduleRetry) {
                retrySchedulerRef.current = () => undefined;
            }
            appStateSubscription.remove();
            unsubscribeOnline();
        };
    }, [notifyAfterReplay, reconciler, refresh]);
    useEffect(() => {
        if (!newEnqueue || newEnqueue.store !== outbox || !onlineManager.isOnline() || AppState.currentState === 'background') return;
        void reconcile().catch(() => undefined);
    }, [newEnqueue, outbox, reconcile]);
    const value = useMemo<OfflineOutboxContextValue>(() => ({
        isReady: outbox !== null,
        initializationError,
        mutations,
        enqueue,
        withOutbox,
        dayIntents,
        readFoodDay,
        readFoodDays,
        readFoodPause,
        reconcile,
        retryFailed,
        discardAll,
        discardFailedFood,
        discardFailedMutation,
        refresh
    }), [dayIntents, readFoodPause, readFoodDays, readFoodDay, withOutbox, discardFailedMutation, discardFailedFood, discardAll, enqueue, initializationError, mutations, outbox, reconcile, refresh, retryFailed]);

    return <OfflineOutboxContext.Provider value={value}>{children}</OfflineOutboxContext.Provider>;
}

/** Reads the native outbox context and throws outside its provider. */
export function useOfflineOutbox(): OfflineOutboxContextValue {
    const context = useContext(OfflineOutboxContext);
    if (!context) throw new Error('useOfflineOutbox must be used within OfflineOutboxProvider.');
    return context;
}
