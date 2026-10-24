/** @file operations: Uses one operation ID for the uncertain direct attempt and every later replay. */

import { validatePauseTransition } from './pauseIntent';
import { assertQueuedDayTransition, assertQueuedFoodDayOpen } from './foodDayIntent';
import type { OutboxDispatch } from './mutationDispatch';
import type { QueuedMutation } from './queuedMutation';
import { foodWirePayload } from './trackingProjection';
import { onlineManager } from '@tanstack/react-query';
import {
    type CalibrateApiClient,
    type FoodLogUpdatePayload
} from '@calibrate/api-client';
import * as Crypto from 'expo-crypto';
import type { QueuedMutationExecutor } from './reconciler';
import { isRetryableMutationError } from './retryability';

export { isRetryableMutationError } from './retryability';

import { OFFLINE_MUTATION_OPERATIONS, type OfflineMutationOperation } from './mutationKinds';
export { OFFLINE_MUTATION_OPERATIONS } from './mutationKinds';

export type OutboxMutationResult<T> =
    | { disposition: 'synced'; operationId: string; value: T }
    | { disposition: 'queued'; operationId: string };

type ExecuteOrQueueOptions<T> = {
    operation: OfflineMutationOperation;
    forceQueue?: boolean;
    withOutbox?: OutboxDispatch;
    recordControl?: (operation: string, payload: unknown, id: string) => Promise<void>;
    payload: unknown;
    execute: (operationId: string) => Promise<T>;
    enqueue: (operation: string, payload: unknown, operationId?: string) => Promise<unknown>;
    createOperationId?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecordPayload(value: unknown, operation: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`Queued ${operation} payload is invalid.`);
    return value;
}

function requirePositiveInteger(value: unknown, operation: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`Queued ${operation} payload is invalid.`);
    }
    return value;
}

/** Uses one operation ID for the uncertain direct attempt and every later replay. */
export async function executeOrQueueMutation<T>({
    operation,
    forceQueue = false,
    withOutbox,
    recordControl,
    payload,
    execute,
    enqueue,
    createOperationId = Crypto.randomUUID
}: ExecuteOrQueueOptions<T>): Promise<OutboxMutationResult<T>> {
    if (withOutbox) return withOutbox((durableEnqueue, mustQueue, pending, record) => {
        const existing = validatePauseTransition(pending, operation, payload);
        if (existing) return Promise.resolve({ disposition: 'queued' as const, operationId: existing.id });
        assertQueuedDayTransition(pending, operation, payload);
        assertQueuedFoodDayOpen(pending, operation, payload);
        return executeOrQueueMutation({ operation, forceQueue: forceQueue || mustQueue, payload, execute, enqueue: durableEnqueue, createOperationId, recordControl: record });
    });
    const operationId = createOperationId();
    if (forceQueue || !onlineManager.isOnline() || (isRecord(payload) && payload.localCreation)) {
        await enqueue(operation, payload, operationId);
        return { disposition: 'queued', operationId };
    }
    try {
        const value = await execute(operationId);
        try { await recordControl?.(operation, payload, operationId); }
        catch { await enqueue(operation, payload, operationId); return { disposition: 'queued', operationId }; }
        return { disposition: 'synced', operationId, value };
    } catch (error) {
        if (!isRetryableMutationError(error)) throw error;
        await enqueue(operation, payload, operationId);
        return { disposition: 'queued', operationId };
    }
}

