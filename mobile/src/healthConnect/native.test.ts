/** @file Regression coverage for native: Health Connect availability, SDK-guarded disconnection, and revocation normalization. */

import { Platform } from 'react-native';
import {
    disconnectHealthConnect,
    mapSdkStatus,
    normalizeRevocationResponse
} from './native';

const mockGetSdkStatus = jest.fn();
const mockInitialize = jest.fn();
const mockRevokeAllPermissions = jest.fn();

jest.mock('react-native-health-connect', () => ({
    getSdkStatus: (...args: unknown[]) => mockGetSdkStatus(...args),
    initialize: (...args: unknown[]) => mockInitialize(...args),
    revokeAllPermissions: (...args: unknown[]) => mockRevokeAllPermissions(...args)
}));

describe('Health Connect availability', () => {
    it('maps provider availability into product states', () => {
        expect(mapSdkStatus(3)).toBe('available');
        expect(mapSdkStatus(2)).toBe('provider_update_required');
        expect(mapSdkStatus(1)).toBe('unsupported');
        expect(mapSdkStatus(999)).toBe('unsupported');
    });
});

describe('Health Connect revocation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('marks the bridge legacy success response as restart-required on Android 14+', () => {
        expect(normalizeRevocationResponse(true, 34)).toEqual({
            revoked: true,
            requiresRestart: true
        });
    });

    it('preserves immediate revocation on older Android versions', () => {
        expect(normalizeRevocationResponse(true, 33)).toEqual({
            revoked: true,
            requiresRestart: false
        });
    });

    it('fills in a missing restart flag from object responses on Android 14+', () => {
        expect(normalizeRevocationResponse({ revoked: true }, '36')).toEqual({
            revoked: true,
            requiresRestart: true
        });
    });

    it('skips revocation cleanly on Android when Health Connect is unavailable or uninitialized', async () => {
        jest.replaceProperty(Platform, 'OS', 'android');
        mockGetSdkStatus.mockResolvedValueOnce(1);

        await expect(disconnectHealthConnect()).resolves.toBeUndefined();
        expect(mockInitialize).not.toHaveBeenCalled();
        expect(mockRevokeAllPermissions).not.toHaveBeenCalled();

        mockGetSdkStatus.mockResolvedValueOnce(3);
        mockInitialize.mockResolvedValueOnce(false);
        await expect(disconnectHealthConnect()).resolves.toBeUndefined();
        expect(mockRevokeAllPermissions).not.toHaveBeenCalled();
    });

    it('initializes Health Connect before revoking permissions on Android', async () => {
        jest.replaceProperty(Platform, 'OS', 'android');
        jest.spyOn(Platform, 'Version', 'get').mockReturnValue(34);
        mockGetSdkStatus.mockResolvedValueOnce(3);
        mockInitialize.mockResolvedValueOnce(true);
        mockRevokeAllPermissions.mockResolvedValueOnce(true);

        await expect(disconnectHealthConnect()).resolves.toEqual({
            revoked: true,
            requiresRestart: true
        });
        expect(mockInitialize).toHaveBeenCalledWith('com.google.android.apps.healthdata');
        expect(mockRevokeAllPermissions).toHaveBeenCalledTimes(1);
    });
});
