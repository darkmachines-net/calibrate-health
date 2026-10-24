/** @file Client routing and legal-consent policy for full, verification-required, and restricted account states. */

import type { UserClientPayload } from '@calibrate/api-client';
import { HOSTED_SERVER_URL, normalizeServerUrl } from '../config/server';

export const ACCOUNT_ACCESS_STATES = {
    FULL: 'full',
    EMAIL_VERIFICATION_REQUIRED: 'email_verification_required',
    LEGAL_ACCEPTANCE_REQUIRED: 'legal_acceptance_required'
} as const;

export type AccountAccessState = (typeof ACCOUNT_ACCESS_STATES)[keyof typeof ACCOUNT_ACCESS_STATES];

export type RegistrationLegalAcceptance = {
    acceptTerms: boolean;
    acceptPrivacy: boolean;
};

/** Only accounts created on the official hosted service accept Calibrate's legal documents. */
export function requiresHostedLegalAcceptance(serverUrl: string): boolean {
    return normalizeServerUrl(serverUrl) === HOSTED_SERVER_URL;
}

/** Rejects registration unless both current legal documents were explicitly accepted. */
export function requireRegistrationLegalAcceptance(
    acceptance: RegistrationLegalAcceptance
): { acceptTerms: true; acceptPrivacy: true } {
    if (!acceptance.acceptTerms || !acceptance.acceptPrivacy) {
        throw new Error('Explicit acceptance of the current legal documents is required.');
    }
    return { acceptTerms: true, acceptPrivacy: true };
}

/** Older compatible servers omit account_access and retain their established full-access behavior. */
export function getAccountAccessState(user: UserClientPayload | null | undefined): AccountAccessState {
    return user?.account_access?.state ?? ACCOUNT_ACCESS_STATES.FULL;
}

/** Reports whether authentication, email verification, and legal acceptance permit full account access. */
export function hasFullAccountAccess(user: UserClientPayload | null | undefined): boolean {
    return getAccountAccessState(user) === ACCOUNT_ACCESS_STATES.FULL;
}

/** Selects the verification or legal-update route required before the user can enter the app. */
export function restrictedAccountRoute(user: UserClientPayload | null | undefined): '/verify-email' | '/legal-update' | null {
    const state = getAccountAccessState(user);
    if (state === ACCOUNT_ACCESS_STATES.EMAIL_VERIFICATION_REQUIRED) return '/verify-email';
    if (state === ACCOUNT_ACCESS_STATES.LEGAL_ACCEPTANCE_REQUIRED) return '/legal-update';
    return null;
}
