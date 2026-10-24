/** @file Regression coverage for reconciler: OutboxReconciler. */

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
import { ApiError } from '@calibrate/api-client';
import type { OutboxStore } from './outbox';
import {
    OUTBOX_RETRY_BASE_DELAY_MS,
    OUTBOX_RETRY_MAX_DELAY_MS,
    OutboxReconciler,
    getOutboxRetryDelayMs
} from './reconciler';
import {
    OUTBOX_MUTATION_STATES,
    parseMutationPayload,
    serializeMutationPayload,
    type NewQueuedMutation,
    type QueuedMutation
} from './queuedMutation';

class MemoryOutbox implements OutboxStore {
    mutations: QueuedMutation[] = [];
    private nextSequence = 1;

    async enqueue(mutation: NewQueuedMutation): Promise<QueuedMutation> {
        const sequence = this.nextSequence++;
        const queued: QueuedMutation = {
            ...mutation,
            payload: parseMutationPayload(serializeMutationPayload(mutation.payload)),
            sequence,
            id: `mutation-${sequence}`,
            namespace: 'test::user:1',
            state: OUTBOX_MUTATION_STATES.PENDING,
            attemptCount: 0,
            lastError: null,
            createdAt: sequence,
            updatedAt: sequence
        };
        this.mutations.push(queued);
        return queued;
    }

    async list(): Promise<QueuedMutation[]> {
        return [...this.mutations];
    }

    async claimNext(): Promise<QueuedMutation | null> {
        const next = this.mutations[0];
        if (!next || next.state !== OUTBOX_MUTATION_STATES.PENDING) return null;
        next.state = OUTBOX_MUTATION_STATES.REPLAYING;
        next.attemptCount += 1;
        next.lastError = null;
        return { ...next };
    }

    async complete(id: string): Promise<void> {
        this.mutations = this.mutations.filter((mutation) => mutation.id !== id);
    }

    async fail(id: string, error: string): Promise<QueuedMutation> {
        const mutation = this.requireMutation(id);
        mutation.state = OUTBOX_MUTATION_STATES.FAILED;
        mutation.lastError = error;
        return { ...mutation };
    }

    async defer(id: string, error: string): Promise<QueuedMutation> {
        const mutation = this.requireMutation(id);
        mutation.state = OUTBOX_MUTATION_STATES.PENDING;
        mutation.lastError = error;
        return { ...mutation };
    }

    async recoverInterrupted(): Promise<void> {
        this.mutations.forEach((mutation) => {
            if (mutation.state === OUTBOX_MUTATION_STATES.REPLAYING) {
                mutation.state = OUTBOX_MUTATION_STATES.PENDING;
            }
        });
    }

    async retryFailed(id?: string): Promise<void> {
        this.mutations.forEach((mutation) => {
            if (mutation.state === OUTBOX_MUTATION_STATES.FAILED && (!id || mutation.id === id)) {
                mutation.state = OUTBOX_MUTATION_STATES.PENDING;
                mutation.lastError = null;
            }
        });
    }

    async clear(): Promise<void> {
        this.mutations = [];
    }

    private requireMutation(id: string): QueuedMutation {
        const mutation = this.mutations.find((candidate) => candidate.id === id);
        if (!mutation) throw new Error(`Unknown mutation ${id}`);
        return mutation;
    }
}

