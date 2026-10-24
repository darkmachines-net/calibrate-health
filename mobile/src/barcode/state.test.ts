/** @file Regression coverage for state: barcode recovery state. */

import {
    BARCODE_LOOKUP_STATES,
    BARCODE_PERMISSION_STATES,
    getBarcodeLookupFailure,
    resolveBarcodeLookupState,
    resolveBarcodePermissionState
} from './state';

describe('barcode recovery state', () => {
    it('distinguishes first request, denial, permanent denial, unavailable camera, and grant', () => {
        expect(resolveBarcodePermissionState({
            permission: null,
            hasRequestedPermission: false
        })).toBe(BARCODE_PERMISSION_STATES.CHECKING);
        expect(resolveBarcodePermissionState({
            permission: { granted: false, canAskAgain: true },
            hasRequestedPermission: false
        })).toBe(BARCODE_PERMISSION_STATES.FIRST_REQUEST);
        expect(resolveBarcodePermissionState({
            permission: { granted: false, canAskAgain: true },
            hasRequestedPermission: true
        })).toBe(BARCODE_PERMISSION_STATES.DENIED);
        expect(resolveBarcodePermissionState({
            permission: { granted: false, canAskAgain: false },
            hasRequestedPermission: false
        })).toBe(BARCODE_PERMISSION_STATES.PERMANENTLY_DENIED);
        expect(resolveBarcodePermissionState({
            permission: { granted: false, canAskAgain: false },
            hasRequestedPermission: true
        })).toBe(BARCODE_PERMISSION_STATES.PERMANENTLY_DENIED);
        expect(resolveBarcodePermissionState({
            permission: { granted: false, canAskAgain: true },
            hasRequestedPermission: false,
            isCameraAvailable: false
        })).toBe(BARCODE_PERMISSION_STATES.UNAVAILABLE);
        expect(resolveBarcodePermissionState({
            permission: { granted: true, canAskAgain: true },
            hasRequestedPermission: true
        })).toBe(BARCODE_PERMISSION_STATES.GRANTED);
    });

    it('resolves searching, result, no-result, offline, auth, and provider-error states', () => {
        const base = {
            barcode: '012345678905',
            isOnline: true,
            resultCount: 0
        } as const;
        expect(resolveBarcodeLookupState({ ...base, barcode: null, status: 'idle' })).toEqual({
            kind: BARCODE_LOOKUP_STATES.IDLE
        });
        expect(resolveBarcodeLookupState({ ...base, status: 'pending' })).toMatchObject({
            kind: BARCODE_LOOKUP_STATES.SEARCHING
        });
        expect(resolveBarcodeLookupState({ ...base, status: 'success', resultCount: 2 })).toEqual({
            kind: BARCODE_LOOKUP_STATES.RESULT,
            barcode: base.barcode,
            resultCount: 2
        });
        expect(resolveBarcodeLookupState({ ...base, status: 'success' })).toMatchObject({
            kind: BARCODE_LOOKUP_STATES.NO_RESULT
        });
        expect(resolveBarcodeLookupState({ ...base, status: 'pending', isOnline: false })).toMatchObject({
            kind: BARCODE_LOOKUP_STATES.OFFLINE,
            failure: { kind: 'offline' }
        });
        expect(resolveBarcodeLookupState({
            ...base,
            status: 'pending',
            fetchStatus: 'paused'
        })).toMatchObject({ kind: BARCODE_LOOKUP_STATES.OFFLINE });
        expect(resolveBarcodeLookupState({ ...base, status: 'error', error: { status: 401 } })).toMatchObject({
            kind: BARCODE_LOOKUP_STATES.AUTH_REQUIRED,
            failure: { kind: 'authentication' }
        });
        expect(resolveBarcodeLookupState({ ...base, status: 'error', error: { status: 503 } })).toMatchObject({
            kind: BARCODE_LOOKUP_STATES.ERROR,
            failure: { kind: 'provider-unavailable' }
        });
        expect(resolveBarcodeLookupState({
            ...base,
            status: 'error',
            error: new TypeError('Network request failed')
        })).toMatchObject({
            kind: BARCODE_LOOKUP_STATES.OFFLINE,
            failure: { kind: 'offline', canRetry: true }
        });
    });

    it('keeps verified results usable after the connection changes', () => {
        expect(resolveBarcodeLookupState({
            barcode: '012345678905',
            isOnline: false,
            status: 'success',
            resultCount: 1
        })).toMatchObject({ kind: BARCODE_LOOKUP_STATES.RESULT, resultCount: 1 });
    });

    it('maps raw provider, gateway, and transport failures to bounded private copy', () => {
        const privateGatewayText = 'SQL password=secret provider body with food name';
        const failures = [
            getBarcodeLookupFailure(new Error(privateGatewayText)),
            getBarcodeLookupFailure({ status: 503, message: privateGatewayText }),
            getBarcodeLookupFailure({ response: { status: 429 }, message: privateGatewayText }),
            getBarcodeLookupFailure(new TypeError(`Network failed ${privateGatewayText}`))
        ];

        expect(failures.map((failure) => failure.kind)).toEqual([
            'unknown',
            'provider-unavailable',
            'rate-limited',
            'offline'
        ]);
        expect(getBarcodeLookupFailure(new TypeError('Network failed'), { isOnline: true }).canRetry).toBe(true);
        expect(getBarcodeLookupFailure(new TypeError('Network failed'), { isOnline: false }).canRetry).toBe(false);
        for (const failure of failures) {
            expect(failure.message).not.toContain(privateGatewayText);
            expect(failure.message).not.toMatch(/password|SQL|food name/i);
        }
    });
});
