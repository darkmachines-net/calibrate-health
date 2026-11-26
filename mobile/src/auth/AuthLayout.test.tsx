/** @file Regression coverage for AuthLayout: account-deletion cleanup notice renders login without redirecting in a loop. */

import React from 'react';
import { render } from '@testing-library/react-native';
import AuthLayout from '../../app/(auth)/_layout';
import { useAuth } from './AuthContext';
import { Redirect, Stack, useLocalSearchParams, useSegments } from 'expo-router';

jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../components/LoadingState', () => ({
    LoadingState: () => require('react').createElement(require('react-native').Text, null, 'Loading')
}));
jest.mock('expo-router', () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    const { Text: RNText } = require('react-native');
    return {
        Redirect: jest.fn(({ href }: { href: string }) =>
            ReactActual.createElement(RNText, null, `Redirect:${href}`)),
        Stack: jest.fn(() => ReactActual.createElement(RNText, null, 'AuthStack')),
        useLocalSearchParams: jest.fn(),
        useSegments: jest.fn()
    };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseSegments = useSegments as jest.MockedFunction<typeof useSegments>;
const mockUseLocalSearchParams = useLocalSearchParams as jest.MockedFunction<typeof useLocalSearchParams>;
const mockRedirect = Redirect as unknown as jest.Mock;
const mockStack = Stack as unknown as jest.Mock;

describe('AuthLayout account-deletion cleanup notice routing', () => {
    const notice = {
        deletedAt: '2026-11-25T00:00:00.000Z',
        serverUrl: 'https://calibratehealth.app',
        appDataCleanupRequired: true,
        healthConnectRestartRequired: false,
        wearDisconnectRequired: false
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseLocalSearchParams.mockReturnValue({});
        mockUseAuth.mockReturnValue({
            user: null,
            isLoading: false,
            accountDeletionCleanupNotice: notice
        } as unknown as ReturnType<typeof useAuth>);
    });

    it('renders the auth stack when already on /(auth)/login so the cleanup notice can be dismissed', async () => {
        mockUseSegments.mockReturnValue(['(auth)', 'login'] as unknown as ReturnType<typeof useSegments>);
        const screen = await render(<AuthLayout />);

        expect(screen.getByText('AuthStack')).toBeTruthy();
        expect(mockStack).toHaveBeenCalledTimes(1);
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('redirects non-login auth routes to /(auth)/login while a cleanup notice is active', async () => {
        mockUseSegments.mockReturnValue(['(auth)', 'register'] as unknown as ReturnType<typeof useSegments>);
        const screen = await render(<AuthLayout />);

        expect(screen.getByText('Redirect:/(auth)/login')).toBeTruthy();
        expect(mockRedirect).toHaveBeenCalledTimes(1);
        expect(mockStack).not.toHaveBeenCalled();
    });
});
