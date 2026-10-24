/** @file provider: Binds a durable IndexedDB queue to the current browser server and authenticated user. */

import type { FoodLogDay, FoodLogDayRange, FoodTrackingPause } from '@calibrate/api-client';
import { readFoodDayReceipts, readAndRecordFoodDay, readAndRecordFoodDays, readAndRecordFoodPause } from './foodDayReceipts';
import { createOutboxDispatch, type OutboxDispatch } from './mutationDispatch';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { hasFullAccountAccess } from '../auth/accountAccess';
import { IndexedDbOutbox, openBrowserOutboxDatabase } from './indexedDbOutbox.web';
import { OutboxReconciler, type QueuedMutationExecutor, type ReconcileResult } from './reconciler';
import { createOutboxNamespace, type QueuedMutation } from './queuedMutation';

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

type BrowserConnectivity = {
    isOnline: () => boolean;
    subscribe: (listener: () => void) => () => void;
};

type BrowserVisibility = {
    isVisible: () => boolean;
    subscribe: (listener: () => void) => () => void;
};

type OfflineOutboxProviderProps = {
    children: React.ReactNode;
    executeMutation: QueuedMutationExecutor;
    onReplayCompleted?: (result: ReconcileResult) => void | Promise<void>;
    openDatabase?: () => Promise<IDBDatabase>;
    connectivity?: BrowserConnectivity;
    visibility?: BrowserVisibility;
};

const OfflineOutboxContext = createContext<OfflineOutboxContextValue | null>(null);

const DEFAULT_BROWSER_CONNECTIVITY: BrowserConnectivity = {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
    subscribe: (listener) => {
        if (typeof window === 'undefined') return () => undefined;
        window.addEventListener('online', listener);
        window.addEventListener('offline', listener);
        return () => {
            window.removeEventListener('online', listener);
            window.removeEventListener('offline', listener);
        };
    }
};

const DEFAULT_BROWSER_VISIBILITY: BrowserVisibility = {
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    subscribe: (listener) => {
        if (typeof document === 'undefined') return () => undefined;
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
    }
};

function getNamespace(serverUrl: string, userId: number | undefined): { value: string | null; error: string | null } {
    if (userId === undefined) return { value: null, error: null };
    try {
        return { value: createOutboxNamespace(serverUrl, userId), error: null };
    } catch (error) {
        return {
            value: null,
            error: error instanceof Error ? error.message : 'Unable to create the browser offline namespace.'
        };
    }
}

