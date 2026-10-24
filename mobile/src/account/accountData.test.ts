/** @file Regression coverage for account Data: account export sharing. */

import type { AccountExport } from '@calibrate/api-client';
import {
    canSubmitAccountDeletion,
    deleteAccountAndClearLocalData,
    DELETE_ACCOUNT_CONFIRMATION,
    serializeAccountExport,
    shareAccountExport
} from './accountData';

jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: { cache: 'file:///cache/' } }));
jest.mock('expo-sharing', () => ({
    isAvailableAsync: jest.fn(async () => true),
    shareAsync: jest.fn(async () => undefined)
}));

function accountExport(overrides: Record<string, unknown> = {}): AccountExport {
    return {
        format: 'calibrate-account-export',
        version: 5,
        exported_at: '2026-07-11T12:00:00.000Z',
        account: { email: 'user@example.com' },
        goals: [],
        body_metrics: [],
        food_logs: [],
        food_log_days: [],
        food_tracking_pauses: [],
        my_foods: [],
        in_app_notifications: [],
        ...overrides
    } as unknown as AccountExport;
}

describe('account export sharing', () => {
    it('serializes the portable export without adding credentials', () => {
        const serialized = serializeAccountExport(accountExport());
        expect(JSON.parse(serialized)).toEqual(expect.objectContaining({
            format: 'calibrate-account-export',
            account: { email: 'user@example.com' }
        }));
        expect(serialized).not.toContain('access_token');
        expect(serialized).not.toContain('refresh_token');
    });

    it.each(['password', 'password_hash', 'access_token', 'refresh_token', 'session_token'])(
        'refuses an unexpected %s credential field',
        (key) => {
            expect(() => serializeAccountExport(accountExport({ unexpected: { [key]: 'secret' } })))
                .toThrow('credential data');
        }
    );

    it('shares an anonymous cache filename and deletes the temporary file', async () => {
        const file = {
            uri: 'file:///cache/calibrate-account-export-2026-07-11.json',
            exists: true,
            create: jest.fn(),
            write: jest.fn(),
            delete: jest.fn(() => { file.exists = false; })
        };
        const share = jest.fn(async () => undefined);

        await shareAccountExport(accountExport(), {
            isSharingAvailable: async () => true,
            createCacheFile: jest.fn(() => file),
            share
        });

        expect(file.create).toHaveBeenCalledWith({ overwrite: true });
        expect(file.write).toHaveBeenCalledWith(expect.stringContaining('calibrate-account-export'));
        expect(share).toHaveBeenCalledWith(file.uri, expect.objectContaining({ mimeType: 'application/json' }));
        expect(file.delete).toHaveBeenCalledTimes(1);
    });

    it('deletes the temporary file when the Android share sheet fails', async () => {
        const file = {
            uri: 'file:///cache/export.json',
            exists: true,
            create: jest.fn(),
            write: jest.fn(),
            delete: jest.fn(() => { file.exists = false; })
        };

        await expect(shareAccountExport(accountExport(), {
            isSharingAvailable: async () => true,
            createCacheFile: () => file,
            share: async () => { throw new Error('share failed'); }
        })).rejects.toThrow('share failed');
        expect(file.delete).toHaveBeenCalledTimes(1);
    });

    it('does not create a file when sharing is unavailable', async () => {
        const createCacheFile = jest.fn();
        await expect(shareAccountExport(accountExport(), {
            isSharingAvailable: async () => false,
            createCacheFile,
            share: async () => undefined
        })).rejects.toThrow('unavailable');
        expect(createCacheFile).not.toHaveBeenCalled();
    });
});

