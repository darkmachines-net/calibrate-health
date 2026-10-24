/** @file privacy: Renders the canonical public privacy policy and related legal navigation. */

import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { PublicLegalPage } from '../src/components/legal/PublicLegalPage';
import {
    PRIVACY_INTRO,
    PRIVACY_LAST_UPDATED,
    PRIVACY_SECTIONS
} from '../src/legal/publicLegalContent';

/** Renders the canonical public privacy policy and related legal navigation. */
export default function PrivacyRoute() {
    return (
        <PublicLegalPage
            title="Privacy policy"
            lastUpdated={PRIVACY_LAST_UPDATED}
            intro={PRIVACY_INTRO}
            sections={PRIVACY_SECTIONS}
            links={[
                { href: CALIBRATE_PRODUCT_LINKS.terms, label: 'Terms of service' },
                { href: '/account-deletion', label: 'Account deletion instructions' },
                { href: '/', label: 'Back to Calibrate' }
            ]}
        />
    );
}
