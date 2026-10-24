/** @file mutation Dispatch: Read durable state under the same lock used by all direct attempts and enqueue producers. */

import { readFoodDayReceipts, recordFoodDayReceipt } from './foodDayReceipts';
import { withMutationLock } from './mutationLock';
import type { QueuedMutation } from './queuedMutation';

type Enqueue = (operation: string, payload: unknown, operationId?: string) => Promise<unknown>;
export type OutboxDispatch = <T>(work: (enqueue: Enqueue, mustQueue: boolean, pending: readonly QueuedMutation[], record: (operation: string, payload: unknown, id: string) => Promise<void>) => Promise<T>) => Promise<T>;

/** Read durable state under the same lock used by all direct attempts and enqueue producers. */
export function createOutboxDispatch(namespace: string, list: () => Promise<QueuedMutation[]>, enqueue: Enqueue, isCurrent: () => boolean, receipts = false, onReceipts?: (rows: QueuedMutation[]) => void): OutboxDispatch {
    return work => withMutationLock(namespace, async exclusive => {
        if (!isCurrent()) throw new Error('The tracking account changed. Reopen this action.');
        const pending = await list();
        if (!isCurrent()) throw new Error('The tracking account changed. Reopen this action.');
        const acknowledged = receipts ? await readFoodDayReceipts(namespace) : [];
        if (!isCurrent()) throw new Error('The tracking account changed. Reopen this action.');
        onReceipts?.(acknowledged);
        return work(enqueue, !exclusive || pending.length > 0, [...acknowledged, ...pending], receipts ? (operation, payload, id) => recordFoodDayReceipt(namespace, operation, payload, id) : async () => undefined);
    });
}
