/** @file tracking Receipts: Persist acknowledged rows before removing their durable intent, including partial replay failures. */

import type { QueryClient } from '@tanstack/react-query';
import type { FoodLogEntry, MetricEntry } from '@calibrate/api-client';
import type { QueuedMutation } from './queuedMutation';
import type { LocalEntry } from './trackingProjection';

/** Persist acknowledged rows before removing their durable intent, including partial replay failures. */
export function applyTrackingReceipt(client: QueryClient, mutation: QueuedMutation, response: unknown) {
    const payload = mutation.payload as Record<string, any>;
    const result = response as Record<string, any>;
    if (mutation.operation.startsWith('food-day.') || mutation.operation.startsWith('food-tracking-pause.')) {
        if (result.day) client.setQueryData(['mobile-food-day', result.day.date], result.day);
        if (result.pause) client.setQueryData(['mobile-food-tracking-pause'], { pause: result.pause });
    } else if (mutation.operation === 'food.create') {
        client.setQueryData<(FoodLogEntry & LocalEntry)[]>(['mobile-food', payload.date], rows => [
            ...(rows ?? []).filter(row => row.id !== result.id),
            { ...result, localOperationId: mutation.id } as FoodLogEntry & LocalEntry
        ]);
    } else if (mutation.operation === 'food.update' || mutation.operation === 'food.delete') {
        client.setQueriesData<(FoodLogEntry & LocalEntry)[]>({ queryKey: ['mobile-food'] }, rows => rows?.flatMap(row => {
            if (row.id !== result.id) return [row];
            return mutation.operation === 'food.delete' ? [] : [{ ...row, ...result }];
        }));
    } else if (mutation.operation === 'metric.add') {
        client.setQueryData<MetricEntry[]>(['mobile-metrics'], rows => [
            ...(rows ?? []).filter(row => row.date.slice(0, 10) !== payload.date), result as MetricEntry
        ]);
    } else if (mutation.operation === 'metric.delete') {
        client.setQueryData<MetricEntry[]>(['mobile-metrics'], rows => rows?.filter(row => row.id !== result.id));
    }
}
