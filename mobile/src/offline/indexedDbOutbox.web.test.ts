/** @file Regression coverage for indexed Db Outbox web: IndexedDbOutbox. */

import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOutbox, openIndexedDbOutboxDatabase } from './indexedDbOutbox.web';
import { OUTBOX_MUTATION_STATES } from './queuedMutation';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

const FIRST_NAMESPACE = 'https://health.example::user:7';
const SECOND_NAMESPACE = 'https://health.example::user:9';

describe('IndexedDbOutbox', () => {
    let factory: IDBFactory;
    let database: IDBDatabase;

    beforeEach(async () => {
        factory = new IDBFactory();
        database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'test-outbox' });
    });

    afterEach(() => database.close());

    it('atomically discards a failed creation and dependent edits, keeping other accounts and independent work', async () => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE);
        const other = new IndexedDbOutbox(database, SECOND_NAMESPACE);
        await outbox.enqueue({ id: 'creation', operation: 'food.create', payload: { calories: 200 } });
        await outbox.enqueue({ id: 'edit', operation: 'food.update', payload: { localCreation: { operationId: 'creation' }, update: { calories: 300 } } });
        await outbox.enqueue({ id: 'weight', operation: 'metric.add', payload: { weight: 87 } });
        await other.enqueue({ id: 'creation', operation: 'food.create', payload: { calories: 900 } });
        await outbox.claimNext();
        await expect(outbox.discardFailedFood('creation')).rejects.toThrow('changed');
        expect(await outbox.list()).toHaveLength(3);
        await outbox.fail('creation', 'My food not found');
        await outbox.discardFailedFood('creation');
        expect((await outbox.list()).map(row => row.id)).toEqual(['weight']);
        expect(await other.list()).toHaveLength(1);
        expect((await outbox.claimNext())?.id).toBe('weight');
    });

    it('rejects stale discard after a failure has been retried without deleting its dependent edits', async () => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE);
        await outbox.enqueue({ id: 'creation', operation: 'food.create', payload: { calories: 200 } });
        await outbox.enqueue({ id: 'edit', operation: 'food.update', payload: { localCreation: { operationId: 'creation' } } });
        await outbox.claimNext(); await outbox.fail('creation', 'Rejected'); await outbox.retryFailed('creation');
        await expect(outbox.discardFailedFood('creation')).rejects.toThrow('changed');
        expect(await outbox.list()).toHaveLength(2);
    });

    it.each(['server', 'optimistic'] as const)('recovers failed %s edits with explicit retry or target-scoped discard, retaining other dates/accounts', async kind => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE);
        const other = new IndexedDbOutbox(database, SECOND_NAMESPACE);
        const target = kind === 'server' ? { id: 42, date: '2026-07-18' } : { id: -1, date: '2026-07-18', localCreation: { operationId: 'acknowledged-create', payload: { date: '2026-07-18' } } };
        await outbox.enqueue({ id: 'failed-edit', operation: 'food.update', payload: { ...target, update: { calories: 350 } } });
        await outbox.enqueue({ id: 'later-edit', operation: 'food.update', payload: { ...target, update: { calories: 400 } } });
        await outbox.enqueue({ id: 'delete', operation: 'food.delete', payload: target });
        await outbox.enqueue({ id: 'other-date', operation: 'food.update', payload: { id: 99, date: '2026-07-19', update: { calories: 500 } } });
        await other.enqueue({ id: 'failed-edit', operation: 'food.update', payload: { ...target, update: { calories: 900 } } });
        await outbox.claimNext(); await outbox.fail('failed-edit', 'Food day paused');
        expect(await outbox.claimNext()).toBeNull();
        await outbox.retryFailed('failed-edit');
        await expect(outbox.discardFailedFood('failed-edit')).rejects.toThrow('changed');
        const retry = await outbox.claimNext();
        expect(retry).toEqual(expect.objectContaining({ id: 'failed-edit', attemptCount: 2, payload: { ...target, update: { calories: 350 } } }));
        await outbox.fail('failed-edit', 'Still paused');
        await outbox.discardFailedFood('failed-edit');
        expect((await outbox.list()).map(row => row.id)).toEqual(['other-date']);
        expect((await other.list())[0].payload).toEqual({ ...target, update: { calories: 900 } });
        expect((await outbox.claimNext())?.id).toBe('other-date');
    });

    it.each(['metric.add', 'metric.delete'])('atomically refuses trapped corrections after failed %s and preserves original retry/day isolation', async operation => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE);
        const other = new IndexedDbOutbox(database, SECOND_NAMESPACE);
        const payload = operation === 'metric.add' ? { date: '2026-07-21', weight: 88 } : { id: 42, date: '2026-07-21' };
        await outbox.enqueue({ id: 'failed', operation, payload });
        await outbox.enqueue({ id: 'old-correction', operation: 'metric.add', payload: { date: '2026-07-21', weight: 89 } });
        await outbox.claimNext(); await outbox.fail('failed', 'Rejected');
        await expect(outbox.enqueue({ id: 'trapped', operation: 'metric.add', payload: { date: '2026-07-21', weight: 90 } })).rejects.toThrow('Resolve');
        expect((await outbox.list()).map(row => row.id)).toEqual(['failed', 'old-correction']);
        await outbox.enqueue({ id: 'other-day', operation: 'metric.add', payload: { date: '2026-07-22', weight: 91 } });
        await other.enqueue({ id: 'other-account', operation: 'metric.add', payload: { date: '2026-07-21', weight: 95 } });
        await outbox.retryFailed('failed');
        expect(await outbox.claimNext()).toEqual(expect.objectContaining({ id: 'failed', payload, attemptCount: 2 }));
        await outbox.fail('failed', 'Still rejected');
        await outbox.discardFailedMutation('failed');
        expect((await outbox.list()).map(row => row.id)).toEqual(['other-day']);
        expect(await other.list()).toHaveLength(1);
        expect((await outbox.claimNext())?.id).toBe('other-day');
        await outbox.complete('other-day');
        await outbox.enqueue({ id: 'replacement', operation: 'metric.add', payload: { date: '2026-07-21', weight: 92 } });
        expect((await outbox.claimNext())?.id).toBe('replacement');
    });

    it('persists all supported write shapes in insertion order with stable operation IDs', async () => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE, () => 'unused', () => 100);
        const writes = [
            ['food.create', { date: '2026-07-18', calories: 400 }],
            ['food.update', { id: 2, update: { calories: 425 } }],
            ['food.delete', { id: 3 }],
            ['metric.add', { date: '2026-07-18', weight: 88.2 }],
            ['metric.delete', { id: 4 }],
            ['food-day.update', { date: '2026-07-18', is_complete: true }]
        ] as const;

        for (const [index, [operation, payload]] of writes.entries()) {
            const id = `operation-${index + 1}`;
            await outbox.enqueue({ id, operation, payload });
        }

        database.close();
        database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'test-outbox' });
        const restored = await new IndexedDbOutbox(database, FIRST_NAMESPACE).list();
        expect(restored.map(({ id, operation, payload, state }) => ({ id, operation, payload, state }))).toEqual(
            writes.map(([operation, payload], index) => ({
                id: `operation-${index + 1}`,
                operation,
                payload,
                state: OUTBOX_MUTATION_STATES.PENDING
            }))
        );
        expect(restored.map((mutation) => mutation.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('preserves the durable failure barrier and retry attempt state', async () => {
        let now = 100;
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE, () => 'unused', () => now++);
        await outbox.enqueue({ id: 'first', operation: 'food.create', payload: { calories: 100 } });
        await outbox.enqueue({ id: 'second', operation: 'food.delete', payload: { id: 5 } });

        const claimed = await outbox.claimNext();
        expect(claimed).toEqual(expect.objectContaining({ id: 'first', state: 'replaying', attemptCount: 1 }));
        await outbox.fail('first', 'server unavailable');
        await expect(outbox.claimNext()).resolves.toBeNull();
        expect(await outbox.list()).toEqual([
            expect.objectContaining({ id: 'first', state: 'failed', attemptCount: 1, lastError: 'server unavailable' }),
            expect.objectContaining({ id: 'second', state: 'pending', attemptCount: 0 })
        ]);

        await outbox.retryFailed('first');
        await expect(outbox.claimNext()).resolves.toEqual(expect.objectContaining({ id: 'first', attemptCount: 2 }));
        await outbox.complete('first');
        await expect(outbox.claimNext()).resolves.toEqual(expect.objectContaining({ id: 'second', attemptCount: 1 }));
    });

    it('returns transient replay failures to pending without creating a queue barrier', async () => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE, () => 'deferred', () => 100);
        await outbox.enqueue({ operation: 'food.create', payload: { calories: 100 } });
        await outbox.claimNext();

        await expect(outbox.defer('deferred', 'operation still in progress')).resolves.toEqual(
            expect.objectContaining({
                id: 'deferred',
                state: OUTBOX_MUTATION_STATES.PENDING,
                attemptCount: 1,
                lastError: 'operation still in progress'
            })
        );
        await expect(outbox.claimNext()).resolves.toEqual(
            expect.objectContaining({ id: 'deferred', state: OUTBOX_MUTATION_STATES.REPLAYING, attemptCount: 2 })
        );
    });
    it('recovers an interrupted replay after restart without changing its operation ID', async () => {
        const outbox = new IndexedDbOutbox(database, FIRST_NAMESPACE, () => 'stable-id', () => 100);
        await outbox.enqueue({ operation: 'metric.add', payload: { date: '2026-07-18', weight: 88 } });
        await outbox.claimNext();

        database.close();
        database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'test-outbox' });
        const restored = new IndexedDbOutbox(database, FIRST_NAMESPACE, () => 'different-id', () => 200);
        await restored.recoverInterrupted();
        await expect(restored.list()).resolves.toEqual([
            expect.objectContaining({ id: 'stable-id', state: 'pending', attemptCount: 1, updatedAt: 200 })
        ]);
    });

    it('isolates account namespaces and clears only the selected account', async () => {
        const first = new IndexedDbOutbox(database, FIRST_NAMESPACE);
        const second = new IndexedDbOutbox(database, SECOND_NAMESPACE);
        await first.enqueue({ id: 'shared-operation-id', operation: 'food.create', payload: { calories: 100 } });
        await second.enqueue({ id: 'shared-operation-id', operation: 'food.create', payload: { calories: 200 } });

        expect((await first.list())[0]).toEqual(expect.objectContaining({ payload: { calories: 100 } }));
        expect((await second.list())[0]).toEqual(expect.objectContaining({ payload: { calories: 200 } }));
        await first.clear();
        await expect(first.list()).resolves.toEqual([]);
        await expect(second.list()).resolves.toHaveLength(1);
    });

    it('returns an honest error when IndexedDB is unavailable', async () => {
        await expect(openIndexedDbOutboxDatabase({ factory: null }))
            .rejects.toThrow('Browser offline storage is unavailable: IndexedDB is not supported.');
    });
});
