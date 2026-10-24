/** @file Regression coverage for operations: retryable mutation classification. */

import { ApiError, type CalibrateApiClient } from '@calibrate/api-client';
import {
    createQueuedMutationExecutor,
    executeOrQueueMutation,
    isRetryableMutationError,
    OFFLINE_MUTATION_OPERATIONS
} from './operations';
import { OUTBOX_MUTATION_STATES, type QueuedMutation } from './queuedMutation';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

function queuedMutation(operation: string, payload: QueuedMutation['payload']): QueuedMutation {
    return {
        sequence: 1,
        id: 'stable-operation-id',
        namespace: 'https://health.example::user:1',
        operation,
        payload,
        state: OUTBOX_MUTATION_STATES.REPLAYING,
        attemptCount: 1,
        lastError: null,
        createdAt: 1,
        updatedAt: 2
    };
}

describe('retryable mutation classification', () => {
    it.each([408, 429, 500, 503])('retries transient HTTP status %i', (status) => {
        expect(isRetryableMutationError(new ApiError('temporary', status, null))).toBe(true);
    });

    it.each([400, 401, 403, 404, 409, 422])('does not queue validation/auth HTTP status %i', (status) => {
        expect(isRetryableMutationError(new ApiError('request rejected', status, null))).toBe(false);
    });

    it('honors an explicit server retryability envelope before the status fallback', () => {
        expect(isRetryableMutationError(new ApiError('still running', 409, { retryable: true }))).toBe(true);
        expect(isRetryableMutationError(new ApiError('terminal failure', 503, { retryable: false }))).toBe(false);
    });

    it('retries fetch transport failures and API timeouts only', () => {
        expect(isRetryableMutationError(new TypeError('Network request failed'))).toBe(true);
        expect(isRetryableMutationError(new Error(
            'Request timed out while connecting to https://health.example. Check the server URL and network access.'
        ))).toBe(true);
        expect(isRetryableMutationError(new Error('Invalid local state'))).toBe(false);
        expect(isRetryableMutationError(Object.assign(new Error('cancelled'), { name: 'AbortError' }))).toBe(false);
    });
});

describe('executeOrQueueMutation', () => {
    it('uses the same operation ID for the uncertain direct attempt and queued replay', async () => {
        const execute = jest.fn(async () => { throw new TypeError('Network request failed'); });
        const enqueue = jest.fn(async () => undefined);
        const payload = { date: '2026-07-11', weight: 82.5 };

        await expect(executeOrQueueMutation({
            operation: OFFLINE_MUTATION_OPERATIONS.ADD_METRIC,
            payload,
            execute,
            enqueue,
            createOperationId: () => 'stable-operation-id'
        })).resolves.toEqual({ disposition: 'queued', operationId: 'stable-operation-id' });

        expect(execute).toHaveBeenCalledWith('stable-operation-id');
        expect(enqueue).toHaveBeenCalledWith(
            OFFLINE_MUTATION_OPERATIONS.ADD_METRIC,
            payload,
            'stable-operation-id'
        );
    });

    it('does not queue successful or rejected validation requests', async () => {
        const enqueue = jest.fn(async () => undefined);
        await expect(executeOrQueueMutation({
            operation: OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_DAY,
            payload: { date: '2026-07-11', is_complete: true },
            execute: async () => 'saved',
            enqueue,
            createOperationId: () => 'success-id'
        })).resolves.toEqual({ disposition: 'synced', operationId: 'success-id', value: 'saved' });

        const validationError = new ApiError('invalid', 422, null);
        await expect(executeOrQueueMutation({
            operation: OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_DAY,
            payload: {},
            execute: async () => { throw validationError; },
            enqueue,
            createOperationId: () => 'validation-id'
        })).rejects.toBe(validationError);
        expect(enqueue).not.toHaveBeenCalled();
    });
});

