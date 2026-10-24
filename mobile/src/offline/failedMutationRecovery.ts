/** @file Related-mutation recovery grouping and safe retry/discard boundaries for failed offline intent. */

import { OfflineMutationConflict } from './mutationConflict';
import { validatePauseTransition } from './pauseIntent';
import { assertQueuedDayTransition, assertQueuedFoodDayOpen } from './foodDayIntent';
import type { NewQueuedMutation, QueuedMutation } from './queuedMutation';
import type { OfflineMutationOperation } from './mutationKinds';
import { failedFoodDiscardIds } from './failedCreation';

const families: Record<OfflineMutationOperation, 'food' | 'metric' | 'control'> = {
    'food.create': 'food', 'food.update': 'food', 'food.delete': 'food',
    'metric.add': 'metric', 'metric.delete': 'metric',
    'food-day.update': 'control', 'food-day.set-status': 'control',
    'food-tracking-pause.start': 'control', 'food-tracking-pause.update': 'control', 'food-tracking-pause.resume': 'control'
};
const fields = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Extracts the local date from a metric mutation or its retained creation/base snapshot. */
export function metricMutationDate(payload: unknown): string | null {
    const p = fields(payload);
    const date = p.date ?? fields(fields(p.localCreation).payload).date ?? fields(p.localBase).date;
    return typeof date === 'string' ? date.slice(0, 10) : null;
}
const family = (operation: string) => families[operation as OfflineMutationOperation];
function related(parent: QueuedMutation, row: QueuedMutation): boolean {
    if (row.namespace !== parent.namespace) return false;
    if (row.id === parent.id) return true;
    if (family(parent.operation) !== family(row.operation)) return false;
    if (family(parent.operation) === 'food') return failedFoodDiscardIds([parent, { ...row, state: 'pending' }], parent.id).includes(row.id);
    if (family(parent.operation) === 'metric') {
        const a = metricMutationDate(parent.payload), b = metricMutationDate(row.payload);
        if (a && b) return a === b;
        const first = fields(parent.payload), second = fields(row.payload);
        return typeof first.id === 'number' && first.id > 0 && first.id === second.id;
    }
    // Pause/resume can span days. Review all queued tracking-control intent together, never food/weight records.
    return family(parent.operation) === 'control';
}
/** Finds a failed weight mutation affecting the requested date, including failures with unknown dates. */
export function findFailedMetric(rows: readonly QueuedMutation[], date: string): QueuedMutation | undefined {
    return rows.find(row => row.state === 'failed' && family(row.operation) === 'metric' && (!metricMutationDate(row.payload) || metricMutationDate(row.payload) === date));
}
/** Returns the related failed mutation IDs safe to discard and rejects changed or actively replaying work. */
export function failedMutationDiscardIds(rows: readonly QueuedMutation[], id: string): string[] {
    const parent = rows.find(row => row.id === id);
    if (!parent || parent.state !== 'failed') throw new Error('The failed change changed. Refresh and review it again.');
    const affected = rows.filter(row => related(parent, row));
    if (affected.some(row => row.state === 'replaying')) throw new Error('These changes are currently syncing. Try again when they finish.');
    return affected.map(row => row.id);
}
/** Runs inside the same transaction as insertion. Never acknowledge an unreachable correction as saved. */
export function assertRecoverableEnqueue(rows: readonly QueuedMutation[], mutation: NewQueuedMutation, namespace: string): void {
    if (validatePauseTransition(rows.filter(row => row.namespace === namespace), mutation.operation, mutation.payload)) throw new OfflineMutationConflict('duplicate');
    assertQueuedDayTransition(rows.filter(row => row.namespace === namespace), mutation.operation, mutation.payload);
    assertQueuedFoodDayOpen(rows.filter(row => row.namespace === namespace), mutation.operation, mutation.payload);
    const candidate = { id: mutation.id ?? '__new__', namespace, operation: mutation.operation, payload: mutation.payload, state: 'pending' } as QueuedMutation;
    const failed = rows.find(row => row.state === 'failed' && row.namespace === namespace && (
        related(row, candidate) || (family(row.operation) === 'metric' && family(candidate.operation) === 'metric' && !metricMutationDate(row.payload))
    ));
    if (failed) throw new Error('Resolve the failed related change in Review saved changes before saving this correction. Your existing changes are still on this device.');
}
