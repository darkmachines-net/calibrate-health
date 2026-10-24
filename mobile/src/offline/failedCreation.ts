/** @file failed Creation: Caller supplies only the active account/server queue; synthetic IDs alone never identify a creation. */

import type { QueuedMutation } from './queuedMutation';

type FoodTarget = { id?: number; date?: string; localCreation?: { operationId?: string; payload?: { date?: unknown } } };
const target = (row: QueuedMutation): FoodTarget => {
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as FoodTarget : {};
    if (row.operation === 'food.create') return { date: payload.date, localCreation: { operationId: row.id } };
    return payload;
};
function sameTarget(a: FoodTarget, b: FoodTarget): boolean {
    const firstDate = a.date ?? a.localCreation?.payload?.date;
    const secondDate = b.date ?? b.localCreation?.payload?.date;
    if (firstDate && secondDate && firstDate !== secondDate) return false;
    if (a.localCreation?.operationId && b.localCreation?.operationId) return a.localCreation.operationId === b.localCreation.operationId;
    return typeof a.id === 'number' && a.id > 0 && a.id === b.id;
}
const isFood = (row: QueuedMutation) => ['food.create', 'food.update', 'food.delete'].includes(row.operation);

/** Caller supplies only the active account/server queue; synthetic IDs alone never identify a creation. */
export function findFailedFood(rows: readonly QueuedMutation[], entry: FoodTarget): QueuedMutation | undefined {
    return rows.find(row => isFood(row) && row.state === 'failed' && sameTarget(target(row), entry));
}

/** Explicitly discard one failed entry's intent chain; never delete a server record or unrelated queue. */
export function failedFoodDiscardIds(rows: readonly QueuedMutation[], id: string): string[] {
    const parent = rows.find(row => row.id === id);
    if (!parent || !isFood(parent) || parent.state !== 'failed') throw new Error('The failed entry changed. Refresh and review it again.');
    const affected = rows.filter(row => row.namespace === parent.namespace && isFood(row) && (row.id === id || sameTarget(target(row), target(parent))));
    if (affected.some(row => row.state === 'replaying')) throw new Error('This entry is currently syncing. Try again when it finishes.');
    return affected.map(row => row.id);
}
