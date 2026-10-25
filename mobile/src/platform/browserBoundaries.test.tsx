/** @file Regression coverage for browser Boundaries: browser-native feature boundaries. */

import React from 'react';
import { render, renderHook, waitFor } from '@testing-library/react-native';
import { NATIVE_PUSH_STATES } from '../notifications/workflow';
import { HealthConnectProvider, useHealthConnect } from '../healthConnect/provider.web';
import {
    NativePushRegistrationProvider,
    useNativePushRegistration
} from '../hooks/useNativePushRegistration.web';
import { WearPairingCard } from '../components/WearPairingCard.web';

jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ api: {}, user: { id: 1 } })
}));

describe('browser-native feature boundaries', () => {
    it('exposes Health Connect as unavailable without initializing Android APIs', async () => {
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <HealthConnectProvider>{children}</HealthConnectProvider>
        );
        const { result } = await renderHook(() => useHealthConnect(), { wrapper });

        expect(result.current.connection).toEqual({
            availability: 'not_android',
            initialized: false,
            grantedFeatures: []
        });
        expect(result.current.error).toBeNull();
        await expect(result.current.connect()).rejects.toThrow(/Android app/i);
    });

    it('keeps native push permission and registration flows unsupported', async () => {
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <NativePushRegistrationProvider>{children}</NativePushRegistrationProvider>
        );
        const { result } = await renderHook(() => useNativePushRegistration(), { wrapper });

        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.UNSUPPORTED));
        await expect(result.current.requestPermission()).resolves.toBeUndefined();
        await expect(result.current.retryRegistration()).resolves.toBeUndefined();
    });

    it('renders intentional Wear guidance without initializing the native bridge', async () => {
        const standalone = await render(<WearPairingCard />);
        expect(standalone.getByText('Wear OS')).toBeTruthy();
        expect(standalone.getByText(/Android app/i)).toBeTruthy();

    });
});
