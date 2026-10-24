/** @file Regression coverage for account Deletion Notice: account deletion cleanup notice. */

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); })
    }
}));

import {
    accountDeletionCleanupGuidance,
    assertAccountDeletionCleanupAcknowledged,
    clearAccountDeletionCleanupNotice,
    readAccountDeletionCleanupNotice,
    writeAccountDeletionCleanupNotice,
    type AccountDeletionCleanupNotice
} from './accountDeletionNotice';

const notice: AccountDeletionCleanupNotice = {
    version: 1,
    watchCleanupRequired: true,
    appDataCleanupRequired: true,
    credentialCleanupRequired: false
};

describe('account deletion cleanup notice', () => {
    beforeEach(() => mockStorage.clear());

    it('survives a fresh read and remains until explicit acknowledgement', async () => {
        await writeAccountDeletionCleanupNotice(notice);
        expect(await readAccountDeletionCleanupNotice()).toEqual(notice);
        expect(await readAccountDeletionCleanupNotice()).toEqual(notice);

        await clearAccountDeletionCleanupNotice();
        expect(await readAccountDeletionCleanupNotice()).toBeNull();
    });

    it('gives both watch disconnect and Android app-data recovery steps', () => {
        const message = accountDeletionCleanupGuidance(notice, 'android');
        expect(message).toContain('Disconnect this watch');
        expect(message).toContain('clear Calibrate app data');
        expect(message).toContain('Before signing in again');
    });

    it('uses iOS-safe local-data recovery steps', () => {
        const message = accountDeletionCleanupGuidance(notice, 'ios');
        expect(message).toContain('this device was signed out');
        expect(message).toContain('delete (do not offload) and reinstall Calibrate');
        expect(message).not.toContain('Android Settings');
    });

    it('blocks every new authentication path until cleanup is acknowledged', () => {
        expect(() => assertAccountDeletionCleanupAcknowledged(notice)).toThrow('before continuing');
        expect(() => assertAccountDeletionCleanupAcknowledged(null)).not.toThrow();
    });
});
