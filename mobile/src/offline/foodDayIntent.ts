/** @file food Day Intent: Fold only explicit queued control intent, in durable order, without inventing a server snapshot. */

import { OfflineMutationConflict } from './mutationConflict';
import type { QueuedMutation } from './queuedMutation';

type DayStatus = 'OPEN' | 'COMPLETE' | 'INCOMPLETE' | 'PAUSED';
const fields = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Fold only explicit queued control intent, in durable order, without inventing a server snapshot. */
export function queuedFoodDayStatus(rows: readonly QueuedMutation[], date: string, initial?: DayStatus): DayStatus | undefined {
    let status = initial;
    for (const row of rows) {
        const p = fields(row.payload);
        const dayControl = (row.operation === 'food-day.set-status' || row.operation === 'food-day.update') && p.date === date;
        const pause = row.operation === 'food-tracking-pause.start' && typeof p.starts_on === 'string' && date >= p.starts_on;
        const resume = row.operation === 'food-tracking-pause.resume' && typeof p.resumed_on === 'string' && date >= p.resumed_on;
        if (!(dayControl || pause || resume)) continue;
        if (row.state === 'failed') throw new Error('Resolve the failed tracking change in Review saved changes before changing food.');
        if (pause) status = 'PAUSED';
        if (resume && (date === p.resumed_on || status === 'PAUSED' || status === undefined)) status = 'OPEN';
        // Only a deliberate paused-day backfill or fresh server receipt may override a pause.
        const explicitBackfill = row.operation === 'food-day.set-status' && p.status === 'OPEN' && p.explicitPausedBackfill === true;
        if (dayControl && status === 'PAUSED' && !row.id.startsWith('receipt:') && !explicitBackfill) continue;
        if (dayControl && row.operation === 'food-day.update') status = p.is_complete ? 'COMPLETE' : 'OPEN';
        if (dayControl && row.operation === 'food-day.set-status' && ['OPEN', 'COMPLETE', 'INCOMPLETE', 'PAUSED'].includes(String(p.status))) status = p.status as DayStatus;
    }
    return status;
}

/** Editing, deleting and barcode submission never silently reopen a day changed by another tab. */
export function assertQueuedFoodDayOpen(rows: readonly QueuedMutation[], operation: string, payload: unknown): void {
    if (!['food.create', 'food.update', 'food.delete'].includes(operation)) return;
    const p = fields(payload);
    const date = p.date ?? fields(fields(p.localCreation).payload).date;
    if (typeof date !== 'string') {
        if (rows.some(row => row.operation.startsWith('food-day.') || row.operation.startsWith('food-tracking-pause.'))) throw new Error('Refresh this food entry and its day before changing it.');
        return;
    }
    const status = queuedFoodDayStatus(rows, date);
    if (status && status !== 'OPEN') throw new Error('The day changed in another action. Reopen or resume the day explicitly before changing food.');
}

/** A stale day button cannot silently override a pause saved by another producer. */
export function assertQueuedDayTransition(rows: readonly QueuedMutation[], operation: string, payload: unknown): void {
    if (!['food-day.set-status', 'food-day.update'].includes(operation)) return;
    const p = fields(payload);
    if (typeof p.date !== 'string') return;
    if (queuedFoodDayStatus(rows, p.date) !== 'PAUSED') return;
    if (operation === 'food-day.set-status' && p.status === 'OPEN' && p.explicitPausedBackfill === true) return;
    throw new OfflineMutationConflict('pausedDay');
}
