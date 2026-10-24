/** @file Regression coverage for public Legal Content: Expo web public legal content. */

import {
    ACCOUNT_DELETION_SECTIONS,
    PRIVACY_SECTIONS,
    buildAccountDeletionRequestMailto
} from './publicLegalContent';

describe('Expo web public legal content', () => {
    it('retains the canonical privacy coverage needed for hosted, self-hosted, and Health Connect use', () => {
        const policy = JSON.stringify(PRIVACY_SECTIONS);

        expect(PRIVACY_SECTIONS).toHaveLength(10);
        expect(policy).toContain('HttpOnly');
        expect(policy).toContain('Health Connect');
        expect(policy).toContain('source attribution');
        expect(policy).toContain('automatically change calorie targets');
        expect(policy).toContain('Self-Hosted Instances');
        expect(policy).toContain('do not sell or rent data');
        expect(policy).toContain('Password hashes, tokens, sessions, push endpoints');
    });

    it('keeps account deletion public, password-safe, and explicit about self-hosted ownership', () => {
        const deletionCopy = JSON.stringify(ACCOUNT_DELETION_SECTIONS);
        const mailto = decodeURIComponent(buildAccountDeletionRequestMailto());

        expect(deletionCopy).toContain('within 7 days');
        expect(deletionCopy).toContain('within 30 days');
        expect(deletionCopy).toContain('Never send your password by email');
        expect(deletionCopy).toContain('self-hosted instance');
        expect(mailto).toContain('I will not send my password by email.');
    });
});
