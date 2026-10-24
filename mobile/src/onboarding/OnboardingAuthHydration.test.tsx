/** @file Regression coverage for Onboarding Auth Hydration: onboarding direct-entry auth hydration. */

import React from 'react';
import { render } from '@testing-library/react-native';
import OnboardingScreen from '../../app/onboarding';
import { useAuth } from '../auth/AuthContext';

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async () => null),
        setItem: jest.fn(async () => undefined),
        removeItem: jest.fn(async () => undefined)
    }
}));jest.mock('../auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'onboarding-operation-id') }));
jest.mock('../offline/provider', () => ({
    useOfflineOutbox: () => ({
        enqueue: jest.fn(),
        mutations: [],
        retryFailed: jest.fn()
    })
}));
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('@tanstack/react-query', () => ({
    onlineManager: {
        subscribe: () => () => undefined,
        isOnline: () => true
    },
    useQuery: () => ({
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        fetchStatus: 'idle',
        isError: false,
        isFetching: false,
        isPending: true,
        status: 'pending',
        refetch: jest.fn()
    }),
    useMutation: () => ({
        isPending: false,
        mutate: jest.fn(),
        mutateAsync: jest.fn()
    }),
    useQueryClient: () => ({
        invalidateQueries: jest.fn(),
        setQueryData: jest.fn()
    })
}));
jest.mock('expo-router', () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    const { Text } = jest.requireActual('react-native');
    return {
        Redirect: ({ href }: { href: string }) => ReactActual.createElement(
            Text,
            { testID: 'onboarding-auth-redirect' },
            href
        ),
        router: { replace: jest.fn() }
    };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

describe('onboarding direct-entry auth hydration', () => {
    it('keeps the route mounted while auth hydrates, then redirects only a confirmed signed-out session', async () => {
        mockUseAuth.mockReturnValue({
            api: {},
            user: null,
            isLoading: true,
            updateCurrentUser: jest.fn()
        } as unknown as ReturnType<typeof useAuth>);

        const screen = await render(<OnboardingScreen />);

        expect(screen.getByText('Checking your session...')).toBeTruthy();
        expect(screen.queryByTestId('onboarding-auth-redirect')).toBeNull();

        mockUseAuth.mockReturnValue({
            api: {},
            user: null,
            isLoading: false,
            updateCurrentUser: jest.fn()
        } as unknown as ReturnType<typeof useAuth>);
        await screen.rerender(<OnboardingScreen />);

        expect(screen.getByTestId('onboarding-auth-redirect').props.children).toBe('/(auth)/login');
    });
});