describe('createQueuedMutationExecutor', () => {
    it('replays all supported operations with the persisted operation ID', async () => {
        const api = {
            createFoodLog: jest.fn(async () => undefined),
            updateFoodLog: jest.fn(async () => undefined),
            deleteFoodLog: jest.fn(async () => undefined),
            addMetric: jest.fn(async () => undefined),
            deleteMetric: jest.fn(async () => undefined),
            getFoodDay: jest.fn(async (date: string) => ({ date, status: 'OPEN' })),
            getFoodTrackingPause: jest.fn(async () => ({ pause: { active: false } })),
            updateFoodDay: jest.fn(async () => undefined),
            setFoodDayStatus: jest.fn(async () => undefined),
            startFoodTrackingPause: jest.fn(async () => undefined),
            updateFoodTrackingPause: jest.fn(async () => undefined),
            resumeFoodTracking: jest.fn(async () => undefined)
        } as unknown as CalibrateApiClient;
        const execute = createQueuedMutationExecutor(api);

        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG, {
            date: '2026-07-11', meal_period: 'DINNER', name: 'Dinner', calories: 600
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.ADD_METRIC, {
            date: '2026-07-11', weight: 82.5
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG, {
            id: 42, update: { name: 'Updated dinner', calories: 550, meal_period: 'DINNER' }
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG, { id: 43 }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC, { id: 44 }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_DAY, {
            date: '2026-07-11', is_complete: true
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS, {
            date: '2026-07-11', status: 'INCOMPLETE'
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE, {
            starts_on: '2026-07-11', expected_resume_on: '2026-07-14'
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE, {
            expected_resume_on: null
        }));
        await execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING, {
            resumed_on: '2026-07-13'
        }));

        expect(api.createFoodLog).toHaveBeenCalledWith(expect.objectContaining({ name: 'Dinner' }), 'stable-operation-id');
        expect(api.addMetric).toHaveBeenCalledWith({ date: '2026-07-11', weight: 82.5 }, 'stable-operation-id');
        expect(api.updateFoodLog).toHaveBeenCalledWith(
            42,
            { name: 'Updated dinner', calories: 550, meal_period: 'DINNER' },
            'stable-operation-id'
        );
        expect(api.deleteFoodLog).toHaveBeenCalledWith(43, 'stable-operation-id');
        expect(api.deleteMetric).toHaveBeenCalledWith(44, 'stable-operation-id');
        expect(api.updateFoodDay).toHaveBeenCalledWith(
            { date: '2026-07-11', is_complete: true },
            'stable-operation-id'
        );
        expect(api.setFoodDayStatus).toHaveBeenCalledWith(
            { date: '2026-07-11', status: 'INCOMPLETE' },
            'stable-operation-id'
        );
        expect(api.startFoodTrackingPause).toHaveBeenCalledWith(
            { starts_on: '2026-07-11', expected_resume_on: '2026-07-14' },
            'stable-operation-id'
        );
        expect(api.updateFoodTrackingPause).toHaveBeenCalledWith(
            { expected_resume_on: null },
            'stable-operation-id'
        );
        expect(api.resumeFoodTracking).toHaveBeenCalledWith(
            { resumed_on: '2026-07-13' },
            'stable-operation-id'
        );
    });

    it('fails unsupported or corrupt durable operations instead of dropping them', async () => {
        const execute = createQueuedMutationExecutor({} as CalibrateApiClient);
        await expect(execute(queuedMutation('unknown.operation', {}))).rejects.toThrow('Unsupported');
        await expect(execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.ADD_METRIC, { weight: 'bad' })))
            .rejects.toThrow('metric.add payload is invalid');
        await expect(execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG, { id: 0 })))
            .rejects.toThrow('food.delete payload is invalid');
        await expect(execute(queuedMutation(OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG, { id: 1, update: null })))
            .rejects.toThrow('food.update payload is invalid');
    });
});

describe('dependent offline entry replay', () => {
    it('resolves food edit and delete from the original immutable creation receipt after parent dequeue', async () => {
        const original = { date: '2026-07-21', meal_period: 'BREAKFAST', name: 'Oats', calories: 200, localSnapshot: { name: 'Oats', calories: 200 } };
        const localCreation = { operationId: 'original-create-id', localId: -1, operation: 'food.create', payload: original };
        const api = { createFoodLog: jest.fn().mockResolvedValue({ id: 501 }), updateFoodLog: jest.fn(), deleteFoodLog: jest.fn() };
        const execute = createQueuedMutationExecutor(api as unknown as CalibrateApiClient);
        await execute(queuedMutation('food.update', { id: -1, localCreation, update: { calories: 350 } }));
        await execute(queuedMutation('food.delete', { id: -1, localCreation }));
        expect(api.createFoodLog).toHaveBeenNthCalledWith(1, { date: '2026-07-21', meal_period: 'BREAKFAST', name: 'Oats', calories: 200 }, 'original-create-id');
        expect(api.createFoodLog).toHaveBeenNthCalledWith(2, { date: '2026-07-21', meal_period: 'BREAKFAST', name: 'Oats', calories: 200 }, 'original-create-id');
        expect(api.updateFoodLog).toHaveBeenCalledWith(501, { calories: 350 }, 'stable-operation-id');
        expect(api.deleteFoodLog).toHaveBeenCalledWith(501, 'stable-operation-id');
    });
    it('never guesses an ID or performs the child write if receipt recovery fails', async () => {
        const api = { createFoodLog: jest.fn().mockRejectedValue(new ApiError('receipt conflict', 409, null)), deleteFoodLog: jest.fn() };
        const execute = createQueuedMutationExecutor(api as unknown as CalibrateApiClient);
        await expect(execute(queuedMutation('food.delete', { id: -1, localCreation: { operationId: 'original-create-id', localId: -1, operation: 'food.create', payload: { date: '2026-07-21' } } }))).rejects.toThrow('receipt conflict');
        expect(api.deleteFoodLog).not.toHaveBeenCalled();
    });
    it('queues dependent edits even online so they cannot overtake their parent or earlier edits', async () => {
        const execute = jest.fn(); const enqueue = jest.fn();
        await executeOrQueueMutation({ operation: OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG, payload: { id: -1, localCreation: { operationId: 'original-create-id' }, update: { calories: 350 } }, execute, enqueue });
        expect(execute).not.toHaveBeenCalled(); expect(enqueue).toHaveBeenCalledTimes(1);
    });
});
