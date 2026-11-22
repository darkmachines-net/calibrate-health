/** @file Shared account-export validation, deletion confirmation, and cleanup dependency contracts. */

import type { AccountExport } from '@calibrate/api-client';
import type { AccountDeletionCleanupNotice } from './accountDeletionNotice';

export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE MY ACCOUNT';
export const ACCOUNT_EXPORT_MIME_TYPE = 'application/json';

const FORBIDDEN_EXPORT_KEYS = new Set([
    'password',
    'password_hash',
    'access_token',
    'refresh_token',
    'session_token'
]);

export type AccountDeletionDependencies = {
    /** Delete the server account using the supplied password; rejection prevents local cleanup. */
    deleteRemoteAccount: (currentPassword: string) => Promise<void>;
    /** Remove queued account-scoped mutations from the device. */
    discardOfflineChanges: () => Promise<void>;
    /** Remove locally stored Health Connect account data. */
    clearHealthConnectData: () => Promise<void>;
    /** Remove paired Wear account data, including on the watch where reachable. */
    clearWearData: () => Promise<void>;
    /** Persist instructions for cleanup that could not be completed after deletion. */
    persistCleanupNotice: (notice: AccountDeletionCleanupNotice) => Promise<void>;
    /** Remove local session credentials and account-scoped state after server deletion. */
    clearLocalSession: () => Promise<void>;
};

function assertNoCredentialFields(value: unknown, seen: Set<object>): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
        value.forEach((item) => assertNoCredentialFields(item, seen));
        return;
    }

    Object.entries(value).forEach(([key, nestedValue]) => {
        if (FORBIDDEN_EXPORT_KEYS.has(key.toLowerCase())) {
            throw new Error('Account export unexpectedly contained credential data.');
        }
        assertNoCredentialFields(nestedValue, seen);
    });
}

/** Reject any forbidden credential field in the export before serializing its JSON. */
export function serializeAccountExport(accountExport: AccountExport): string {
    assertNoCredentialFields(accountExport, new Set());
    return JSON.stringify(accountExport, null, 2);
}

/** Enables deletion only after a password is supplied and the exact confirmation phrase matches. */
export function canSubmitAccountDeletion(currentPassword: string, confirmation: string): boolean {
    return currentPassword.length > 0 && confirmation === DELETE_ACCOUNT_CONFIRMATION;
}

/** Build a JSON export filename from the UTC date, using the current UTC date for an invalid timestamp. */
export function buildAccountExportFilename(exportedAt: string): string {
    const parsed = new Date(exportedAt);
    const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    return `calibrate-account-export-${date.toISOString().slice(0, 10)}.json`;
}
