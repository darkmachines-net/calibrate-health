/** @file account Data: Download a browser Blob directly; Expo Sharing and cache-file APIs are native-only. */

import type { AccountExport } from '@calibrate/api-client';
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

/** Download a browser Blob directly; Expo Sharing and cache-file APIs are native-only. */
export async function shareAccountExport(accountExport: AccountExport): Promise<void> {
    const blob = new Blob([serializeAccountExport(accountExport)], { type: ACCOUNT_EXPORT_MIME_TYPE });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = buildAccountExportFilename(accountExport.exported_at);
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
}

/** Browser logout has no device credentials or native account scopes to clean up. */
export async function deleteAccountAndClearLocalData(
    currentPassword: string,
    dependencies: AccountDeletionDependencies
): Promise<void> {
    await dependencies.deleteRemoteAccount(currentPassword);
    await Promise.allSettled([
        dependencies.discardOfflineChanges(),
        dependencies.clearHealthConnectData(),
        dependencies.clearWearData()
    ]);
    await dependencies.clearLocalSession();
}
