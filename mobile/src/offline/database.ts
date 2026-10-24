/** @file database: Opens the process-wide SQLite connection used by every authenticated outbox namespace. */

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

const OUTBOX_DATABASE_NAME = 'calibrate-offline.db';
const OUTBOX_SCHEMA_VERSION = 1;

export type OutboxDatabase = Pick<
    SQLiteDatabase,
    'execAsync' | 'getAllAsync' | 'getFirstAsync' | 'runAsync' | 'withExclusiveTransactionAsync'
>;

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function initializeDatabase(database: SQLiteDatabase): Promise<SQLiteDatabase> {
    await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS queued_mutations (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            namespace TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'replaying', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS queued_mutations_replay_order
            ON queued_mutations(namespace, state, sequence);
        PRAGMA user_version = ${OUTBOX_SCHEMA_VERSION};
    `);
    return database;
}

/** Opens the process-wide SQLite connection used by every authenticated outbox namespace. */
export function openOutboxDatabase(): Promise<SQLiteDatabase> {
    if (!databasePromise) {
        databasePromise = openDatabaseAsync(OUTBOX_DATABASE_NAME).then(initializeDatabase).catch((error) => {
            databasePromise = null;
            throw error;
        });
    }
    return databasePromise;
}
