/** @file Regression coverage for account Cleanup: Health Connect account cleanup. */

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import { clearHealthConnectAccountData } from './accountCleanup';
import {
    healthConnectLastSuccessStorageKey,
    healthConnectPreferencesStorageKey
} from './preferences';

describe('Health Connect account cleanup', () => {
    const removeItem = jest.fn(async () => undefined);
    const revokePermissions = jest.fn(async () => undefined);
    const clearSyncStorage = jest.fn(async () => undefined);

    beforeEach(() => jest.clearAllMocks());

    it('revokes access and removes preferences, last success, and checkpoints for one account', async () => {
        await clearHealthConnectAccountData('https://health.example/', 7, {
            removeItem, revokePermissions, clearSyncStorage
        });

        expect(revokePermissions).toHaveBeenCalledTimes(1);
        expect(removeItem).toHaveBeenCalledWith(healthConnectPreferencesStorageKey('https://health.example/', 7));
        expect(removeItem).toHaveBeenCalledWith(healthConnectLastSuccessStorageKey('https://health.example/', 7));
        expect(clearSyncStorage).toHaveBeenCalledWith('https://health.example/', 7);
    });

    it('still attempts every local removal when Android permission revocation fails', async () => {
        revokePermissions.mockRejectedValueOnce(new Error('provider unavailable'));

        await expect(clearHealthConnectAccountData('https://health.example', 7, {
            removeItem, revokePermissions, clearSyncStorage
        }))
            .rejects.toThrow('could not be fully cleared');
        expect(removeItem).toHaveBeenCalledTimes(2);
        expect(clearSyncStorage).toHaveBeenCalledTimes(1);
    });
});
