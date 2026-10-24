/** @file Regression coverage for outbox: SqliteOutbox. */

import type { OutboxDatabase } from './database';
import { SqliteOutbox } from './outbox';
import { OUTBOX_MUTATION_STATES, type OutboxMutationState } from './queuedMutation';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'mock-operation-id') }));

type TestRow = {
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

function row(overrides: Partial<TestRow> = {}): TestRow {
    return {
        sequence: 1,
        id: 'operation-1',
        namespace: 'https://health.example::user:7',
        operation: 'food.create',
        payload_json: '{"calories":400}',
        state: OUTBOX_MUTATION_STATES.PENDING,
        attempt_count: 0,
        last_error: null,
        created_at: 100,
        updated_at: 100,
        ...overrides
    };
}

function databaseMock(overrides: Partial<OutboxDatabase> = {}): OutboxDatabase {
    const database = {
        execAsync: jest.fn(async () => undefined),
        getAllAsync: jest.fn(async () => []),
        getFirstAsync: jest.fn(async () => null),
        runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
        withExclusiveTransactionAsync: jest.fn(async () => undefined),
        ...overrides
    } as OutboxDatabase;
    if (!overrides.withExclusiveTransactionAsync) database.withExclusiveTransactionAsync = jest.fn(async task => task(database as never));
    return database;
}

describe('SqliteOutbox', () => {
    const namespace = 'https://health.example::user:7';

    it('checks failed state and deletes only the creation chain inside one namespace transaction', async () => {
        const transaction = databaseMock({ getAllAsync: jest.fn(async () => [
            row({ state: 'failed' }), row({ id: 'edit', sequence: 2, operation: 'food.update', payload_json: '{"localCreation":{"operationId":"operation-1"}}' }),
            row({ id: 'unrelated', sequence: 3, operation: 'metric.add' })
        ]) });
        const database = databaseMock({ withExclusiveTransactionAsync: jest.fn(async task => task(transaction as never)) });
        await new SqliteOutbox(database, namespace).discardFailedFood('operation-1');
        expect(transaction.runAsync).toHaveBeenCalledTimes(2);
        expect(transaction.runAsync).toHaveBeenCalledWith(expect.stringContaining('DELETE'), ['operation-1', namespace]);
        expect(transaction.runAsync).toHaveBeenCalledWith(expect.stringContaining('DELETE'), ['edit', namespace]);
    });

    it('persists the authenticated namespace with the serialized payload', async () => {
        const createdRow = row();
        const database = databaseMock({
            getFirstAsync: jest.fn(async () => createdRow)
        });
        const outbox = new SqliteOutbox(database, namespace, () => createdRow.id, () => 100);

        await expect(outbox.enqueue({
            operation: 'food.create',
            payload: { calories: 400 }
        })).resolves.toEqual(expect.objectContaining({
            id: createdRow.id,
            namespace,
            payload: { calories: 400 }
        }));

        expect(database.runAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO queued_mutations'), [
            createdRow.id,
            namespace,
            'food.create',
            '{"calories":400}',
            OUTBOX_MUTATION_STATES.PENDING,
            100,
            100
        ]);
    });

    it('rejects a same-day metric correction inside the insertion transaction without losing existing work', async () => {
        const transaction = databaseMock({ getAllAsync: jest.fn(async () => [row({ operation: 'metric.delete', state: 'failed', payload_json: '{"id":42,"date":"2026-07-21"}' })]) });
        const database = databaseMock({ withExclusiveTransactionAsync: jest.fn(async task => task(transaction as never)) });
        const outbox = new SqliteOutbox(database, namespace);
        await expect(outbox.enqueue({ operation: 'metric.add', payload: { date: '2026-07-21', weight: 88 } })).rejects.toThrow('Resolve');
        expect(transaction.runAsync).not.toHaveBeenCalled();
        expect(database.getFirstAsync).not.toHaveBeenCalled();
    });

    it('claims the oldest pending mutation and records its replay attempt atomically', async () => {
        const transaction = databaseMock({
            getFirstAsync: jest.fn(async () => row()),
            runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 0 }))
        });
        const database = databaseMock({
            withExclusiveTransactionAsync: jest.fn(async (task) => task(transaction as never))
        });
        const outbox = new SqliteOutbox(database, namespace, () => 'unused', () => 200);

        await expect(outbox.claimNext()).resolves.toEqual(expect.objectContaining({
            id: 'operation-1',
            state: OUTBOX_MUTATION_STATES.REPLAYING,
            attemptCount: 1,
            updatedAt: 200
        }));
        expect(transaction.runAsync).toHaveBeenCalledWith(expect.stringContaining('attempt_count = attempt_count + 1'), [
            OUTBOX_MUTATION_STATES.REPLAYING,
            200,
            'operation-1',
            namespace,
            OUTBOX_MUTATION_STATES.PENDING
        ]);
    });

    it('returns retryable replay failures to pending with bounded diagnostic context', async () => {
        const deferredRow = row({ state: OUTBOX_MUTATION_STATES.PENDING, last_error: 'retry later' });
        const database = databaseMock({
            getFirstAsync: jest.fn(async () => deferredRow)
        });
        const outbox = new SqliteOutbox(database, namespace, () => 'unused', () => 300);

        await expect(outbox.defer('operation-1', 'retry later')).resolves.toEqual(expect.objectContaining({
            state: OUTBOX_MUTATION_STATES.PENDING,
            lastError: 'retry later'
        }));
        expect(database.runAsync).toHaveBeenCalledWith(expect.stringContaining('SET state = ?, last_error = ?'), [
            OUTBOX_MUTATION_STATES.PENDING,
            'retry later',
            300,
            'operation-1',
            namespace,
            OUTBOX_MUTATION_STATES.REPLAYING
        ]);
    });

    it('treats the oldest durable failure as a barrier to later pending writes', async () => {
        const transaction = databaseMock({
            getFirstAsync: jest.fn(async () => row({ state: OUTBOX_MUTATION_STATES.FAILED }))
        });
        const database = databaseMock({
            withExclusiveTransactionAsync: jest.fn(async (task) => task(transaction as never))
        });
        const outbox = new SqliteOutbox(database, namespace);

        await expect(outbox.claimNext()).resolves.toBeNull();
        expect(transaction.runAsync).not.toHaveBeenCalled();
    });

    it('atomically removes only the failed server-entry edits and deletion after explicit confirmation', async () => {
        const transaction = databaseMock({ getAllAsync: jest.fn(async () => [
            row({ id: 'failed-edit', operation: 'food.update', state: 'failed', payload_json: '{"id":42,"date":"2026-07-18"}' }),
            row({ id: 'later-edit', operation: 'food.update', payload_json: '{"id":42,"date":"2026-07-18"}' }),
            row({ id: 'delete', operation: 'food.delete', payload_json: '{"id":42,"date":"2026-07-18"}' }),
            row({ id: 'other', operation: 'food.update', payload_json: '{"id":99,"date":"2026-07-19"}' })
        ]) });
        const database = databaseMock({ withExclusiveTransactionAsync: jest.fn(async task => task(transaction as never)) });
        await new SqliteOutbox(database, namespace).discardFailedFood('failed-edit');
        expect(transaction.runAsync).toHaveBeenCalledTimes(3);
        for (const id of ['failed-edit', 'later-edit', 'delete']) expect(transaction.runAsync).toHaveBeenCalledWith('DELETE FROM queued_mutations WHERE id = ? AND namespace = ?', [id, namespace]);
    });

    it('clears only the authenticated namespace during account deletion', async () => {
        const database = databaseMock();
        const outbox = new SqliteOutbox(database, namespace);

        await outbox.clear();

        expect(database.runAsync).toHaveBeenCalledWith(
            'DELETE FROM queued_mutations WHERE namespace = ?',
            [namespace]
        );
    });
});
