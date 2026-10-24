/** @file use Food Delete Recovery: Route-bound food deletion with a six-second Undo window and durable offline fallback. */

import type { OutboxDispatch } from '../offline/mutationDispatch';
import { findFailedFood } from '../offline/failedCreation';
import { localTarget } from '../offline/trackingProjection';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { FoodLogEntry } from '@calibrate/api-client';
import {
    executeOrQueueMutation,
    OFFLINE_MUTATION_OPERATIONS,
    type OutboxMutationResult
} from '../offline/operations';
import type { QueuedMutation } from '../offline/queuedMutation';
import { FoodDeleteRecoveryController } from './FoodDeleteRecoveryController';
import {
    filterVisibleFoodLogEntries,
    getFailedQueuedFoodDeletes,
    getFoodDeleteHiddenIds,
    getQueuedFoodDeleteIds,
    type FoodDeleteTicket
} from './foodDeleteRecovery';

type FoodDeleteOutboxBindings = {
    withOutbox?: OutboxDispatch;
    enqueue: (operation: string, payload: unknown, operationId?: string) => Promise<unknown>;
    mutations: readonly QueuedMutation[];
    retryFailed: (operationId?: string) => Promise<unknown>;
};

export type FoodDeleteRecoveryFailure = Readonly<{
    entry: FoodLogEntry;
    operationId: string;
    message: string;
    source: 'direct' | 'outbox';
}>;

export type UseFoodDeleteRecoveryOptions = {
    date?: string;
    entries?: readonly FoodLogEntry[];
    deleteFoodLog: (entryId: number, operationId: string) => Promise<void>;
    outbox: FoodDeleteOutboxBindings;
    onCommitted?: (
        ticket: FoodDeleteTicket<FoodLogEntry>,
        outcome: OutboxMutationResult<void>
    ) => void | Promise<void>;
    createOperationId?: () => string;
    now?: () => number;
    undoWindowMs?: number;
};

/** Route-bound food deletion with a six-second Undo window and durable offline fallback. */
export function useFoodDeleteRecovery(options: UseFoodDeleteRecoveryOptions) {
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const [controller] = useState(() => new FoodDeleteRecoveryController<
        FoodLogEntry,
        OutboxMutationResult<void>
    >({
        commit: (ticket) => {
            const current = optionsRef.current;
            return executeOrQueueMutation({
                withOutbox: current.outbox.withOutbox,
                forceQueue: current.outbox.mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG,
                payload: { ...localTarget(ticket.entry), ...(current.date ? { date: current.date } : {}) },
                execute: () => current.deleteFoodLog(ticket.entry.id, ticket.operationId),
                enqueue: current.outbox.enqueue,
                createOperationId: () => ticket.operationId
            });
        },
        onCommitted: (ticket, outcome) => optionsRef.current.onCommitted?.(ticket, outcome),
        createOperationId: options.createOperationId,
        now: options.now,
        undoWindowMs: options.undoWindowMs
    }));
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

    useEffect(() => {
        if (options.entries) controller.reconcileEntries(options.entries);
    }, [controller, options.entries]);

    useFocusEffect(useCallback(() => () => {
        void controller.flush();
    }, [controller]));

    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState !== 'active') void controller.flush();
        });
        return () => subscription.remove();
    }, [controller]);

    const queuedDeleteIds = useMemo(
        () => getQueuedFoodDeleteIds(options.outbox.mutations).filter(id => {
            const entry = options.entries?.find(row => row.id === id);
            return !findFailedFood(options.outbox.mutations, { ...(entry ? localTarget(entry) : { id }), date: options.date });
        }),
        [options.outbox.mutations, options.entries, options.date]
    );
    const failedQueuedDeletes = useMemo(
        () => getFailedQueuedFoodDeletes(options.outbox.mutations),
        [options.outbox.mutations]
    );
    const failedQueuedDeleteIds = useMemo(
        () => failedQueuedDeletes.map(({ entryId }) => entryId),
        [failedQueuedDeletes]
    );
    const hiddenEntryIds = useMemo(
        () => getFoodDeleteHiddenIds(state, queuedDeleteIds, failedQueuedDeleteIds),
        [failedQueuedDeleteIds, queuedDeleteIds, state]
    );
    const visibleEntries = useMemo(
        () => filterVisibleFoodLogEntries(options.entries ?? [], hiddenEntryIds),
        [hiddenEntryIds, options.entries]
    );

    const failure = useMemo<FoodDeleteRecoveryFailure | null>(() => {
        const directFailure = state.failures[state.failures.length - 1];
        if (directFailure) {
            return {
                entry: directFailure.ticket.entry,
                operationId: directFailure.ticket.operationId,
                message: directFailure.message,
                source: 'direct'
            };
        }

        const entriesById = new Map((options.entries ?? []).map((entry) => [entry.id, entry]));
        for (let index = failedQueuedDeletes.length - 1; index >= 0; index -= 1) {
            const queuedFailure = failedQueuedDeletes[index];
            const entry = entriesById.get(queuedFailure.entryId);
            if (entry) {
                return {
                    entry,
                    operationId: queuedFailure.operationId,
                    message: 'Unable to delete this food entry.',
                    source: 'outbox'
                };
            }
        }
        return null;
    }, [failedQueuedDeletes, options.entries, state.failures]);

    const retry = useCallback(async (operationId = failure?.operationId) => {
        if (!operationId) return;
        const directFailure = controller.getSnapshot().failures.some(
            ({ ticket }) => ticket.operationId === operationId
        );
        if (directFailure) {
            await controller.retry(operationId);
            return;
        }
        await optionsRef.current.outbox.retryFailed(operationId);
    }, [controller, failure?.operationId]);

    return {
        failure,
        flush: controller.flush,
        hiddenEntryIds,
        pendingDelete: state.pending,
        requestDelete: controller.requestDelete,
        retry,
        undo: controller.undo,
        visibleEntries
    };
}
