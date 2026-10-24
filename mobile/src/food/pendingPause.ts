/** @file pending Pause: Keep accepted local pause intent visible while canonical reads catch up with replay. */

import type { FoodTrackingPause } from '@calibrate/api-client';
import { OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';
import { OUTBOX_MUTATION_STATES, type QueuedMutation } from '../offline/queuedMutation';

/** Keep accepted local pause intent visible while canonical reads catch up with replay. */
export function applyQueuedPauseIntent(pause: FoodTrackingPause | undefined, mutations: readonly QueuedMutation[], namespace: string | null) {
    let value = pause;
    let hasQueuedIntent = false;
    for (const mutation of [...mutations].sort((a, b) => a.sequence - b.sequence)) {
        if (!namespace || mutation.namespace !== namespace || mutation.state === OUTBOX_MUTATION_STATES.FAILED) continue;
        const payload = mutation.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        if (mutation.operation === 'food-tracking-pause.snapshot' && payload.pause && typeof payload.pause === 'object' && !Array.isArray(payload.pause) && typeof payload.pause.active === 'boolean') {
            value = payload.pause as FoodTrackingPause;
        } else if (mutation.operation === OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE
            && typeof payload.starts_on === 'string'
            && (payload.expected_resume_on === null || typeof payload.expected_resume_on === 'string')) {
            value = { active: true, id: null, starts_on: payload.starts_on, expected_resume_on: payload.expected_resume_on,
                resumed_on: null, started_at: null, resumed_at: null, materialized_through: payload.starts_on, resume_confirmation_due: false };
            hasQueuedIntent = true;
        } else if (mutation.operation === OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE
            && (payload.expected_resume_on === null || typeof payload.expected_resume_on === 'string')) {
            if (value?.active) value = { ...value, expected_resume_on: payload.expected_resume_on, resume_confirmation_due: false };
            hasQueuedIntent = true;
        } else if (mutation.operation === OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING && typeof payload.resumed_on === 'string') {
            value = { id: null, starts_on: null, expected_resume_on: null, started_at: null, resumed_at: null, materialized_through: null, ...value, active: false, resumed_on: payload.resumed_on, resume_confirmation_due: false };
            hasQueuedIntent = true;
        }
    }
    return { pause: value, hasQueuedIntent };
}
