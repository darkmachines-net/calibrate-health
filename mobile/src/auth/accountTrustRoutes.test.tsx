/** @file Regression coverage for account Trust Routes: account trust routes. */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import VerifyEmailRoute from '../../app/verify-email';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from './AuthContext';

jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));
jest.mock('expo-router', () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    return {
        useLocalSearchParams: jest.fn(),
        router: { replace: jest.fn() },
        Link: ({ children }: { children: React.ReactElement }) =>
            ReactActual.createElement(ReactActual.Fragment, null, children)
    };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseLocalSearchParams = useLocalSearchParams as jest.MockedFunction<typeof useLocalSearchParams>;

describe('account trust routes', () => {
    beforeEach(() => {
        mockUseLocalSearchParams.mockReturnValue({});
    });
    it('keeps logout, support, export, and deletion discoverable for an unverified session', () => {
        const logout = jest.fn(async () => undefined);
        mockUseAuth.mockReturnValue({
            api: {
                confirmEmailVerification: jest.fn(),
                resendEmailVerification: jest.fn()
            },
            user: {
                id: 7,
                email: 'person@example.com',
                account_access: {
                    state: 'email_verification_required',
                    email_verified: false,
                    legal_current: true
                }
            },
            updateCurrentUser: jest.fn(),
            logout
        } as unknown as ReturnType<typeof useAuth>);

        const screen = render(<VerifyEmailRoute />);

        expect(screen.getByText('Support')).toBeTruthy();
        expect(screen.getByText('Account data and deletion')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
        fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
        expect(logout).toHaveBeenCalledTimes(1);
    });

    it('refreshes the signed-in account after consuming a verification token', async () => {
        const signedInUser = {
            id: 7,
            email: 'signed-in@example.com',
            account_access: {
                state: 'full',
                email_verified: true,
                legal_current: true
            }
        };
        const tokenUser = {
            ...signedInUser,
            id: 8,
            email: 'token-owner@example.com'
        };
        const confirmEmailVerification = jest.fn(async () => ({ user: tokenUser }));
        const getMe = jest.fn(async () => ({ user: signedInUser }));
        const updateCurrentUser = jest.fn();
        mockUseLocalSearchParams.mockReturnValue({ token: 'verification-token' });
        mockUseAuth.mockReturnValue({
            api: {
                confirmEmailVerification,
                getMe,
                resendEmailVerification: jest.fn()
            },
            user: signedInUser,
            updateCurrentUser,
            logout: jest.fn(async () => undefined)
        } as unknown as ReturnType<typeof useAuth>);

        render(<VerifyEmailRoute />);

        await waitFor(() => {
            expect(confirmEmailVerification).toHaveBeenCalledWith({ token: 'verification-token' });
            expect(getMe).toHaveBeenCalledTimes(1);
            expect(updateCurrentUser).toHaveBeenCalledWith(signedInUser);
        });
        expect(updateCurrentUser).not.toHaveBeenCalledWith(tokenUser);
    });
});
