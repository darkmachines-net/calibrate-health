/** @file Regression coverage for native: Health Connect availability. */

import { mapSdkStatus, normalizeRevocationResponse } from './native';

describe('Health Connect availability', () => {
    it('maps provider availability into product states', () => {
        expect(mapSdkStatus(3)).toBe('available');
        expect(mapSdkStatus(2)).toBe('provider_update_required');
        expect(mapSdkStatus(1)).toBe('unsupported');
        expect(mapSdkStatus(999)).toBe('unsupported');
    });
});

describe('Health Connect revocation', () => {
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
});
