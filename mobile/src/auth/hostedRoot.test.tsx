/** @file Regression coverage for hosted Root: hosted web root. */

import { render } from '@testing-library/react-native';
import WebHomeRoute from '../../app/index.web';

let mockAuthState: { user: { id: number } | null; isLoading: boolean } = {
    user: null,
    isLoading: true
};

jest.mock('./AuthContext', () => ({
    useAuth: () => mockAuthState
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));

jest.mock('expo-router', () => {
    const ReactModule = require('react');
    const { Text } = require('react-native');
    return {
        Link: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
            ReactModule.createElement(Text, { style }, children),
        Redirect: ({ href }: { href: string }) => ReactModule.createElement(
            Text,
            { testID: 'hosted-root-redirect' },
            href
        )
    };
});

describe('hosted web root', () => {
    it('waits for auth before choosing the public landing or authenticated Today route', async () => {
        const screen = await render(<WebHomeRoute />);
        expect(screen.getByText('Opening Calibrate...')).toBeTruthy();
        expect(screen.queryByTestId('hosted-landing')).toBeNull();

        mockAuthState = { user: null, isLoading: false };
        await screen.rerender(<WebHomeRoute />);
        expect(screen.getByTestId('hosted-landing')).toBeTruthy();
        expect(screen.getByTestId('hosted-landing-actions')).toBeTruthy();
        expect(screen.getByText('Sign in')).toBeTruthy();
        expect(screen.getByText('Create account')).toBeTruthy();
        expect(screen.getByText('Sign in')).toHaveStyle({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });
        expect(screen.getByText('Create account')).toHaveStyle({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });

        mockAuthState = { user: { id: 7 }, isLoading: false };
        await screen.rerender(<WebHomeRoute />);
        expect(screen.getByTestId('hosted-root-redirect')).toHaveTextContent('/today');
        expect(screen.queryByTestId('hosted-landing')).toBeNull();
    });
});
