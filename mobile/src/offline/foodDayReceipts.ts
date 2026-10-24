/** @file Durable food-day intent receipts and acknowledged-state reconciliation during offline replay. */

const storage = (): typeof import('@react-native-async-storage/async-storage').default => {
    const module = require('@react-native-async-storage/async-storage');
    return module.default ?? module;
};
import type { FoodLogDay, FoodLogDayRange, FoodTrackingPause } from '@calibrate/api-client';
import type { QueuedMutation } from './queuedMutation';
import { withMutationLock } from './mutationLock';

const PREFIX = '@calibrate/food-day-receipts/v1/';
const key = (namespace: string) => PREFIX + encodeURIComponent(namespace);
type Journal = { version: 1; sequence: number; rows: (QueuedMutation & { receiptOperationId: string })[] };
async function read(namespace: string): Promise<Journal> {
    const raw = await storage().getItem(key(namespace));
    if (!raw) return { version: 1, sequence: 0, rows: [] };
    const parsed = JSON.parse(raw) as Journal;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.sequence) || !Array.isArray(parsed.rows) || parsed.rows.some(row => row.namespace !== namespace)) throw new Error('Saved tracking state is invalid. Reconnect before changing food.');
    return parsed;
}
/** Reads persisted completed day intents that protect local presentation during synchronization. */
export async function readFoodDayReceipts(namespace: string): Promise<QueuedMutation[]> { return (await read(namespace)).rows; }

/** Call under the namespace lock, before acknowledging a control or removing its queued row. */
export async function recordFoodDayReceipt(namespace: string, operation: string, payload: unknown, id: string): Promise<void> {
    const p = payload as Record<string, unknown>;
    if (!p || typeof p !== 'object') return;
    const date = operation === 'food-tracking-pause.start' ? p.starts_on : operation === 'food-tracking-pause.resume' ? p.resumed_on : p.date;
    if (typeof date !== 'string' || !['food-day.set-status', 'food-day.update', 'food-tracking-pause.start', 'food-tracking-pause.resume'].includes(operation)) return;
    const journal = await read(namespace);
    const receiptKey = operation.startsWith('food-day.') ? 'day:' + date : operation + ':' + date;
    const receiptId = 'receipt:' + receiptKey;
    const prior = journal.rows.find(row => row.id === receiptId);
    if (prior?.receiptOperationId === id && !id.startsWith('server-read:')) return;
    const sequence = journal.sequence + 1;
    const next: QueuedMutation & { receiptOperationId: string } = { sequence, id: receiptId, namespace, operation, payload: payload as QueuedMutation['payload'], state: 'pending', attemptCount: 0, lastError: null, receiptOperationId: id, createdAt: sequence, updatedAt: sequence };
    await storage().setItem(key(namespace), JSON.stringify({ version: 1, sequence, rows: [...journal.rows.filter(row => row.id !== receiptId), next] }));
}

/** Serialize the authoritative read with controls so an older response cannot erase a later acknowledgement. */
export function readAndRecordFoodDay(namespace: string, date: string, fetch: () => Promise<FoodLogDay>): Promise<FoodLogDay> {
    return withMutationLock(namespace, async exclusive => {
        const day = await fetch();
        if (exclusive) await recordFoodDayReceipt(namespace, 'food-day.set-status', { date, status: day.status }, 'server-read:' + Date.now() + ':' + day.status);
        return day;
    });
}

/** A fresh pause snapshot replaces only pause-derived history, never a separately verified day. */
export async function recordCurrentPauseReceipt(namespace: string, pause: FoodTrackingPause, id: string): Promise<void> {
    const journal = await read(namespace);
    const sequence = journal.sequence + 1;
    const rows = journal.rows.filter(row => !row.operation.startsWith('food-tracking-pause.'));
    rows.push({ sequence, id: 'receipt:pause-snapshot', namespace, operation: 'food-tracking-pause.snapshot', payload: { pause }, state: 'pending', attemptCount: 0, lastError: null, receiptOperationId: id, createdAt: sequence, updatedAt: sequence });
    // Refreshing the same pause is not a new start command. Keep its position before
    // later verified days/backfills; a direct new start already owns a later position.
    const priorStart = journal.rows.findLastIndex(row => row.operation === 'food-tracking-pause.start'
        && (row.payload as Record<string, unknown>).starts_on === pause.starts_on);
    const insertion = priorStart < 0 ? 0 : journal.rows.slice(0, priorStart).filter(row => !row.operation.startsWith('food-tracking-pause.')).length;
    if (pause.active && pause.starts_on) rows.splice(insertion, 0, {
        sequence, id: 'receipt:current-pause', namespace, operation: 'food-tracking-pause.start',
        payload: { starts_on: pause.starts_on }, state: 'pending', attemptCount: 0, lastError: null,
        receiptOperationId: id, createdAt: sequence, updatedAt: sequence
    });
    await storage().setItem(key(namespace), JSON.stringify({ version: 1, sequence, rows }));
}

/** Ordinary pause refreshes use the same ordering as replay and direct controls. */
export function readAndRecordFoodPause(namespace: string, fetch: () => Promise<{ pause: FoodTrackingPause }>): Promise<{ pause: FoodTrackingPause }> {
    return withMutationLock(namespace, async exclusive => {
        const result = await fetch();
        if (exclusive) await recordCurrentPauseReceipt(namespace, result.pause, 'server-read:pause:' + Date.now());
        return result;
    });
}

/** Range snapshots obey the same lock and receipt ordering as individual day reads. */
export function readAndRecordFoodDays(namespace: string, fetch: () => Promise<FoodLogDayRange>): Promise<FoodLogDayRange> {
    return withMutationLock(namespace, async exclusive => {
        const range = await fetch();
        if (exclusive) {
            for (const day of range.days) {
                await recordFoodDayReceipt(namespace, 'food-day.set-status', { date: day.date, status: day.status }, 'server-read:range:' + Date.now() + ':' + day.status);
            }
        }
        return range;
    });
}