describe('account deletion confirmation', () => {
    it('requires both the current password and exact destructive phrase', () => {
        expect(canSubmitAccountDeletion('current-password', DELETE_ACCOUNT_CONFIRMATION)).toBe(true);
        expect(canSubmitAccountDeletion('', DELETE_ACCOUNT_CONFIRMATION)).toBe(false);
        expect(canSubmitAccountDeletion('current-password', 'delete my account')).toBe(false);
        expect(canSubmitAccountDeletion('current-password', 'DELETE')).toBe(false);
    });

    it('clears queued data before the local session after server-confirmed deletion', async () => {
        const events: string[] = [];
        await deleteAccountAndClearLocalData('current-password', {
            deleteRemoteAccount: async (password) => { events.push(`remote:${password}`); },
            discardOfflineChanges: async () => { events.push('offline'); },
            clearHealthConnectData: async () => { events.push('health'); },
            clearWearData: async () => { events.push('wear'); },
            persistCleanupNotice: async () => { events.push('notice'); },
            clearLocalSession: async () => { events.push('session'); }
        });
        expect(events.slice(0, 4)).toEqual(expect.arrayContaining([
            'remote:current-password', 'offline', 'health', 'wear'
        ]));
        expect(events.at(-1)).toBe('session');
    });

    it('preserves the session when the server rejects deletion', async () => {
        const discardOfflineChanges = jest.fn(async () => undefined);
        const clearLocalSession = jest.fn(async () => undefined);
        await expect(deleteAccountAndClearLocalData('wrong-password', {
            deleteRemoteAccount: async () => { throw new Error('incorrect password'); },
            discardOfflineChanges,
            clearHealthConnectData: jest.fn(async () => undefined),
            clearWearData: jest.fn(async () => undefined),
            persistCleanupNotice: jest.fn(async () => undefined),
            clearLocalSession
        })).rejects.toThrow('incorrect password');
        expect(discardOfflineChanges).not.toHaveBeenCalled();
        expect(clearLocalSession).not.toHaveBeenCalled();
    });

    it('still clears credentials if local outbox cleanup fails after account deletion', async () => {
        const clearLocalSession = jest.fn(async () => undefined);
        await expect(deleteAccountAndClearLocalData('current-password', {
            deleteRemoteAccount: async () => undefined,
            discardOfflineChanges: async () => { throw new Error('database cleanup failed'); },
            clearHealthConnectData: async () => undefined,
            clearWearData: async () => undefined,
            persistCleanupNotice: jest.fn(async () => undefined),
            clearLocalSession
        })).resolves.toBeUndefined();
        expect(clearLocalSession).toHaveBeenCalledTimes(1);
    });

    it('attempts every cleanup and surfaces an unreachable watch after credentials are cleared', async () => {
        const events: string[] = [];
        const persistCleanupNotice = jest.fn(async () => undefined);
        await expect(deleteAccountAndClearLocalData('current-password', {
            deleteRemoteAccount: async () => undefined,
            discardOfflineChanges: async () => { events.push('offline'); throw new Error('outbox failed'); },
            clearHealthConnectData: async () => { events.push('health'); throw new Error('health failed'); },
            clearWearData: async () => { events.push('wear'); throw new Error('Paired watch was unreachable. Disconnect Calibrate on the watch.'); },
            persistCleanupNotice,
            clearLocalSession: async () => { events.push('session'); }
        })).resolves.toBeUndefined();
        expect(events).toEqual(expect.arrayContaining(['offline', 'health', 'wear', 'session']));
        expect(events.at(-1)).toBe('session');
        expect(persistCleanupNotice).toHaveBeenCalledWith(expect.objectContaining({
            watchCleanupRequired: true,
            appDataCleanupRequired: true
        }));
    });

    it('captures synchronous cleanup throws without skipping other cleanup or sign-out', async () => {
        const events: string[] = [];
        const persistCleanupNotice = jest.fn(async () => undefined);
        await deleteAccountAndClearLocalData('current-password', {
            deleteRemoteAccount: async () => undefined,
            discardOfflineChanges: () => { throw new Error('sync outbox failure'); },
            clearHealthConnectData: async () => { events.push('health'); },
            clearWearData: async () => { events.push('wear'); },
            persistCleanupNotice,
            clearLocalSession: async () => { events.push('session'); }
        });

        expect(events).toEqual(expect.arrayContaining(['health', 'wear', 'session']));
        expect(persistCleanupNotice).toHaveBeenCalledWith(expect.objectContaining({
            appDataCleanupRequired: true
        }));
    });

    it('persists credential recovery guidance when local-session clearing fails synchronously', async () => {
        const persistCleanupNotice = jest.fn(async () => undefined);
        await expect(deleteAccountAndClearLocalData('current-password', {
            deleteRemoteAccount: async () => undefined,
            discardOfflineChanges: async () => undefined,
            clearHealthConnectData: async () => undefined,
            clearWearData: async () => undefined,
            persistCleanupNotice,
            clearLocalSession: () => { throw new Error('secure storage unavailable'); }
        })).rejects.toThrow('local sign-in credentials');
        expect(persistCleanupNotice).toHaveBeenCalledWith(expect.objectContaining({
            appDataCleanupRequired: true,
            credentialCleanupRequired: true
        }));
    });
});