describe('OutboxReconciler', () => {
    it('replays queued writes serially in insertion order', async () => {
        const outbox = new MemoryOutbox();
        await outbox.enqueue({ operation: 'food.create', payload: { value: 1 } });
        await outbox.enqueue({ operation: 'weight.create', payload: { value: 2 } });
        const events: string[] = [];
        let activeExecutions = 0;

        const reconciler = new OutboxReconciler(outbox, async (mutation) => {
            activeExecutions += 1;
            expect(activeExecutions).toBe(1);
            events.push(mutation.operation);
            await Promise.resolve();
            activeExecutions -= 1;
        });

        await expect(reconciler.reconcile()).resolves.toEqual({
            replayed: 2,
            replayedOperations: ['food.create', 'weight.create'],
            failedMutation: null,
            deferredMutation: null,
            retryAfterMs: null
        });
        expect(events).toEqual(['food.create', 'weight.create']);
        expect(outbox.mutations).toEqual([]);
    });

    it('persists the first failure and does not reorder later writes past it', async () => {
        const outbox = new MemoryOutbox();
        const failed = await outbox.enqueue({ operation: 'food.create', payload: {} });
        const later = await outbox.enqueue({ operation: 'food.delete', payload: { id: 3 } });
        const reconciler = new OutboxReconciler(outbox, async () => {
            throw new Error('server unavailable');
        });

        const result = await reconciler.reconcile();

        expect(result.replayed).toBe(0);
        expect(result.replayedOperations).toEqual([]);
        expect(result.failedMutation).toEqual(expect.objectContaining({
            id: failed.id,
            state: 'failed',
            attemptCount: 1,
            lastError: 'server unavailable'
        }));
        expect(outbox.mutations).toEqual([
            expect.objectContaining({ id: failed.id, state: 'failed', lastError: 'server unavailable' }),
            expect.objectContaining({ id: later.id, state: 'pending', attemptCount: 0 })
        ]);

        await reconciler.reconcile();
        expect(outbox.mutations[1]).toEqual(expect.objectContaining({ id: later.id, state: 'pending' }));
    });

    it('returns explicit retryable replay failures to pending for a later recovery trigger', async () => {
        const outbox = new MemoryOutbox();
        const deferred = await outbox.enqueue({ operation: 'food.create', payload: {} });
        const reconciler = new OutboxReconciler(outbox, async () => {
            throw new ApiError('operation is still settling', 409, { retryable: true });
        });

        await expect(reconciler.reconcile()).resolves.toEqual({
            replayed: 0,
            replayedOperations: [],
            failedMutation: null,
            deferredMutation: expect.objectContaining({
                id: deferred.id,
                state: OUTBOX_MUTATION_STATES.PENDING,
                attemptCount: 1
            }),
            retryAfterMs: getOutboxRetryDelayMs(1, deferred.id)
        });
        expect(outbox.mutations).toEqual([
            expect.objectContaining({
                id: deferred.id,
                state: OUTBOX_MUTATION_STATES.PENDING,
                attemptCount: 1,
                lastError: 'operation is still settling'
            })
        ]);
        await expect(reconciler.reconcile()).resolves.toEqual({
            replayed: 0,
            replayedOperations: [],
            failedMutation: null,
            deferredMutation: expect.objectContaining({ attemptCount: 2 }),
            retryAfterMs: getOutboxRetryDelayMs(2, deferred.id)
        });
    });

    it('slows persistent retry traffic with deterministic jitter and a fifteen-minute ceiling', () => {
        const mutationId = 'persistent-operation';
        const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((attempt) =>
            getOutboxRetryDelayMs(attempt, mutationId)
        );
        expect(getOutboxRetryDelayMs(0, mutationId)).toBe(delays[0]);
        expect(getOutboxRetryDelayMs(6, mutationId)).toBeGreaterThan(2 * 60_000);
        expect(delays.every((delay, index) => index === 0 || delay > delays[index - 1])).toBe(true);
        const cappedDelay = getOutboxRetryDelayMs(100, mutationId);
        expect(cappedDelay).toBeGreaterThanOrEqual(OUTBOX_RETRY_MAX_DELAY_MS * 0.75);
        expect(cappedDelay).toBeLessThanOrEqual(OUTBOX_RETRY_MAX_DELAY_MS);
        expect(getOutboxRetryDelayMs(100, mutationId)).toBe(cappedDelay);
        expect(getOutboxRetryDelayMs(100, 'different-operation')).not.toBe(cappedDelay);
        expect(OUTBOX_RETRY_BASE_DELAY_MS).toBe(5_000);
    });

    it('coalesces concurrent reconciliation requests into one replay loop', async () => {
        const outbox = new MemoryOutbox();
        await outbox.enqueue({ operation: 'weight.create', payload: { weight: 80 } });
        let releaseExecution!: () => void;
        const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
        const executor = jest.fn(async () => executionGate);
        const reconciler = new OutboxReconciler(outbox, executor);

        const first = reconciler.reconcile();
        const second = reconciler.reconcile();
        expect(second).toBe(first);
        releaseExecution();

        await expect(first).resolves.toEqual({
            replayed: 1,
            replayedOperations: ['weight.create'],
            failedMutation: null,
            deferredMutation: null,
            retryAfterMs: null
        });
        expect(executor).toHaveBeenCalledTimes(1);
    });

    it('retries durable failures explicitly before continuing the queue', async () => {
        const outbox = new MemoryOutbox();
        const first = await outbox.enqueue({ operation: 'food.create', payload: {} });
        await outbox.enqueue({ operation: 'food.delete', payload: {} });
        let shouldFail = true;
        const executor = jest.fn(async () => {
            if (shouldFail) throw new Error('offline');
        });
        const reconciler = new OutboxReconciler(outbox, executor);
        await reconciler.reconcile();

        shouldFail = false;
        await expect(reconciler.retryFailed(first.id)).resolves.toEqual({
            replayed: 2,
            replayedOperations: ['food.create', 'food.delete'],
            failedMutation: null,
            deferredMutation: null,
            retryAfterMs: null
        });
        expect(outbox.mutations).toEqual([]);
    });

    it('reports operations that succeeded before a later replay fails', async () => {
        const outbox = new MemoryOutbox();
        await outbox.enqueue({ operation: 'metric.add', payload: { weight: 80 } });
        const failed = await outbox.enqueue({ operation: 'food.create', payload: {} });
        const reconciler = new OutboxReconciler(outbox, async (mutation) => {
            if (mutation.operation === 'food.create') throw new Error('invalid food');
        });

        await expect(reconciler.reconcile()).resolves.toEqual({
            replayed: 1,
            replayedOperations: ['metric.add'],
            failedMutation: expect.objectContaining({ id: failed.id, state: 'failed' }),
            deferredMutation: null,
            retryAfterMs: null
        });
    });
});


it('serializes interrupted recovery across two reconcilers sharing a durable namespace', async () => {
    const store = new MemoryOutbox();
    await store.enqueue({ operation: 'food.create', payload: {} });
    await store.enqueue({ operation: 'food-day.set-status', payload: { status: 'COMPLETE' } });
    let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const calls: string[] = [];
    const execute = async (mutation: QueuedMutation) => {
        calls.push(mutation.operation);
        if (mutation.operation === 'food.create') { entered(); await barrier; }
        else return { currentControl: { day: { date: '2026-08-08', status: 'COMPLETE' as const } } };
    };
    const recover = jest.spyOn(store, 'recoverInterrupted');
    const first = new OutboxReconciler(store, execute, 'shared-replay').reconcile();
    await started;
    const second = new OutboxReconciler(store, execute, 'shared-replay').reconcile();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['food.create']);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.replayed)).toEqual([2, 0]);
    expect(calls).toEqual(['food.create', 'food-day.set-status']);
    expect(await store.list()).toEqual([]);
});
