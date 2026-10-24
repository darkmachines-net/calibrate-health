/** @file Deterministic local tracking views from cached server state plus ordered durable mutation intent. */

import { findFailedMetric, metricMutationDate } from './failedMutationRecovery';
import { findFailedFood } from './failedCreation';
import type { FoodLogEntry, MetricEntry, FoodLogCreatePayload } from '@calibrate/api-client';
import type { QueuedMutation } from './queuedMutation';

type LocalCreation = { operationId: string; localId: number; operation: 'food.create' | 'metric.add'; payload: Record<string, unknown> };
export type LocalEntry = { localCreation?: LocalCreation; localOperationId?: string };
const fields = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** Local references carry the immutable original request, so receipt lookup survives parent dequeue/restart. */
export function localTarget(entry: { id: number } & LocalEntry): Record<string, unknown> {
    return JSON.parse(JSON.stringify({ id: entry.id, ...(entry.localCreation ? { localCreation: entry.localCreation, localBase: entry } : {}) })) as Record<string, unknown>;
}

/** Removes the client-only local snapshot before sending a food creation payload to the server. */
export function foodWirePayload(payload: Record<string, unknown>): FoodLogCreatePayload {
    const { localSnapshot: _snapshot, ...wire } = payload;
    return wire as FoodLogCreatePayload;
}

function localFood(reference: LocalCreation): (FoodLogEntry & LocalEntry) | null {
    const p = fields(reference.payload);
    const snapshot = fields(p.localSnapshot);
    const calories = snapshot.calories ?? p.calories ?? (typeof p.calories_per_serving_snapshot === 'number' ? Math.round(Number(p.servings_consumed ?? 1) * p.calories_per_serving_snapshot) : undefined);
    // Older queued saved-food requests may lack a local nutrition snapshot. Keep them in the review sheet, never invent zero calories.
    if (typeof calories !== 'number' || !Number.isFinite(calories)) return null;
    return {
        ...p, ...snapshot,
        id: reference.localId,
        name: snapshot.name ?? p.name ?? 'Saved food',
        calories,
        meal_period: p.meal_period,
        measure_label_snapshot: p.measure_label,
        localCreation: reference
    };
}

/** Overlay ordered durable intent on the server snapshot; never write synthetic IDs into the server cache. */
export function projectFood(entries: readonly FoodLogEntry[] | undefined, mutations: readonly QueuedMutation[], date: string): (FoodLogEntry & LocalEntry)[] | undefined {
    let result: (FoodLogEntry & LocalEntry)[] | undefined = entries ? entries.map(entry => ({ ...entry })) : undefined;
    for (const mutation of mutations) {
        const p = fields(mutation.payload);
        const reference = p.localCreation as LocalCreation | undefined;
        if (mutation.operation === 'food.create' && p.date === date) {
            result ??= [];
            const row = localFood({ operationId: mutation.id, localId: -mutation.sequence, operation: 'food.create', payload: p });
            if (row && !result.some(entry => entry.localOperationId === mutation.id)) result.push(row);
        } else if (mutation.operation === 'food.update' || mutation.operation === 'food.delete') {
            if (reference?.operation === 'food.create' && reference.payload.date === date && !result?.some(row => row.id === reference.localId || row.localOperationId === reference.operationId)) {
                result ??= [];
                const row = localFood(reference);
                if (row) result.push({ ...row, ...fields(p.localBase), id: reference.localId });
            }
            if (!result) continue;
            if (mutation.operation === 'food.delete') {
                if (!findFailedFood(mutations, { ...p, date })) result = result.filter(row => row.id !== p.id && (!reference || row.localOperationId !== reference.operationId));
            } else {
                const update = fields(p.update);
                result = result.map(row => {
                    if (row.id !== p.id && (!reference || row.localOperationId !== reference.operationId)) return row;
                    const changed = { ...row, ...update };
                    if (update.calories === undefined && typeof update.servings_consumed === 'number' && typeof row.calories_per_serving_snapshot === 'number') {
                        changed.calories = Math.round(update.servings_consumed * row.calories_per_serving_snapshot);
                    }
                    return changed;
                });
            }
        }
    }
    return result;
}

/** Projects queued weight additions and deletions onto copied server entries without mutating the cache. */
export function projectMetrics(entries: readonly MetricEntry[] | undefined, mutations: readonly QueuedMutation[]): (MetricEntry & LocalEntry)[] | undefined {
    let result: (MetricEntry & LocalEntry)[] | undefined = entries ? entries.map(entry => ({ ...entry })) : undefined;
    for (const mutation of mutations) {
        const p = fields(mutation.payload);
        if (mutation.operation === 'metric.add' && typeof p.date === 'string' && typeof p.weight === 'number') {
            result ??= [];
            const prior = result.find(row => row.date.slice(0, 10) === p.date);
            const reference: LocalCreation = prior?.localCreation ?? { operationId: mutation.id, localId: -mutation.sequence, operation: 'metric.add', payload: p };
            const entry = { id: prior?.id ?? reference.localId, date: p.date, weight: p.weight, ...(prior && !prior.localCreation ? {} : { localCreation: reference }) };
            result = [...result.filter(row => row.date.slice(0, 10) !== p.date), entry];
        } else if (mutation.operation === 'metric.delete' && mutation.state !== 'failed' && !findFailedMetric(mutations, metricMutationDate(p) ?? result?.find(row => row.id === p.id)?.date.slice(0, 10) ?? '')) {
            result = result?.filter(row => row.id !== p.id && (!p.localCreation || row.date.slice(0, 10) !== fields(fields(p.localCreation).payload).date));
        }
    }
    return result;
}

/** Detects nonfailed food changes affecting a date, consulting cached entries when a payload lacks a date. */
export function hasActiveFoodMutation(mutations: readonly QueuedMutation[], date: string, cached?: readonly FoodLogEntry[]): boolean {
    return mutations.some(mutation => {
        if (!mutation.operation.startsWith('food.') || mutation.state === 'failed') return false;
        const payload = fields(mutation.payload);
        const targetDate = payload.date ?? fields(fields(payload.localCreation).payload).date;
        return targetDate ? targetDate === date : Boolean(cached?.some(row => row.id === payload.id));
    });
}

/** Keep known receipt identities when refreshed server rows replace their local snapshot. */
export function preserveFoodReceiptIdentities(fresh: FoodLogEntry[], previous?: readonly (FoodLogEntry & LocalEntry)[]): (FoodLogEntry & LocalEntry)[] {
    return fresh.map(row => {
        const receipt = previous?.find(old => old.id === row.id)?.localOperationId;
        return receipt ? { ...row, localOperationId: receipt } : row;
    });
}
