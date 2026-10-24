/** @file Regression coverage for auth Errors: debug auto-login errors. */

import { ApiError } from '@calibrate/api-client';
import { getSessionRestoreErrorMessage, isExpectedDevAutoLoginMiss } from './authErrors';

describe('debug auto-login errors', () => {
    it('treats a missing seed account as an optional convenience miss', () => {
        expect(isExpectedDevAutoLoginMiss(new ApiError('unauthorized', 401, null))).toBe(true);
        expect(isExpectedDevAutoLoginMiss(new ApiError('server unavailable', 503, null))).toBe(false);
        expect(isExpectedDevAutoLoginMiss(new TypeError('Network request failed'))).toBe(false);
    });
});

describe('session restore error copy', () => {
    it('distinguishes an expired session from a temporarily unavailable server', () => {
        expect(getSessionRestoreErrorMessage(new ApiError('unauthorized', 401, null)))
            .toBe('Your saved session expired. Sign in again.');
        expect(getSessionRestoreErrorMessage(new TypeError('Network request failed')))
            .toContain('your session is still stored');
    });

    it('does not expose arbitrary implementation errors', () => {
        expect(getSessionRestoreErrorMessage(new Error('postgres password was bad')))
            .toBe('Unable to restore your saved session. Test the server connection or sign in again.');
    });
});
