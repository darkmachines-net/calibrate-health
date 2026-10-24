/** @file use Pending Weight Mutation: Keep server-owned calorie outputs hidden until a queued weight change replays and refetches. */

import { useOfflineOutbox } from './provider';
import { hasPendingWeightMutation } from './pendingWeight';

/** Keep server-owned calorie outputs hidden until a queued weight change replays and refetches. */
export function usePendingWeightMutation(): boolean {
    return hasPendingWeightMutation(useOfflineOutbox().mutations);
}
