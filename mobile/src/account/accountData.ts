/** @file account Data: Prevent an unavailable platform service from retaining deleted-account credentials indefinitely. */

import type { AccountExport } from '@calibrate/api-client';
import type { AccountDeletionCleanupNotice } from './accountDeletionNotice';
import {
    ACCOUNT_EXPORT_MIME_TYPE,
    buildAccountExportFilename,
    type AccountDeletionDependencies,
    serializeAccountExport
} from './accountData.shared';

export {
    canSubmitAccountDeletion,
    DELETE_ACCOUNT_CONFIRMATION,
    serializeAccountExport
} from './accountData.shared';

const DEVICE_CLEANUP_TIMEOUT_MS = 10_000;

type ShareFile = {
    uri: string;
    exists: boolean;
    create: (options?: { overwrite?: boolean }) => void;
    write: (content: string) => Promise<void>;
    delete: () => void;
};

type AccountExportSharingDependencies = {
    isSharingAvailable: () => Promise<boolean>;
    createCacheFile: (filename: string) => ShareFile;
    share: (uri: string, options: { mimeType: string; dialogTitle: string }) => Promise<void>;
};

async function loadSharingDependencies(): Promise<AccountExportSharingDependencies> {
    const [fileSystem, Sharing] = await Promise.all([
        import('expo-file-system'),
        import('expo-sharing')
    ]);
    return {
        isSharingAvailable: Sharing.isAvailableAsync,
        createCacheFile: (filename) => new fileSystem.File(fileSystem.Paths.cache, filename),
        share: Sharing.shareAsync
    };
}

function cleanupNotice(results: PromiseSettledResult<void>[]): AccountDeletionCleanupNotice | null {
    const offlineFailed = results[0]?.status === 'rejected';
    const healthConnectFailed = results[1]?.status === 'rejected';
    const wearResult = results[2];
    const wearFailed = wearResult?.status === 'rejected';
    if (!offlineFailed && !healthConnectFailed && !wearFailed) return null;
    const wearReason = wearResult?.status === 'rejected' ? wearResult.reason : null;
    const unreachableWatch = wearReason instanceof Error && /watch was unreachable/i.test(wearReason.message);
    return {
        version: 1,
        watchCleanupRequired: wearFailed,
        appDataCleanupRequired: offlineFailed || healthConnectFailed || (wearFailed && !unreachableWatch),
        credentialCleanupRequired: false
    };
}

/** Prevent an unavailable platform service from retaining deleted-account credentials indefinitely. */
async function withCleanupTimeout(cleanup: () => Promise<void>): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            Promise.resolve().then(cleanup),
            new Promise<void>((_resolve, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error('Device cleanup timed out.')),
                    DEVICE_CLEANUP_TIMEOUT_MS
                );
            })
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

/** Attempts every account-scoped cleanup and always clears credentials after confirmed server deletion. */
export async function deleteAccountAndClearLocalData(
    currentPassword: string,
    dependencies: AccountDeletionDependencies
): Promise<void> {
    await Promise.resolve().then(() => dependencies.deleteRemoteAccount(currentPassword));
    const cleanupResults = await Promise.allSettled([
        withCleanupTimeout(dependencies.discardOfflineChanges),
        withCleanupTimeout(dependencies.clearHealthConnectData),
        withCleanupTimeout(dependencies.clearWearData)
    ]);
    const notice = cleanupNotice(cleanupResults);
    if (notice) {
        await Promise.resolve().then(() => dependencies.persistCleanupNotice(notice)).catch(() => undefined);
    }

    const sessionResult = await Promise.allSettled([
        withCleanupTimeout(dependencies.clearLocalSession)
    ]);
    if (sessionResult[0].status === 'rejected') {
        await Promise.resolve().then(() => dependencies.persistCleanupNotice({
            version: 1,
            watchCleanupRequired: notice?.watchCleanupRequired ?? false,
            appDataCleanupRequired: true,
            credentialCleanupRequired: true
        })).catch(() => undefined);
        throw new Error('Account deleted, but local sign-in credentials could not be cleared. Follow the device cleanup guidance before signing in again.');
    }
}

/** Shares a short-lived cache file and removes it whether sharing succeeds or fails. */
export async function shareAccountExport(
    accountExport: AccountExport,
    dependencies?: AccountExportSharingDependencies
): Promise<void> {
    const sharingDependencies = dependencies ?? await loadSharingDependencies();
    if (!(await sharingDependencies.isSharingAvailable())) {
        throw new Error('File sharing is unavailable on this device.');
    }

    const file = sharingDependencies.createCacheFile(buildAccountExportFilename(accountExport.exported_at));
    try {
        file.create({ overwrite: true });
        await file.write(serializeAccountExport(accountExport));
        await sharingDependencies.share(file.uri, {
            mimeType: ACCOUNT_EXPORT_MIME_TYPE,
            dialogTitle: 'Share calibrate account export'
        });
    } finally {
        if (file.exists) file.delete();
    }
}
