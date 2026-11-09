/** @file Safe provider sign-in recovery copy without displaying native SDK or Firebase error details. */
import { ApiError } from '@calibrate/api-client';

/** Distinguish account conflicts, legal acceptance and retry actions using bounded server codes. */
export function socialAuthErrorMessage(error: unknown): string {
    if (error instanceof ApiError) {
        if (error.code === 'SOCIAL_ACCOUNT_CONFLICT') return 'Use your existing sign-in method for this email. Accounts are not linked automatically.';
        if (error.code === 'INVALID_LEGAL_ACCEPTANCE' || error.code === 'INVALID_LEGAL_VERSION') return 'Review and accept the current Terms and Privacy Policy to create an account.';
        if (error.status === 429) return 'Too many attempts were made. Try again shortly.';
        if (error.code === 'SOCIAL_AUTH_UNAVAILABLE') return 'This sign-in provider is temporarily unavailable. Try again later.';
    }
    return 'Unable to complete provider sign-in. Try again.';
}
