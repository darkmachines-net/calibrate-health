/** @file account deletion: Renders canonical deletion instructions and authenticated restricted-account data actions. */

import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { PublicLegalPage } from '../src/components/legal/PublicLegalPage';
import {
    ACCOUNT_DELETION_INTRO,
    ACCOUNT_DELETION_SECTIONS,
    buildAccountDeletionRequestMailto
} from '../src/legal/publicLegalContent';
import { RestrictedAccountDataActions } from '../src/components/legal/RestrictedAccountDataActions';
import { useAuth } from '../src/auth/AuthContext';

/** Renders canonical deletion instructions and authenticated restricted-account data actions. */
export default function AccountDeletionRoute() {
    const { user } = useAuth();
    return (
        <PublicLegalPage
            title="Delete your Calibrate account"
            intro={ACCOUNT_DELETION_INTRO}
            sections={ACCOUNT_DELETION_SECTIONS}
            actions={user ? <RestrictedAccountDataActions /> : undefined}
            links={[
                { href: '/(auth)/login', label: 'Sign in to delete now' },
                { href: buildAccountDeletionRequestMailto(), label: 'Email a hosted deletion request' },
                { href: CALIBRATE_PRODUCT_LINKS.privacy, label: 'Read the privacy policy' }
            ]}
        />
    );
}
