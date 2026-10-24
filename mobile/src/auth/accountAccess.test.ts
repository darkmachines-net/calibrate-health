/** @file Regression coverage for account Access: account access policy. */

import {
    ACCOUNT_ACCESS_STATES,
    getAccountAccessState,
    hasFullAccountAccess,
    requireRegistrationLegalAcceptance,
    requiresHostedLegalAcceptance,
    restrictedAccountRoute
} from './accountAccess';

describe('account access policy', () => {
    it('keeps legacy compatible servers on full access when account_access is absent', () => {
        const user = { id: 7 } as never;
        expect(getAccountAccessState(user)).toBe(ACCOUNT_ACCESS_STATES.FULL);
        expect(hasFullAccountAccess(user)).toBe(true);
        expect(restrictedAccountRoute(user)).toBeNull();
    });

    it.each([
        [ACCOUNT_ACCESS_STATES.EMAIL_VERIFICATION_REQUIRED, '/verify-email'],
        [ACCOUNT_ACCESS_STATES.LEGAL_ACCEPTANCE_REQUIRED, '/legal-update']
    ] as const)('routes %s sessions to the only allowed completion flow', (state, route) => {
        const user = { account_access: { state } } as never;
        expect(hasFullAccountAccess(user)).toBe(false);
        expect(restrictedAccountRoute(user)).toBe(route);
    });

    it('requires legal consent only for the official hosted service', () => {
        expect(requiresHostedLegalAcceptance('https://calibratehealth.app')).toBe(true);
        expect(requiresHostedLegalAcceptance('https://health.example.com')).toBe(false);
        expect(requiresHostedLegalAcceptance('http://10.0.2.2:3000')).toBe(false);
    });

    it('requires both explicit legal choices before registration can record acceptance', () => {
        expect(() => requireRegistrationLegalAcceptance({ acceptTerms: true, acceptPrivacy: false }))
            .toThrow('Explicit acceptance');
        expect(requireRegistrationLegalAcceptance({ acceptTerms: true, acceptPrivacy: true }))
            .toEqual({ acceptTerms: true, acceptPrivacy: true });
    });
});
