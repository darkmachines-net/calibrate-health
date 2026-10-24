/** @file Food Delete Recovery Controller: Owns the single Undo window while serializing every eventual delete commit. */

import * as Crypto from 'expo-crypto';
import { getSafeActionErrorMessage } from '../errors/presentation';
import {
    FOOD_DELETE_UNDO_WINDOW_MS,
    createEmptyFoodDeleteRecoveryState,
    type FoodDeleteEntry,
    type FoodDeleteFailure,
    type FoodDeleteRecoveryState,
    type FoodDeleteTicket
} from './foodDeleteRecovery';

export type FoodDeleteCommitResult<TEntry extends FoodDeleteEntry, TOutcome> =
    | Readonly<{ status: 'committed'; ticket: FoodDeleteTicket<TEntry>; outcome: TOutcome }>
    | Readonly<{ status: 'failed'; failure: FoodDeleteFailure<TEntry> }>;

export type FoodDeleteRecoveryControllerOptions<TEntry extends FoodDeleteEntry, TOutcome> = {
    commit: (ticket: FoodDeleteTicket<TEntry>) => Promise<TOutcome>;
    onCommitted?: (ticket: FoodDeleteTicket<TEntry>, outcome: TOutcome) => void | Promise<void>;
    createOperationId?: () => string;
    now?: () => number;
    undoWindowMs?: number;
    schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
    describeError?: (error: unknown) => string;
};

type Listener = () => void;

/** Owns the single Undo window while serializing every eventual delete commit. */
export class FoodDeleteRecoveryController<TEntry extends FoodDeleteEntry, TOutcome> {
    private state: FoodDeleteRecoveryState<TEntry> = createEmptyFoodDeleteRecoveryState();
    private readonly listeners = new Set<Listener>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private commitTail: Promise<void> = Promise.resolve();
    private readonly commitPromises = new Map<string, Promise<FoodDeleteCommitResult<TEntry, TOutcome>>>();

    /** Binds the deletion persistence, undo timing, and state callbacks supplied by the caller. */
    constructor(private readonly options: FoodDeleteRecoveryControllerOptions<TEntry, TOutcome>) {}

    getSnapshot = (): FoodDeleteRecoveryState<TEntry> => this.state;

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    requestDelete = (entry: TEntry): FoodDeleteTicket<TEntry> => {
        const existing = this.findActiveTicket(entry.id);
        if (existing) return existing;

        const failed = this.state.failures.find(({ ticket }) => ticket.entry.id === entry.id);
        if (failed) {
            void this.retry(failed.ticket.operationId);
            return failed.ticket;
        }

        if (this.state.pending) void this.flush();

        const requestedAt = (this.options.now ?? Date.now)();
        const undoWindowMs = this.options.undoWindowMs ?? FOOD_DELETE_UNDO_WINDOW_MS;
        const ticket: FoodDeleteTicket<TEntry> = {
            entry,
            operationId: (this.options.createOperationId ?? Crypto.randomUUID)(),
            requestedAt,
            expiresAt: requestedAt + undoWindowMs
        };
        this.setState({ ...this.state, pending: ticket });
        this.timer = (this.options.schedule ?? setTimeout)(() => {
            if (this.state.pending?.operationId === ticket.operationId) void this.flush();
        }, undoWindowMs);
        return ticket;
    };

    undo = (operationId = this.state.pending?.operationId): boolean => {
        if (!operationId || this.state.pending?.operationId !== operationId) return false;
        this.cancelTimer();
        this.setState({ ...this.state, pending: null });
        return true;
    };

    flush = (): Promise<FoodDeleteCommitResult<TEntry, TOutcome> | undefined> => {
        const ticket = this.state.pending;
        if (!ticket) return Promise.resolve(undefined);
        this.cancelTimer();
        this.setState({
            ...this.state,
            pending: null,
            committing: [...this.state.committing, ticket]
        });
        return this.queueCommit(ticket);
    };

    retry = (operationId: string): Promise<FoodDeleteCommitResult<TEntry, TOutcome> | undefined> => {
        const failure = this.state.failures.find(({ ticket }) => ticket.operationId === operationId);
        if (!failure) return Promise.resolve(undefined);
        this.setState({
            ...this.state,
            committing: [...this.state.committing, failure.ticket],
            failures: this.state.failures.filter(({ ticket }) => ticket.operationId !== operationId)
        });
        return this.queueCommit(failure.ticket);
    };

    /** Release tombstones only after refreshed server data confirms the entry is absent. */
    reconcileEntries = (entries: readonly FoodDeleteEntry[]): void => {
        if (this.state.completed.length === 0) return;
        const serverIds = new Set(entries.map(({ id }) => id));
        const completed = this.state.completed.filter(({ entry }) => serverIds.has(entry.id));
        if (completed.length !== this.state.completed.length) {
            this.setState({ ...this.state, completed });
        }
    };

    private findActiveTicket(entryId: number): FoodDeleteTicket<TEntry> | null {
        if (this.state.pending?.entry.id === entryId) return this.state.pending;
        return [...this.state.committing, ...this.state.completed]
            .find(({ entry }) => entry.id === entryId) ?? null;
    }

    private queueCommit(ticket: FoodDeleteTicket<TEntry>): Promise<FoodDeleteCommitResult<TEntry, TOutcome>> {
        const existing = this.commitPromises.get(ticket.operationId);
        if (existing) return existing;

        const promise = this.commitTail.then(() => this.runCommit(ticket));
        this.commitPromises.set(ticket.operationId, promise);
        this.commitTail = promise.then(() => undefined, () => undefined);
        return promise;
    }

    private async runCommit(ticket: FoodDeleteTicket<TEntry>): Promise<FoodDeleteCommitResult<TEntry, TOutcome>> {
        try {
            const outcome = await this.options.commit(ticket);
            this.commitPromises.delete(ticket.operationId);
            this.setState({
                ...this.state,
                committing: this.state.committing.filter(({ operationId }) => operationId !== ticket.operationId),
                completed: [...this.state.completed, ticket]
            });
            try {
                await this.options.onCommitted?.(ticket, outcome);
            } catch {
                // Cache refresh or feedback failures cannot turn a committed delete into a retryable delete.
            }
            return { status: 'committed', ticket, outcome };
        } catch (error) {
            const failure: FoodDeleteFailure<TEntry> = {
                ticket,
                message: (this.options.describeError ?? describeFoodDeleteError)(error)
            };
            this.commitPromises.delete(ticket.operationId);
            this.setState({
                ...this.state,
                committing: this.state.committing.filter(({ operationId }) => operationId !== ticket.operationId),
                failures: [
                    ...this.state.failures.filter(({ ticket: failed }) => failed.operationId !== ticket.operationId),
                    failure
                ]
            });
            return { status: 'failed', failure };
        }
    }

    private cancelTimer(): void {
        if (this.timer === null) return;
        (this.options.cancelScheduled ?? clearTimeout)(this.timer);
        this.timer = null;
    }

    private setState(state: FoodDeleteRecoveryState<TEntry>): void {
        this.state = state;
        this.listeners.forEach((listener) => listener());
    }
}

function describeFoodDeleteError(error: unknown): string {
    return getSafeActionErrorMessage(error, 'Unable to delete this food entry.');
}
