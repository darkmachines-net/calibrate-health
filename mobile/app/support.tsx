/** @file support: Renders canonical support contacts and related public account information. */

import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { PublicLegalPage } from '../src/components/legal/PublicLegalPage';
import {
    SUPPORT_EMAIL,
    SUPPORT_INTRO,
    SUPPORT_SECTIONS
} from '../src/legal/publicLegalContent';

/** Renders canonical support contacts and related public account information. */
export default function SupportRoute() {
    return (
        <PublicLegalPage
            title="Support"
            intro={SUPPORT_INTRO}
            sections={SUPPORT_SECTIONS}
            links={[
                { href: `mailto:${SUPPORT_EMAIL}`, label: 'Email support' },
                { href: CALIBRATE_PRODUCT_LINKS.terms, label: 'Terms of service' },
                { href: CALIBRATE_PRODUCT_LINKS.privacy, label: 'Privacy policy' },
                { href: '/account-deletion', label: 'Account deletion' }
            ]}
        />
    );
}
