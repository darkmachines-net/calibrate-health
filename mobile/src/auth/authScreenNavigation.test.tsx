/** @file Regression coverage for auth Screen Navigation: auth screen server navigation. */

import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import LoginScreen from '../../app/(auth)/login';
import RegisterScreen from '../../app/(auth)/register';
import { useAuth } from './AuthContext';
import { Link, useLocalSearchParams } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';

jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../account/accountDeletionNotice', () => ({ accountDeletionCleanupGuidance: jest.fn(() => '') }));
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));
jest.mock('expo-router', () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    return {
        useLocalSearchParams: jest.fn(),
        Link: jest.fn(({ children }: { children: React.ReactNode }) =>
            ReactActual.createElement(require('react-native').Text, null, children))
    };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseLocalSearchParams = useLocalSearchParams as jest.MockedFunction<typeof useLocalSearchParams>;
const mockLink = Link as unknown as jest.Mock;
const SELF_HOSTED_URL = 'http://127.0.0.1:3300';
const HOSTED_URL = 'https://calibratehealth.app';

function authContextStub() {
    return {
        register: jest.fn(async () => true),
        login: jest.fn(async () => true),
        serverUrl: 'http://10.0.2.2:3000',
        setServerUrl: jest.fn(async () => true),
        testServerUrl: jest.fn(async () => true),
        serverConnection: {
            status: 'connected' as const,
            testedInput: SELF_HOSTED_URL,
            testedUrl: SELF_HOSTED_URL,
            message: 'Connected to Calibrate 1.0.0 (API v1).'
        },
        authError: null,
        accountDeletionCleanupNotice: null,
        acknowledgeAccountDeletionCleanupNotice: jest.fn(async () => undefined)
    };
}

function expectAuthLink(pathname: string) {
    const linkProps = mockLink.mock.calls
        .map(([props]) => props)
        .find((props) => props.href?.pathname === pathname);
    expect(linkProps).toBeDefined();
    expect(linkProps.href).toEqual({
        pathname,
        params: { serverUrl: SELF_HOSTED_URL }
    });
    expect(linkProps.children.props.accessibilityRole).toBe('link');
}

describe('auth screen server navigation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUseLocalSearchParams.mockReturnValue({ serverUrl: SELF_HOSTED_URL });
        mockUseAuth.mockReturnValue(authContextStub() as unknown as ReturnType<typeof useAuth>);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('carries the login server draft into the registration link', async () => {
        const screen = await render(<LoginScreen />);

        expect(screen.queryByText(SELF_HOSTED_URL)).toBeNull();
        await fireEvent.press(screen.getByLabelText('Show advanced connection options'));
        expect(screen.getByLabelText('Server URL')).toHaveProp('value', SELF_HOSTED_URL);
        expectAuthLink('/(auth)/register');
    });

    it('carries the registration server draft back to the login link', async () => {
        const screen = await render(<RegisterScreen />);

        expect(screen.queryByText(SELF_HOSTED_URL)).toBeNull();
        await fireEvent.press(screen.getByLabelText('Show advanced connection options'));
        expect(screen.getByLabelText('Server URL')).toHaveProp('value', SELF_HOSTED_URL);
        expectAuthLink('/(auth)/login');
    });

    it('submits login credentials with the routed server draft', async () => {
        const auth = authContextStub();
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<LoginScreen />);

        await fireEvent.changeText(screen.getByLabelText('Email'), 'user@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret');
        await fireEvent.press(screen.getByLabelText('Sign in'));

        await waitFor(() => {
            expect(auth.login).toHaveBeenCalledWith('user@example.com', 'secret', SELF_HOSTED_URL);
        });
    });

    it('submits registration credentials with the routed server draft', async () => {
        const auth = authContextStub();
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<RegisterScreen />);

        await fireEvent.changeText(screen.getByLabelText('Email'), 'new@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret12');
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'secret12');
        expect(screen.queryByRole('checkbox')).toBeNull();
        await fireEvent.press(screen.getByLabelText('Create account'));

        await waitFor(() => {
            expect(auth.register).toHaveBeenCalledWith('new@example.com', 'secret12', SELF_HOSTED_URL, {
                acceptTerms: false,
                acceptPrivacy: false
            });
        });
    });

    it('shows actionable registration credential validation', async () => {
        const auth = authContextStub();
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<RegisterScreen />);

        await fireEvent.changeText(screen.getByLabelText('Email'), 'not-an-email');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret12');
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'secret12');
        await fireEvent.press(screen.getByLabelText('Create account'));

        expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
        expect(auth.register).not.toHaveBeenCalled();

        await fireEvent.changeText(screen.getByLabelText('Email'), 'new@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'short');
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'short');
        await fireEvent.press(screen.getByLabelText('Create account'));

        expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters.');

        const oversizedPassword = String.fromCodePoint(0x1f600).repeat(19);
        await fireEvent.changeText(screen.getByLabelText('Password'), oversizedPassword);
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), oversizedPassword);
        await fireEvent.press(screen.getByLabelText('Create account'));

        expect(screen.getByRole('alert')).toHaveTextContent('Password must be at most 72 bytes.');
        expect(auth.register).not.toHaveBeenCalled();
    });


    it('requires both legal choices for hosted account creation', async () => {
        const auth = authContextStub();
        auth.serverUrl = HOSTED_URL;
        mockUseLocalSearchParams.mockReturnValue({ serverUrl: HOSTED_URL });
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<RegisterScreen />);

        await fireEvent.changeText(screen.getByLabelText('Email'), 'new@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'password123');
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'password123');
        await fireEvent.press(screen.getByLabelText('Create account'));

        expect(screen.getByRole('alert')).toHaveTextContent('Review and accept both legal documents to create an account.');
        expect(auth.register).not.toHaveBeenCalled();
    });
    it('hides server selection and uses the serving server on web', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        const auth = authContextStub();
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<LoginScreen />);

        expect(screen.queryByText(SELF_HOSTED_URL)).toBeNull();
        expect(screen.queryByLabelText('Show advanced connection options')).toBeNull();

        await fireEvent.changeText(screen.getByLabelText('Email'), 'user@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret');
        await fireEvent.press(screen.getByLabelText('Sign in'));

        await waitFor(() => {
            expect(auth.login).toHaveBeenCalledWith(
                'user@example.com',
                'secret',
                auth.serverUrl
            );
        });
        expect(mockLink.mock.calls.some(([props]) => props.href === '/(auth)/register')).toBe(true);
    });

    it('uses canonical privacy, terms, and support destinations on auth surfaces', async () => {
        await render(<LoginScreen />);
        await render(<RegisterScreen />);

        const destinations = mockLink.mock.calls.map(([props]) => props.href);
        expect(destinations).toEqual(expect.arrayContaining([
            CALIBRATE_PRODUCT_LINKS.privacy,
            CALIBRATE_PRODUCT_LINKS.terms,
            CALIBRATE_PRODUCT_LINKS.support
        ]));
    });

    it('restores the create-account action after registration fails', async () => {
        const auth = authContextStub();
        auth.register.mockRejectedValueOnce(new Error('Unable to create account'));
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<RegisterScreen />);

        await fireEvent.changeText(screen.getByLabelText('Email'), 'existing@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret12');
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'secret12');
        await fireEvent.press(screen.getByLabelText('Create account'));

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Unable to create account. Try again.');
        });
        const createAccountButton = screen.getByRole('button', { name: 'Create account' });
        expect(within(createAccountButton).getByText('Create account')).toBeTruthy();
    });

    it('prevents account creation when password confirmation does not match', async () => {
        const auth = authContextStub();
        mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
        const screen = await render(<RegisterScreen />);

        await fireEvent.changeText(screen.getByLabelText('Email'), 'new@example.com');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret12');
        await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'different12');
        await fireEvent.press(screen.getByLabelText('Create account'));

        expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
        expect(auth.register).not.toHaveBeenCalled();
    });
});
