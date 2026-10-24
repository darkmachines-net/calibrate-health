/** @file Durable account-deletion cleanup notices and malformed-state recovery. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const STORAGE_KEY = '@calibrate/account-deletion-cleanup-notice/v1';

export type AccountDeletionCleanupNotice = {
    version: 1;
    watchCleanupRequired: boolean;
    appDataCleanupRequired: boolean;
    credentialCleanupRequired: boolean;
};

function isNotice(value: unknown): value is AccountDeletionCleanupNotice {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const notice = value as Partial<AccountDeletionCleanupNotice>;
    return notice.version === 1
        && typeof notice.watchCleanupRequired === 'boolean'
        && typeof notice.appDataCleanupRequired === 'boolean'
        && typeof notice.credentialCleanupRequired === 'boolean';
}

/** Loads pending device-cleanup guidance and removes malformed stored notices. */
export async function readAccountDeletionCleanupNotice(): Promise<AccountDeletionCleanupNotice | null> {
    const encoded = await AsyncStorage.getItem(STORAGE_KEY);
    if (!encoded) return null;
    try {
        const notice = JSON.parse(encoded) as unknown;
        if (isNotice(notice)) return notice;
    } catch {
        // Invalid state is removed below rather than shown as recovery guidance.
    }
    await AsyncStorage.removeItem(STORAGE_KEY);
    return null;
}

/** Persists cleanup work that must remain visible after account deletion signs the user out. */
export async function writeAccountDeletionCleanupNotice(notice: AccountDeletionCleanupNotice): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(notice));
}

/** A cleanup notice is durable until the user explicitly acknowledges its recovery steps. */
export async function clearAccountDeletionCleanupNotice(): Promise<void> {
    await AsyncStorage.removeItem(STORAGE_KEY);
}

/** Builds platform-specific recovery instructions for watch, app-data, or credential cleanup failures. */
export function accountDeletionCleanupGuidance(
    notice: AccountDeletionCleanupNotice,
    platform: string = Platform.OS
): string {
    const guidance = ['Your account was deleted and this device was signed out.'];
    if (notice.watchCleanupRequired) {
        guidance.push('Open Calibrate on the watch and choose Disconnect this watch.');
    }
    if (notice.appDataCleanupRequired || notice.credentialCleanupRequired) {
        guidance.push(platform === 'ios'
            ? 'Before signing in again, delete (do not offload) and reinstall Calibrate to clear its local app data.'
            : 'Before signing in again, open Android Settings and clear Calibrate app data.');
    }
    return guidance.join(' ');
}

/** Prevent any new authenticated account scope until the user confirms local recovery is complete. */
export function assertAccountDeletionCleanupAcknowledged(
    notice: AccountDeletionCleanupNotice | null
): void {
    if (notice) {
        throw new Error('Complete and acknowledge the deleted-account device cleanup steps before continuing.');
    }
}