/** Maps durable operation names back to the idempotent API methods used for replay. */
export function createQueuedMutationExecutor(api: CalibrateApiClient, options: {
    isCurrent?: (mutation: QueuedMutation) => boolean;
    onApplied?: (mutation: QueuedMutation, response: unknown) => Promise<void>;
} = {}): QueuedMutationExecutor {
    return async (mutation) => {
        const assertCurrent = () => { if (options.isCurrent && !options.isCurrent(mutation)) throw new TypeError('Offline account scope changed.'); };
        assertCurrent();
        const applied = async (response: unknown) => { assertCurrent(); await options.onApplied?.(mutation, response); };
        const payload = requireRecordPayload(mutation.payload, mutation.operation);
        const currentControl = async (date?: string, readPause = false) => {
            const day = date ? await api.getFoodDay(date) : undefined;
            const pause = readPause ? (await api.getFoodTrackingPause()).pause : undefined;
            assertCurrent();
            const current = { day, pause };
            await applied(current);
            return { currentControl: current };
        };
        switch (mutation.operation) {
            case OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG:
                await applied(await api.createFoodLog(foodWirePayload(payload), mutation.id));
                return;
            case OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG: {
                const id = await resolveTargetId(api, payload, mutation.operation);
                const update = requireRecordPayload(payload.update, mutation.operation) as FoodLogUpdatePayload;
                assertCurrent();
                await applied(await api.updateFoodLog(id, update, mutation.id));
                return;
            }
            case OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG: {
                const id = await resolveTargetId(api, payload, mutation.operation);
                assertCurrent();
                await api.deleteFoodLog(id, mutation.id);
                await applied({ id });
                return;
            }
            case OFFLINE_MUTATION_OPERATIONS.ADD_METRIC:
                if (typeof payload.weight !== 'number' || typeof payload.date !== 'string') {
                    throw new Error('Queued metric.add payload is invalid.');
                }
                await applied(await api.addMetric({ weight: payload.weight, date: payload.date }, mutation.id));
                return;
            case OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC: {
                const id = await resolveTargetId(api, payload, mutation.operation);
                assertCurrent();
                await api.deleteMetric(id, mutation.id);
                await applied({ id });
                return;
            }
            case OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_DAY:
                if (typeof payload.date !== 'string' || typeof payload.is_complete !== 'boolean') {
                    throw new Error('Queued food-day.update payload is invalid.');
                }
                await api.updateFoodDay({ date: payload.date, is_complete: payload.is_complete }, mutation.id);
                return currentControl(payload.date);
            case OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS:
                if (
                    typeof payload.date !== 'string' ||
                    (payload.status !== 'OPEN' && payload.status !== 'COMPLETE' && payload.status !== 'INCOMPLETE')
                ) {
                    throw new Error('Queued food-day.set-status payload is invalid.');
                }
                await api.setFoodDayStatus({ date: payload.date, status: payload.status }, mutation.id);
                return currentControl(payload.date);
            case OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE:
                if (
                    typeof payload.starts_on !== 'string' ||
                    !(payload.expected_resume_on === null || typeof payload.expected_resume_on === 'string')
                ) {
                    throw new Error('Queued food-tracking-pause.start payload is invalid.');
                }
                await api.startFoodTrackingPause({
                    starts_on: payload.starts_on,
                    expected_resume_on: payload.expected_resume_on
                }, mutation.id);
                return currentControl(typeof payload.starts_on === 'string' ? payload.starts_on : undefined, true);
            case OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE:
                if (!(payload.expected_resume_on === null || typeof payload.expected_resume_on === 'string')) {
                    throw new Error('Queued food-tracking-pause.update payload is invalid.');
                }
                await api.updateFoodTrackingPause({
                    expected_resume_on: payload.expected_resume_on
                }, mutation.id);
                return currentControl(undefined, true);
            case OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING:
                if (typeof payload.resumed_on !== 'string') {
                    throw new Error('Queued food-tracking-pause.resume payload is invalid.');
                }
                await api.resumeFoodTracking({ resumed_on: payload.resumed_on }, mutation.id);
                return currentControl(payload.resumed_on, true);
            default:
                throw new Error(`Unsupported queued mutation operation: ${mutation.operation}`);
        }
    };
}

/** Recover the immutable creation receipt, never guess a server ID from name/date or resend a changed create. */
async function resolveTargetId(api: CalibrateApiClient, payload: Record<string, unknown>, operation: string): Promise<number> {
    if (!payload.localCreation) return requirePositiveInteger(payload.id, operation);
    const reference = requireRecordPayload(payload.localCreation, operation);
    if (typeof reference.operationId !== 'string' || reference.localId !== payload.id) throw new Error('Invalid local creation reference.');
    const original = requireRecordPayload(reference.payload, operation);
    if (reference.operation === 'food.create' && operation.startsWith('food.')) {
        const created = await api.createFoodLog(foodWirePayload(original), reference.operationId);
        return requirePositiveInteger(created.id, operation);
    }
    if (reference.operation === 'metric.add' && operation === 'metric.delete' && typeof original.weight === 'number' && typeof original.date === 'string') {
        const created = await api.addMetric({ weight: original.weight, date: original.date }, reference.operationId);
        return requirePositiveInteger(created.id, operation);
    }
    throw new Error('Invalid local creation operation.');
}
