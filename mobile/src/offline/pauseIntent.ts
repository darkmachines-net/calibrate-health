/** @file pause Intent: Fold acknowledged state then durable pending intent before accepting any pause transition. */

import { OfflineMutationConflict } from './mutationConflict';
import type { QueuedMutation } from './queuedMutation';
import { OFFLINE_MUTATION_OPERATIONS as K } from './mutationKinds';
const fields = (p: unknown): Record<string, unknown> => p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
const controls = new Set<string>([K.START_FOOD_TRACKING_PAUSE, K.UPDATE_FOOD_TRACKING_PAUSE, K.RESUME_FOOD_TRACKING]);

/** Fold acknowledged state then durable pending intent before accepting any pause transition. */
export function validatePauseTransition(rows: readonly QueuedMutation[], operation: string, payload: unknown): QueuedMutation | undefined {
    if (!controls.has(operation)) return;
    let active: boolean | undefined;
    let lastPending: QueuedMutation | undefined;
    for (const row of rows) {
        if (!controls.has(row.operation) && row.operation !== 'food-tracking-pause.snapshot') continue;
        if (row.state === 'failed') throw new OfflineMutationConflict('failed');
        const p = fields(row.payload);
        if (row.operation === 'food-tracking-pause.snapshot') {
            const snapshot = fields(p.pause);
            if (typeof snapshot.active === 'boolean') active = snapshot.active;
        } else {
            if (row.operation === K.START_FOOD_TRACKING_PAUSE) active = true;
            if (row.operation === K.RESUME_FOOD_TRACKING) active = false;
            if (!row.id.startsWith('receipt:')) lastPending = row;
        }
    }
    const next = fields(payload), prior = fields(lastPending?.payload);
    const keys = operation === K.START_FOOD_TRACKING_PAUSE ? ['starts_on', 'expected_resume_on'] : operation === K.RESUME_FOOD_TRACKING ? ['resumed_on'] : ['expected_resume_on'];
    if (lastPending?.operation === operation && keys.every(key => next[key] === prior[key])) return lastPending;
    if (operation === K.START_FOOD_TRACKING_PAUSE && active === true) throw new OfflineMutationConflict('active');
    if (operation !== K.START_FOOD_TRACKING_PAUSE && active === false) {
        if (lastPending?.operation === K.RESUME_FOOD_TRACKING) throw new OfflineMutationConflict('pending');
        throw new OfflineMutationConflict('inactive');
    }
}
