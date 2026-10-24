/** @file pending Weight: Reports queued weight additions or deletions that make the displayed server trend stale. */

import { OFFLINE_MUTATION_OPERATIONS } from './operations';
import type { QueuedMutation } from './queuedMutation';

/** Reports queued weight additions or deletions that make the displayed server trend stale. */
export function hasPendingWeightMutation(
    mutations: ReadonlyArray<Pick<QueuedMutation, 'operation'>>
): boolean {
    return mutations.some(({ operation }) =>
        operation === OFFLINE_MUTATION_OPERATIONS.ADD_METRIC ||
        operation === OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC
    );
}
