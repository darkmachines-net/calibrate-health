/** @file outbox: SQLite-backed queue for one server-origin and user namespace. */

import { assertRecoverableEnqueue, failedMutationDiscardIds } from './failedMutationRecovery';
import * as Crypto from 'expo-crypto';
import type { OutboxDatabase } from './database';
import {
    OUTBOX_MUTATION_STATES,
    parseMutationPayload,
    serializeMutationPayload,
    type NewQueuedMutation,
    type OutboxMutationState,
    type QueuedMutation
} from './queuedMutation';

const MAX_PERSISTED_ERROR_LENGTH = 2_000;

type QueuedMutationRow = {
    sequence: number;
    id: string;
    namespace: string;
    operation: string;
    payload_json: string;
    state: OutboxMutationState;
    attempt_count: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
};

export interface OutboxStore {
    /** Durably appends a mutation and returns its assigned identity and sequence. */
    enqueue(mutation: NewQueuedMutation): Promise<QueuedMutation>;
    /** Lists the namespace's durable mutations in replay order. */
    list(): Promise<QueuedMutation[]>;
    /** Atomically claims the next replayable mutation, respecting earlier blocking work. */
    claimNext(): Promise<QueuedMutation | null>;
    /** Removes a successfully replayed mutation from durable storage. */
    complete(id: string): Promise<void>;
    /** Marks claimed work failed with a persisted recovery message and returns the updated mutation. */
    fail(id: string, error: string): Promise<QueuedMutation>;
    /** Returns claimed work to pending state after a transient failure while retaining its identity. */
    defer(id: string, error: string): Promise<QueuedMutation>;
    /** Requeues interrupted replay work before a new synchronization owner begins. */
    recoverInterrupted(): Promise<void>;
    /** Requeues one failed mutation or all failures when no identifier is supplied. */
    retryFailed(id?: string): Promise<void>;
    /** Removes all mutations in this store's account and server namespace. */
    clear(): Promise<void>;
}

