/** @file Regression coverage for food Delete Recovery: food delete recovery state. */

import {
    createEmptyFoodDeleteRecoveryState,
    filterVisibleFoodLogEntries,
    getFailedQueuedFoodDeletes,
    getFoodDeleteHiddenIds,
    getQueuedFoodDeleteIds
} from './foodDeleteRecovery';
import { OUTBOX_MUTATION_STATES, type QueuedMutation } from '../offline/queuedMutation';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

function mutation(overrides: Partial<QueuedMutation>): QueuedMutation {
    return {
        sequence: 1,
        id: 'operation-1',
        namespace: 'test::user:1',
        operation: 'food.delete',
        payload: { id: 7 },
        state: OUTBOX_MUTATION_STATES.PENDING,
        attemptCount: 0,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    };
}

describe('food delete recovery state', () => {
    it('filters pending controller and durable outbox tombstones without reordering entries', () => {
        const first = { id: 1, name: 'First' };
        const second = { id: 2, name: 'Second' };
        const state = {
            ...createEmptyFoodDeleteRecoveryState<typeof first>(),
            pending: {
                entry: first,
                operationId: 'operation-1',
                requestedAt: 10,
                expiresAt: 6_010
            }
        };

        expect(getFoodDeleteHiddenIds(state, [2, 2])).toEqual([2, 1]);
        expect(filterVisibleFoodLogEntries([first, second, { id: 3, name: 'Third' }], [2, 1]))
            .toEqual([{ id: 3, name: 'Third' }]);
    });

    it('keeps pending and replaying deletes hidden but restores failed durable deletes', () => {
        const mutations = [
            mutation({ id: 'pending', payload: { id: 4 } }),
            mutation({ id: 'replaying', payload: { id: 5 }, state: OUTBOX_MUTATION_STATES.REPLAYING }),
            mutation({
                id: 'failed',
                payload: { id: 6 },
                state: OUTBOX_MUTATION_STATES.FAILED,
                lastError: 'private upstream error'
            }),
            mutation({ id: 'other', operation: 'metric.add', payload: { id: 8 } }),
            mutation({ id: 'invalid', payload: { id: 0 } })
        ];

        expect(getQueuedFoodDeleteIds(mutations)).toEqual([4, 5]);
        expect(getFailedQueuedFoodDeletes(mutations)).toEqual([
            { entryId: 6, operationId: 'failed' }
        ]);
        expect(JSON.stringify(getFailedQueuedFoodDeletes(mutations))).not.toContain('private upstream error');
    });

    it('restores a completed tombstone when its durable replay has failed', () => {
        const entry = { id: 6, name: 'Failed delete' };
        const state = {
            ...createEmptyFoodDeleteRecoveryState<typeof entry>(),
            completed: [{
                entry,
                operationId: 'failed',
                requestedAt: 1,
                expiresAt: 2
            }]
        };

        const hiddenIds = getFoodDeleteHiddenIds(state, [], [entry.id]);
        expect(hiddenIds).toEqual([]);
        expect(filterVisibleFoodLogEntries([entry], hiddenIds)).toEqual([entry]);
    });
});
