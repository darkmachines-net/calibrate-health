/** @file copy Food When Synchronized: Copy reads server source data; keep its queue check and request under one namespace lock. */

import { OfflineMutationConflict } from '../offline/mutationConflict';
import type { OutboxDispatch } from '../offline/mutationDispatch';
/** Copy reads server source data; keep its queue check and request under one namespace lock. */
export function copyFoodWhenSynchronized<T>(withOutbox: OutboxDispatch, copy: () => Promise<T>): Promise<T> {
    return withOutbox(async (_enqueue, mustQueue) => {
        if (mustQueue) throw new OfflineMutationConflict('copy');
        return copy();
    });
}
