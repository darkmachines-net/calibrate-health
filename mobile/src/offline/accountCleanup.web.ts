/** @file account Cleanup: Explicit deletion cleanup opens the account namespace without replaying it. */

import { IndexedDbOutbox, openBrowserOutboxDatabase } from './indexedDbOutbox.web';
import { createOutboxNamespace } from './queuedMutation';

/** Explicit deletion cleanup opens the account namespace without replaying it. */
export async function clearOfflineOutboxAccountData(serverUrl: string, userId: number): Promise<void> {
    const database = await openBrowserOutboxDatabase();
    try {
        const outbox = new IndexedDbOutbox(database, createOutboxNamespace(serverUrl, userId));
        await outbox.clear();
    } finally {
        database.close();
    }
}