function mapRow(row: QueuedMutationRow): QueuedMutation {
    return {
        sequence: row.sequence,
        id: row.id,
        namespace: row.namespace,
        operation: row.operation,
        payload: parseMutationPayload(row.payload_json),
        state: row.state,
        attemptCount: row.attempt_count,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/** SQLite-backed queue for one server-origin and user namespace. */
export class SqliteOutbox implements OutboxStore {
    /** Binds a SQLite outbox to one account namespace with injectable identity and time sources. */
    constructor(
        private readonly database: OutboxDatabase,
        private readonly namespace: string,
        private readonly createId: () => string = Crypto.randomUUID,
        private readonly now: () => number = Date.now
    ) {}

    /** Validates and inserts a mutation with a durable sequence inside an exclusive SQLite transaction. */
    async enqueue(mutation: NewQueuedMutation): Promise<QueuedMutation> {
        const operation = mutation.operation.trim();
        if (!operation) throw new Error('Queued mutations require an operation name.');

        const id = mutation.id ?? this.createId();
        const timestamp = this.now();
        await this.database.withExclusiveTransactionAsync(async transaction => {
            const rows = await transaction.getAllAsync<QueuedMutationRow>('SELECT * FROM queued_mutations WHERE namespace = ? ORDER BY sequence ASC', [this.namespace]);
            assertRecoverableEnqueue(rows.map(mapRow), { ...mutation, operation, id }, this.namespace);
            await transaction.runAsync(
                `INSERT INTO queued_mutations
                    (id, namespace, operation, payload_json, state, attempt_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
                [id, this.namespace, operation, serializeMutationPayload(mutation.payload),
                    OUTBOX_MUTATION_STATES.PENDING, timestamp, timestamp]
            );
        });

        const created = await this.getById(id);
        if (!created) throw new Error('Queued mutation could not be read after insertion.');
        return created;
    }

    /** Reads namespace mutations in sequence order and decodes their validated payloads. */
    async list(): Promise<QueuedMutation[]> {
        const rows = await this.database.getAllAsync<QueuedMutationRow>(
            'SELECT * FROM queued_mutations WHERE namespace = ? ORDER BY sequence ASC',
            [this.namespace]
        );
        return rows.map(mapRow);
    }

    /** Claims the earliest pending row transactionally; an earlier failed or replaying row blocks later work. */
    async claimNext(): Promise<QueuedMutation | null> {
        let claimed: QueuedMutationRow | null = null;
        await this.database.withExclusiveTransactionAsync(async (transaction) => {
            const next = await transaction.getFirstAsync<QueuedMutationRow>(
                `SELECT * FROM queued_mutations
                 WHERE namespace = ?
                 ORDER BY sequence ASC LIMIT 1`,
                [this.namespace]
            );
            // A durable failure is a queue barrier until the user or caller explicitly retries it.
            if (!next || next.state !== OUTBOX_MUTATION_STATES.PENDING) return;

            const timestamp = this.now();
            const result = await transaction.runAsync(
                `UPDATE queued_mutations
                 SET state = ?, attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
                 WHERE id = ? AND namespace = ? AND state = ?`,
                [
                    OUTBOX_MUTATION_STATES.REPLAYING,
                    timestamp,
                    next.id,
                    this.namespace,
                    OUTBOX_MUTATION_STATES.PENDING
                ]
            );
            if (result.changes === 1) {
                claimed = {
                    ...next,
                    state: OUTBOX_MUTATION_STATES.REPLAYING,
                    attempt_count: next.attempt_count + 1,
                    last_error: null,
                    updated_at: timestamp
                };
            }
        });
        return claimed ? mapRow(claimed) : null;
    }

    /** Deletes only the matching replaying namespace row and rejects missing or changed claims. */
    async complete(id: string): Promise<void> {
        const result = await this.database.runAsync(
            'DELETE FROM queued_mutations WHERE id = ? AND namespace = ? AND state = ?',
            [id, this.namespace, OUTBOX_MUTATION_STATES.REPLAYING]
        );
        if (result.changes !== 1) throw new Error(`Unable to complete queued mutation ${id}.`);
    }

    /** Persists a bounded failure message only for the currently claimed namespace row. */
    async fail(id: string, error: string): Promise<QueuedMutation> {
        const result = await this.database.runAsync(
            `UPDATE queued_mutations SET state = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND namespace = ? AND state = ?`,
            [
                OUTBOX_MUTATION_STATES.FAILED,
                error.slice(0, MAX_PERSISTED_ERROR_LENGTH),
                this.now(),
                id,
                this.namespace,
                OUTBOX_MUTATION_STATES.REPLAYING
            ]
        );
        if (result.changes !== 1) throw new Error(`Unable to persist failure for queued mutation ${id}.`);
        const failed = await this.getById(id);
        if (!failed) throw new Error(`Failed queued mutation ${id} could not be read.`);
        return failed;
    }

    /** Return a transient replay failure to pending without making it a durable queue barrier. */
    async defer(id: string, error: string): Promise<QueuedMutation> {
        const result = await this.database.runAsync(
            `UPDATE queued_mutations SET state = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND namespace = ? AND state = ?`,
            [
                OUTBOX_MUTATION_STATES.PENDING,
                error.slice(0, MAX_PERSISTED_ERROR_LENGTH),
                this.now(),
                id,
                this.namespace,
                OUTBOX_MUTATION_STATES.REPLAYING
            ]
        );
        if (result.changes !== 1) throw new Error(`Unable to defer queued mutation ${id}.`);
        const deferred = await this.getById(id);
        if (!deferred) throw new Error(`Deferred queued mutation ${id} could not be read.`);
        return deferred;
    }

    /** Requeues namespace rows left replaying by an interrupted owner. */
    async recoverInterrupted(): Promise<void> {
        await this.database.runAsync(
            `UPDATE queued_mutations SET state = ?, updated_at = ?
             WHERE namespace = ? AND state = ?`,
            [
                OUTBOX_MUTATION_STATES.PENDING,
                this.now(),
                this.namespace,
                OUTBOX_MUTATION_STATES.REPLAYING
            ]
        );
    }

    /** Clears failure details and requeues either the selected failed row or every namespace failure. */
    async retryFailed(id?: string): Promise<void> {
        const idClause = id ? ' AND id = ?' : '';
        const params: Array<string | number> = [
            OUTBOX_MUTATION_STATES.PENDING,
            this.now(),
            this.namespace,
            OUTBOX_MUTATION_STATES.FAILED
        ];
        if (id) params.push(id);
        await this.database.runAsync(
            `UPDATE queued_mutations SET state = ?, last_error = NULL, updated_at = ?
             WHERE namespace = ? AND state = ?${idClause}`,
            params
        );
    }

    /** Checks dependencies and removes a reviewed failure atomically within the namespace transaction. */
    async discardFailedMutation(id: string): Promise<void> {
        await this.database.withExclusiveTransactionAsync(async transaction => {
            const rows = await transaction.getAllAsync<QueuedMutationRow>('SELECT * FROM queued_mutations WHERE namespace = ? ORDER BY sequence ASC', [this.namespace]);
            const ids = failedMutationDiscardIds(rows.map(mapRow), id);
            for (const target of ids) {
                await transaction.runAsync('DELETE FROM queued_mutations WHERE id = ? AND namespace = ?', [target, this.namespace]);
            }
        });
    }

    /** Uses the common transactional discard path for food failures and their dependents. */
    discardFailedFood(id: string): Promise<void> { return this.discardFailedMutation(id); }

    /** Deletes SQLite mutations only within the bound account and server namespace. */
    async clear(): Promise<void> {
        await this.database.runAsync('DELETE FROM queued_mutations WHERE namespace = ?', [this.namespace]);
    }

    private async getById(id: string): Promise<QueuedMutation | null> {
        const row = await this.database.getFirstAsync<QueuedMutationRow>(
            'SELECT * FROM queued_mutations WHERE id = ? AND namespace = ?',
            [id, this.namespace]
        );
        return row ? mapRow(row) : null;
    }
}
