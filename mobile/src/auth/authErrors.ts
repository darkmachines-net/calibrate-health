/** @file Debug auto-login error classification and safe session-restoration guidance. */

import { ApiError } from '@calibrate/api-client';

/** Treat a 401 response as an expected debug auto-login miss. */
export function isExpectedDevAutoLoginMiss(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401;
}

/** Turn startup refresh failures into next-step guidance without exposing raw transport errors. */
export function getSessionRestoreErrorMessage(error: unknown): string {
    if (error instanceof ApiError && error.status === 401) {
        return 'Your saved session expired. Sign in again.';
    }
    if (
        error instanceof TypeError
        || (error instanceof Error && /network|fetch|timed out|connect|offline/i.test(error.message))
    ) {
        return 'Could not reach your saved Calibrate server. Check the server connection; your session is still stored.';
    }
    return 'Unable to restore your saved session. Test the server connection or sign in again.';
}
