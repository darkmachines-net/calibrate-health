/** @file Regression coverage for Legal Consent Fields: LegalConsentFields. */

import { fireEvent, render } from '@testing-library/react-native';
import { LegalConsentFields } from './LegalConsentFields';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-router', () => {
    const ReactModule = require('react');
    const { Text } = require('react-native');
    return {
        Link: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(Text, null, children)
    };
});

describe('LegalConsentFields', () => {
    it('exposes explicit checkbox state and independent change handlers', () => {
        const onTermsAcceptedChange = jest.fn();
        const onPrivacyAcceptedChange = jest.fn();
        const screen = render(
            <LegalConsentFields
                termsAccepted
                privacyAccepted={false}
                onTermsAcceptedChange={onTermsAcceptedChange}
                onPrivacyAcceptedChange={onPrivacyAcceptedChange}
            />
        );

        const terms = screen.getByRole('checkbox', { name: 'I agree to the current Terms of service' });
        const privacy = screen.getByRole('checkbox', { name: 'I accept the current Privacy policy' });
        expect(terms.props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
        expect(privacy.props.accessibilityState).toEqual(expect.objectContaining({ checked: false }));

        fireEvent.press(terms);
        fireEvent.press(privacy);
        expect(onTermsAcceptedChange).toHaveBeenCalledWith(false);
        expect(onPrivacyAcceptedChange).toHaveBeenCalledWith(true);
    });
});