/** Binds a durable IndexedDB queue to the current browser server and authenticated user. */
export function OfflineOutboxProvider({
    children,
    executeMutation,
    onReplayCompleted,
    openDatabase = openBrowserOutboxDatabase,
    connectivity = DEFAULT_BROWSER_CONNECTIVITY,
    visibility = DEFAULT_BROWSER_VISIBILITY
}: OfflineOutboxProviderProps) {
    const { serverUrl, user } = useAuth();
    const userId = hasFullAccountAccess(user) ? user?.id : undefined;
    const namespace = useMemo(() => getNamespace(serverUrl, userId), [serverUrl, userId]);
    const [binding, setBinding] = useState<{ namespace: string; outbox: IndexedDbOutbox } | null>(null);
    const [dayIntents, setDayIntents] = useState<QueuedMutation[]>([]);
    const [mutations, setMutations] = useState<QueuedMutation[]>([]);
    const [newEnqueue, setNewEnqueue] = useState<{ store: IndexedDbOutbox } | null>(null);
    const [initializationError, setInitializationError] = useState<string | null>(null);
    const retrySchedulerRef = useRef<(result: ReconcileResult) => void>(() => undefined);
    const outbox = binding?.namespace === namespace.value ? binding.outbox : null;
    const currentBindingRef = useRef({ namespace: namespace.value, outbox });
    currentBindingRef.current = { namespace: namespace.value, outbox };

    useEffect(() => {
        let active = true;
        setBinding(null);
        setMutations([]);
        setDayIntents([]);
        setInitializationError(namespace.error);
        if (!namespace.value) return () => { active = false; };

        void openDatabase().then(async (database) => {
            const nextOutbox = new IndexedDbOutbox(database, namespace.value!);
            const receipts = await readFoodDayReceipts(namespace.value ?? 'unavailable');
            const nextMutations = await nextOutbox.list();
            if (active) {
                setBinding({ namespace: namespace.value!, outbox: nextOutbox });
                setMutations(nextMutations);
                setDayIntents(receipts);
            }
        }).catch((error: unknown) => {
            if (active) {
                setInitializationError(
                    error instanceof Error ? error.message : 'Browser offline storage could not be opened.'
                );
            }
        });

        return () => { active = false; };
    }, [namespace.error, namespace.value, openDatabase]);

    const reconciler = useMemo(
        () => outbox ? new OutboxReconciler(outbox, executeMutation, namespace.value ?? 'unavailable') : null,
        [executeMutation, outbox, namespace.value]
    );

    const requireOutbox = useCallback(() => {
        if (outbox) return outbox;
        if (initializationError) throw new Error(initializationError);
        throw new Error('Browser offline storage is unavailable until authentication is ready.');
    }, [initializationError, outbox]);

    const refresh = useCallback(async () => {
        const sourceOutbox = requireOutbox();
        const sourceNamespace = namespace.value;
        /** Match a delayed queue read to the browser namespace binding that started it. */
        const isCurrentBinding = () => {
            const current = currentBindingRef.current;
            return current.namespace === sourceNamespace && current.outbox === sourceOutbox;
        };
        if (!isCurrentBinding()) return;
        const nextMutations = await sourceOutbox.list();
        const receipts = await readFoodDayReceipts(namespace.value ?? 'unavailable');
        if (isCurrentBinding()) { setMutations(nextMutations); setDayIntents(receipts); }
    }, [namespace.value, requireOutbox]);

    const notifyAfterReplay = useCallback(async (result: ReconcileResult) => {
        if (result.replayed === 0 || !onReplayCompleted) return;
        await onReplayCompleted(result);
    }, [onReplayCompleted]);

    const enqueueUnlocked = useCallback(async (operation: string, payload: unknown, operationId?: string) => {
        const store = requireOutbox();
        const mutation = await store.enqueue({ id: operationId, operation, payload });
        await refresh();
        setNewEnqueue({ store });
        return mutation;
    }, [refresh, requireOutbox]);

    const withOutbox = useMemo(() => createOutboxDispatch(
        namespace.value ?? 'unavailable', () => requireOutbox().list(), enqueueUnlocked,
        () => currentBindingRef.current.namespace === namespace.value && currentBindingRef.current.outbox === outbox, true, setDayIntents
    ), [namespace.value, outbox, requireOutbox, enqueueUnlocked]);
    const readFoodDay = useCallback(async (date: string, fetch: () => Promise<FoodLogDay>) => {
        const result = await readAndRecordFoodDay(namespace.value ?? 'unavailable', date, fetch);
        const receipts = await readFoodDayReceipts(namespace.value ?? 'unavailable');
        if (currentBindingRef.current.namespace === namespace.value) setDayIntents(receipts);
        return result;
    }, [namespace.value]);
    const readFoodDays = useCallback(async (fetch: () => Promise<FoodLogDayRange>) => {
        const result = await readAndRecordFoodDays(namespace.value ?? 'unavailable', fetch);
        const receipts = await readFoodDayReceipts(namespace.value ?? 'unavailable');
        if (currentBindingRef.current.namespace === namespace.value) setDayIntents(receipts);
        return result;
    }, [namespace.value]);
    const readFoodPause = useCallback(async (fetch: () => Promise<{ pause: FoodTrackingPause }>) => {
        const result = await readAndRecordFoodPause(namespace.value ?? 'unavailable', fetch);
        const receipts = await readFoodDayReceipts(namespace.value ?? 'unavailable');
        if (currentBindingRef.current.namespace === namespace.value) setDayIntents(receipts);
        return result;
    }, [namespace.value]);
    const enqueue = useCallback((operation: string, payload: unknown, operationId?: string) =>
        withOutbox(write => write(operation, payload, operationId)) as Promise<QueuedMutation>, [withOutbox]);

    const reconcile = useCallback(async () => {
        if (!reconciler) throw new Error(initializationError ?? 'Browser offline storage is unavailable until authentication is ready.');
        const scheduleRetry = retrySchedulerRef.current;
        const result = await reconciler.reconcile();
        scheduleRetry(result);
        await notifyAfterReplay(result);
        await refresh();
        return result;
    }, [initializationError, notifyAfterReplay, reconciler, refresh]);

    const retryFailed = useCallback(async (id?: string) => {
        if (!reconciler) throw new Error(initializationError ?? 'Browser offline storage is unavailable until authentication is ready.');
        const scheduleRetry = retrySchedulerRef.current;
        const result = await reconciler.retryFailed(id);
        scheduleRetry(result);
        await notifyAfterReplay(result);
        await refresh();
        return result;
    }, [initializationError, notifyAfterReplay, reconciler, refresh]);

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
        let isOnline = connectivity.isOnline();
        let isVisible = visibility.isVisible();
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        /** Cancel the single provider-owned deferred replay timer. */
        const clearRetry = () => {
            if (retryTimer !== null) clearTimeout(retryTimer);
            retryTimer = null;
        };
        /** Schedule one eligible retry using the reconciler's bounded backoff. */
        const scheduleRetry = (result: ReconcileResult) => {
            clearRetry();
            if (!active || !isOnline || !isVisible || result.retryAfterMs === null) return;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (active && isOnline && isVisible) void replay();
            }, result.retryAfterMs);
        };
        /** Reconcile this provider generation and apply retry timing before post-replay work. */
        const replay = async () => {
            try {
                const result = await reconciler.reconcile();
                // Apply retry state before any slower invalidation or queue refresh can reorder completions.
                scheduleRetry(result);
                await notifyAfterReplay(result);
                if (active) setMutations(await requireOutbox().list());
                return result;
            } catch {
                if (active) await refresh().catch(() => undefined);
                return null;
            }
        };
        /** Resume durable failures only while the current tab is both visible and online. */
        const replayIfEligible = () => {
            if (!isOnline || !isVisible) {
                clearRetry();
                return;
            }
            void replay();
        };
        retrySchedulerRef.current = scheduleRetry;

        if (isOnline && isVisible) void replay();
        const unsubscribeConnectivity = connectivity.subscribe(() => {
            isOnline = connectivity.isOnline();
            replayIfEligible();
        });
        const unsubscribeVisibility = visibility.subscribe(() => {
            isVisible = visibility.isVisible();
            replayIfEligible();
        });
        return () => {
            active = false;
            clearRetry();
            if (retrySchedulerRef.current === scheduleRetry) {
                retrySchedulerRef.current = () => undefined;
            }
            unsubscribeConnectivity();
            unsubscribeVisibility();
        };
    }, [connectivity, notifyAfterReplay, reconciler, refresh, requireOutbox, visibility]);
    useEffect(() => {
        if (!newEnqueue || newEnqueue.store !== outbox || !connectivity.isOnline() || !visibility.isVisible()) return;
        void reconcile().catch(() => undefined);
    }, [newEnqueue, outbox, reconcile, connectivity, visibility]);
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

/** Reads the browser outbox context and throws outside its provider. */
export function useOfflineOutbox(): OfflineOutboxContextValue {
    const context = useContext(OfflineOutboxContext);
    if (!context) throw new Error('useOfflineOutbox must be used within OfflineOutboxProvider.');
    return context;
}
