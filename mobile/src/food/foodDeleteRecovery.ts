/** @file Food deletion, undo, and failure recovery state with stable operation identity. */

import type { QueuedMutation } from '../offline/queuedMutation';
import { OUTBOX_MUTATION_STATES } from '../offline/queuedMutation';
import { OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';

export const FOOD_DELETE_UNDO_WINDOW_MS = 6_000;

export type FoodDeleteEntry = Readonly<{ id: number }>;

export type FoodDeleteTicket<TEntry extends FoodDeleteEntry> = Readonly<{
    entry: TEntry;
    operationId: string;
    requestedAt: number;
    expiresAt: number;
}>;

export type FoodDeleteFailure<TEntry extends FoodDeleteEntry> = Readonly<{
    ticket: FoodDeleteTicket<TEntry>;
    message: string;
}>;

export type FoodDeleteRecoveryState<TEntry extends FoodDeleteEntry> = Readonly<{
    pending: FoodDeleteTicket<TEntry> | null;
    committing: readonly FoodDeleteTicket<TEntry>[];
    completed: readonly FoodDeleteTicket<TEntry>[];
    failures: readonly FoodDeleteFailure<TEntry>[];
}>;

/** Creates an empty deletion-recovery state with no pending, committed, or failed removals. */
export function createEmptyFoodDeleteRecoveryState<
    TEntry extends FoodDeleteEntry
>(): FoodDeleteRecoveryState<TEntry> {
    return {
        pending: null,
        committing: [],
        completed: [],
        failures: []
    };
}

/** Combines queued and local deletions into hidden IDs while restoring failed completed deletions. */
export function getFoodDeleteHiddenIds<TEntry extends FoodDeleteEntry>(
    state: FoodDeleteRecoveryState<TEntry>,
    queuedDeleteIds: readonly number[] = [],
    failedDeleteIds: readonly number[] = []
): number[] {
    const failedIds = new Set(failedDeleteIds);
    return Array.from(new Set([
        ...queuedDeleteIds,
        ...(state.pending ? [state.pending.entry.id] : []),
        ...state.committing.map(({ entry }) => entry.id),
        ...state.completed.map(({ entry }) => entry.id).filter((id) => !failedIds.has(id))
    ]));
}

/** Returns a copy of the log list excluding entries hidden by deletion recovery. */
export function filterVisibleFoodLogEntries<TEntry extends FoodDeleteEntry>(
    entries: readonly TEntry[],
    hiddenIds: readonly number[]
): TEntry[] {
    if (hiddenIds.length === 0) return [...entries];
    const hidden = new Set(hiddenIds);
    return entries.filter(({ id }) => !hidden.has(id));
}

function readQueuedFoodDeleteId(
    mutation: Pick<QueuedMutation, 'operation' | 'payload'>
): number | null {
    if (
        mutation.operation !== OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG
        || mutation.payload === null
        || typeof mutation.payload !== 'object'
        || Array.isArray(mutation.payload)
    ) return null;

    const id = mutation.payload.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/** Pending/replaying outbox deletes remain optimistically hidden across route remounts. */
export function getQueuedFoodDeleteIds(
    mutations: ReadonlyArray<Pick<QueuedMutation, 'operation' | 'payload' | 'state'>>
): number[] {
    const ids = mutations.flatMap((mutation) => {
        if (mutation.state === OUTBOX_MUTATION_STATES.FAILED) return [];
        const id = readQueuedFoodDeleteId(mutation);
        return id === null ? [] : [id];
    });
    return Array.from(new Set(ids));
}

export type FailedQueuedFoodDelete = Readonly<{
    entryId: number;
    operationId: string;
}>;

/** Durable error text is intentionally omitted so UI never echoes server/provider details. */
export function getFailedQueuedFoodDeletes(
    mutations: ReadonlyArray<Pick<QueuedMutation, 'id' | 'operation' | 'payload' | 'state'>>
): FailedQueuedFoodDelete[] {
    return mutations.flatMap((mutation) => {
        if (mutation.state !== OUTBOX_MUTATION_STATES.FAILED) return [];
        const entryId = readQueuedFoodDeleteId(mutation);
        return entryId === null ? [] : [{ entryId, operationId: mutation.id }];
    });
}
