/** @file account Cleanup: Explicit deletion cleanup opens the account namespace without replaying it. */

import { openOutboxDatabase } from './database';
import { SqliteOutbox } from './outbox';
import { createOutboxNamespace } from './queuedMutation';

/** Explicit deletion cleanup opens the account namespace without replaying it. */
export async function clearOfflineOutboxAccountData(serverUrl: string, userId: number): Promise<void> {
    const database = await openOutboxDatabase();
    const outbox = new SqliteOutbox(database, createOutboxNamespace(serverUrl, userId));
    await outbox.clear();
}
