/** @file Covers About screen product information and canonical trust and software-license links. */

import type { ReactNode } from 'react';
import { render } from '@testing-library/react-native';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import AboutScreen from '../../app/(tabs)/(settings)/about';

const mockLink = jest.fn();

jest.mock('expo-router', () => ({
    Link: (props: { children: ReactNode; href: unknown }) => {
        const ReactActual = jest.requireActual<typeof import('react')>('react');
        mockLink(props);
        return ReactActual.createElement(ReactActual.Fragment, null, props.children);
    }
}));
jest.mock('@expo/vector-icons/Ionicons', () => ({
    __esModule: true,
    default: () => null
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));
jest.mock('../components/CalibrateLogo', () => ({
    CalibrateLogo: () => null
}));

describe('AboutScreen', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('leads with consumer purpose, trust, and accurate launch availability', () => {
        const view = render(<AboutScreen />);

        expect(view.getByText('About Calibrate')).toBeTruthy();
        expect(view.getByText(/compare calories with a personalized target/)).toBeTruthy();
        expect(view.getByText(/Available in English on the web as an installable PWA and on Android and iOS/)).toBeTruthy();
        expect(view.queryByText('Service address')).toBeNull();
        expect(view.queryByLabelText('Show advanced details')).toBeNull();
        expect(view.queryByText('Software updates')).toBeNull();
    });

    it('presents distinct links for every canonical product and trust destination', () => {
        const view = render(<AboutScreen />);

        const destinations = mockLink.mock.calls.map(([props]) => props.href);
        expect(destinations).toEqual(expect.arrayContaining([
            CALIBRATE_PRODUCT_LINKS.product,
            CALIBRATE_PRODUCT_LINKS.privacy,
            CALIBRATE_PRODUCT_LINKS.terms,
            CALIBRATE_PRODUCT_LINKS.support,
            CALIBRATE_PRODUCT_LINKS.feedback,
            CALIBRATE_PRODUCT_LINKS.licenses,
            CALIBRATE_PRODUCT_LINKS.releases
        ]));
        for (const label of [
            'Calibrate website',
            'Privacy policy',
            'Terms of service',
            'Support',
            'Feedback',
            'Software license',
            'Release notes'
        ]) {
            expect(view.getByRole('link', { name: label })).toBeTruthy();
        }
    });

});
