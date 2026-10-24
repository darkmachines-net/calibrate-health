/** @file account Cleanup: Revoke Android access and remove every device-local value scoped to the deleted server account. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { disconnectHealthConnect } from './native';
import {
    healthConnectLastSuccessStorageKey,
    healthConnectPreferencesStorageKey
} from './preferences';
import { clearHealthConnectSyncStorage } from './sync';

type HealthConnectCleanupDependencies = {
    revokePermissions: () => Promise<unknown>;
    removeItem: (key: string) => Promise<void>;
    clearSyncStorage: (serverUrl: string, userId: number) => Promise<void>;
};

/** Revoke Android access and remove every device-local value scoped to the deleted server account. */
export async function clearHealthConnectAccountData(
    serverUrl: string,
    userId: number,
    dependencies: HealthConnectCleanupDependencies = {
        revokePermissions: disconnectHealthConnect,
        removeItem: (key) => AsyncStorage.removeItem(key),
        clearSyncStorage: clearHealthConnectSyncStorage
    }
): Promise<void> {
    const results = await Promise.allSettled([
        dependencies.revokePermissions(),
        dependencies.removeItem(healthConnectPreferencesStorageKey(serverUrl, userId)),
        dependencies.removeItem(healthConnectLastSuccessStorageKey(serverUrl, userId)),
        dependencies.clearSyncStorage(serverUrl, userId)
    ]);
    if (results.some(({ status }) => status === 'rejected')) {
        throw new Error('Health Connect permissions or local sync state could not be fully cleared.');
    }
}
