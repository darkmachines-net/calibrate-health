/** @file Regression coverage for app Update: app update presentation and actions. */

jest.mock('expo-application', () => ({
    nativeApplicationVersion: '0.2.1',
    nativeBuildVersion: '3'
}));
jest.mock('expo-updates', () => ({
    checkForUpdateAsync: jest.fn(),
    fetchUpdateAsync: jest.fn(),
    reloadAsync: jest.fn()
}));

import appConfig from '../../app.json';
import {
    canManageOtaUpdates,
    checkForAppUpdate,
    createAppVersionInfo,
    getConfiguredNativeBuild,
    downloadAppUpdate,
    shortenUpdateId
} from './appUpdate';

describe('app update presentation and actions', () => {
    it('reports the native release and an embedded update separately', () => {
        expect(createAppVersionInfo({
            platform: 'android',
            isDevelopment: false,
            nativeApplicationVersion: '0.2.1',
            nativeBuildVersion: '3',
            fallbackNativeVersion: '0.1.0',
            fallbackNativeBuild: '1',
            nativeReleaseTag: 'v0.12.2',
            runningUpdate: {
                updateId: '01234567-89ab-4def-8123-456789abcdef',
                channel: 'internal',
                createdAt: new Date('2026-07-21T20:00:00.000Z'),
                isEmbeddedLaunch: true,
                isEmergencyLaunch: false,
                emergencyLaunchReason: null,
                runtimeVersion: '0.2.1'
            }
        })).toMatchObject({
            nativeVersion: '0.2.1',
            nativeBuild: '3',
            nativeReleaseTag: 'v0.12.2',
            runtimeVersion: '0.2.1',
            channel: 'internal',
            updateLabel: 'Embedded in native build',
            updateId: '01234567-89ab-4def-8123-456789abcdef'
        });
    });

    it('identifies the currently running OTA by a stable short ID', () => {
        const info = createAppVersionInfo({
            platform: 'android',
            isDevelopment: false,
            nativeApplicationVersion: null,
            nativeBuildVersion: null,
            fallbackNativeVersion: '0.2.1',
            fallbackNativeBuild: '3',
            nativeReleaseTag: 'v0.12.2',
            runningUpdate: {
                updateId: 'abcdef01-89ab-4def-8123-456789abcdef',
                channel: 'production',
                isEmbeddedLaunch: false,
                isEmergencyLaunch: false,
                emergencyLaunchReason: null
            }
        });
        expect(shortenUpdateId(info.updateId!)).toBe('abcdef01');
        expect(info.updateLabel).toBe('OTA abcdef01');
        expect(info.nativeVersion).toBe('0.2.1');
        expect(info.nativeBuild).toBe('3');
    });

    it('does not mislabel a development bundle as an OTA', () => {
        expect(createAppVersionInfo({
            platform: 'android',
            isDevelopment: true,
            nativeApplicationVersion: '0.2.1',
            nativeBuildVersion: '3',
            fallbackNativeVersion: '0.2.1',
            fallbackNativeBuild: '3',
            nativeReleaseTag: 'v0.12.2',
            runningUpdate: {
                isEmbeddedLaunch: false,
                isEmergencyLaunch: false,
                emergencyLaunchReason: null,
                runtimeVersion: '0.2.1'
            }
        })).toMatchObject({
            channel: 'Development',
            updateLabel: 'Development bundle'
        });
    });

    it('keeps manual OTA controls out of web and development runtimes', () => {
        expect(canManageOtaUpdates('web', false, true)).toBe(false);
        expect(canManageOtaUpdates('android', true, true)).toBe(false);
        expect(canManageOtaUpdates('android', false, false)).toBe(false);
        expect(canManageOtaUpdates('android', false, true)).toBe(true);
    });

    it('uses platform-specific native build fallbacks', () => {
        expect(getConfiguredNativeBuild('android')).toBe(String(appConfig.expo.android.versionCode));
        expect(getConfiguredNativeBuild('ios')).toBe(appConfig.expo.ios.buildNumber);
    });

    it('distinguishes current, available, and rollback checks', async () => {
        await expect(checkForAppUpdate({
            checkForUpdateAsync: async () => ({ isAvailable: false, isRollBackToEmbedded: false })
        })).resolves.toBe('current');
        await expect(checkForAppUpdate({
            checkForUpdateAsync: async () => ({ isAvailable: true, isRollBackToEmbedded: false })
        })).resolves.toBe('available');
        await expect(checkForAppUpdate({
            checkForUpdateAsync: async () => ({ isAvailable: false, isRollBackToEmbedded: true })
        })).resolves.toBe('rollback');
    });

    it('downloads only a new update or rollback directive', async () => {
        await expect(downloadAppUpdate({
            fetchUpdateAsync: async () => ({ isNew: true, isRollBackToEmbedded: false })
        })).resolves.toBe(true);
        await expect(downloadAppUpdate({
            fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: true })
        })).resolves.toBe(true);
        await expect(downloadAppUpdate({
            fetchUpdateAsync: async () => ({ isNew: false, isRollBackToEmbedded: false })
        })).resolves.toBe(false);
    });
});
