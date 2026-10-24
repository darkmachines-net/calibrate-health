/** @file presentation: Map failures to bounded, user-facing copy without relaying backend or provider text. */

import { OfflineMutationConflict } from '../offline/mutationConflict';
import { ApiError } from '@calibrate/api-client';

export type ErrorPresentation = {
    title: string;
    message: string;
    requestId: string | null;
};

const looksLikeConnectivityFailure = (error: unknown): boolean =>
    error instanceof TypeError
    || (error instanceof Error && /network|fetch|timed out|connect|offline/i.test(error.message));

/** Map failures to bounded, user-facing copy without relaying backend or provider text. */
export function getErrorPresentation(error: unknown, resourceLabel: string): ErrorPresentation {
    const requestId = error instanceof ApiError ? error.requestId : null;

    if (looksLikeConnectivityFailure(error)) {
        return {
            title: `Can't load ${resourceLabel}`,
            message: 'Check your connection and try again.',
            requestId
        };
    }
    if (error instanceof ApiError) {
        if (error.status === 401) {
            return {
                title: 'Session expired',
                message: 'Sign in again to continue.',
                requestId
            };
        }
        if (error.status === 403) {
            return {
                title: `Can't access ${resourceLabel}`,
                message: 'This account does not have access to that information.',
                requestId
            };
        }
        if (error.status === 404) {
            return {
                title: `${resourceLabel} unavailable`,
                message: 'That information is no longer available.',
                requestId
            };
        }
        if (error.status === 429) {
            return {
                title: 'Try again shortly',
                message: 'Calibrate received too many requests at once.',
                requestId
            };
        }
        if (error.status >= 500) {
            return {
                title: `Can't load ${resourceLabel}`,
                message: 'Calibrate had trouble loading this information. Try again.',
                requestId
            };
        }
    }

    return {
        title: `Can't load ${resourceLabel}`,
        message: 'Something went wrong. Try again.',
        requestId
    };
}

/** Maps action failures to safe recovery copy without displaying arbitrary server error details. */
export function getSafeActionErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof OfflineMutationConflict) return error.message;
    if (looksLikeConnectivityFailure(error)) return 'Check your connection and try again.';
    if (error instanceof ApiError) {
        if (error.status === 401) return 'Your session expired. Sign in again.';
        if (error.status === 403) return 'This account does not have permission to make that change.';
        if (error.status === 409) return 'That information changed. Refresh it and try again.';
        if (error.status === 422 || error.status === 400) return fallback;
        if (error.status === 429) return 'Too many requests were sent. Try again shortly.';
    }
    return fallback;
}

/** Maps sign-in and registration failures to safe, action-specific user guidance. */
export function getAuthActionErrorMessage(error: unknown, action: 'sign in' | 'create account'): string {
    if (looksLikeConnectivityFailure(error)) return 'Check your connection and try again.';
    if (error instanceof ApiError) {
        if (action === 'sign in' && error.status === 401) return 'Email or password is incorrect.';
        if (action === 'create account' && error.status === 409) {
            return 'An account with this email already exists.';
        }
        if (error.status === 429) return 'Too many attempts were made. Try again shortly.';
    }
    return action === 'sign in' ? 'Unable to sign in. Try again.' : 'Unable to create account. Try again.';
}
/** Purpose-bound auth links never expose provider or server exception text. */
export function getAccountTrustErrorMessage(error: unknown, fallback: string): string {
    if (looksLikeConnectivityFailure(error)) return 'Check your connection and try again.';
    if (error instanceof ApiError) {
        if (error.code === 'INVALID_OR_EXPIRED_TOKEN') {
            return 'This link is invalid or has expired. Request a new one.';
        }
        if (error.code === 'EMAIL_DELIVERY_UNAVAILABLE') {
            return 'Email delivery is temporarily unavailable. Try again later.';
        }
        if (error.code === 'INVALID_LEGAL_VERSION' || error.code === 'INVALID_LEGAL_ACCEPTANCE') {
            return 'The legal documents changed. Reload this page and review the current versions.';
        }
        if (error.status === 429) return 'Too many attempts were made. Try again shortly.';
    }
    return fallback;
}