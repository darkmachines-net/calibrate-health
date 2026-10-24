/** @file Regression coverage for Public Legal Page: PublicLegalPage. */

/**
 * Exercises public legal page behavior and regression boundaries.
 */
import { fireEvent, render, within } from '@testing-library/react-native';
/**
 * Exercises public legal page behavior and regression boundaries.
 */
import { StyleSheet } from 'react-native';
/**
 * Exercises public legal page behavior and regression boundaries.
 */
import { PublicLegalPage } from './PublicLegalPage';
/**
 * Exercises public legal page behavior and regression boundaries.
 */
import { spacing } from '../../theme';

let mockUser: { id: number } | null = null;
const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('../../auth/AuthContext', () => ({
    useAuth: () => ({ user: mockUser })
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));

jest.mock('../CalibrateLogo', () => ({ CalibrateLogo: () => null }));
jest.mock('../AppIconButton', () => {
    const ReactModule = require('react');
    const { Pressable } = require('react-native');
    return {
        AppIconButton: ({ accessibilityLabel, onPress }: {
            accessibilityLabel: string;
            onPress: () => void;
        }) => ReactModule.createElement(Pressable, { accessibilityLabel, accessibilityRole: 'button', onPress })
    };
});

jest.mock('expo-router', () => {
    const ReactModule = require('react');
    const { Text } = require('react-native');
    return {
        Link: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
            ReactModule.createElement(Text, { style }, children),
        router: {
            push: (...args: unknown[]) => mockPush(...args),
            replace: (...args: unknown[]) => mockReplace(...args)
        }
    };
});

const props = {
    title: 'Privacy policy',
    lastUpdated: 'August 1, 2026',
    intro: ['How Calibrate handles account data.'],
    sections: [{ title: 'Your choices', paragraphs: ['Export or delete your account.'] }],
    links: [{ href: '/terms', label: 'Terms of service' }]
};

describe('PublicLegalPage', () => {
    beforeEach(() => {
        mockUser = null;
        mockPush.mockClear();
        mockReplace.mockClear();
    });

    it('uses a public trust shell while keeping signed-in recovery inside Settings', async () => {
        const screen = await render(<PublicLegalPage {...props} />);
        expect(screen.getByTestId('legal-public-shell')).toBeTruthy();
        const pageStyle = StyleSheet.flatten(screen.getByTestId('legal-page').props.style);
        expect(pageStyle).toEqual(expect.objectContaining({ gap: spacing.lg }));
        expect(pageStyle).not.toHaveProperty('padding');
        expect(pageStyle).not.toHaveProperty('borderRadius');
        expect(pageStyle).not.toHaveProperty('backgroundColor');
        expect(screen.getByRole('header', { name: 'Privacy policy' })).toBeTruthy();
        expect(screen.getByText('Calibrate home')).toBeTruthy();
        expect(screen.getByText('Calibrate home')).toHaveStyle({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });
        expect(screen.getByText('Terms of service')).toHaveStyle({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });
        expect(screen.queryByTestId('legal-app-header')).toBeNull();

        mockUser = { id: 7 };
        await screen.rerender(<PublicLegalPage {...props} />);
        expect(screen.getByTestId('legal-in-app-shell')).toBeTruthy();
        const appHeader = within(screen.getByTestId('legal-app-header'));
        expect(appHeader.getByRole('header', { name: 'Privacy policy' })).toBeTruthy();
        expect(appHeader.getByLabelText('App actions')).toBeTruthy();

        await fireEvent.press(appHeader.getByRole('button', { name: 'Back to Settings' }));
        expect(appHeader.queryByRole('button', { name: 'Open notifications' })).toBeNull();
        await fireEvent.press(appHeader.getByRole('button', { name: 'Account & settings' }));

        expect(mockReplace).toHaveBeenCalledWith('/settings');
        expect(mockPush).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith('/settings');
    });
});
