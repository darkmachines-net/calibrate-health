/** @file Regression coverage for Client Upgrade Required Screen: ClientUpgradeRequiredScreen. */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ClientUpgradeRequiredScreen } from './ClientUpgradeRequiredScreen';

const requirement = {
    code: 'CLIENT_UPGRADE_REQUIRED' as const,
    platform: 'android_phone' as const,
    current_version: '0.1.0',
    minimum_supported_version: '0.2.0',
    message: 'Update Calibrate for Android to version 0.2.0 or newer to continue.',
    retryable: false as const
};

describe('ClientUpgradeRequiredScreen', () => {
    it('explains the version floor and preserves explicit recovery choices', () => {
        const view = render(
            <ClientUpgradeRequiredScreen
                requirement={requirement}
                serverUrl="https://health.example.com"
                onRecheck={jest.fn(async () => false)}
                onChooseServer={jest.fn(async () => undefined)}
            />
        );

        expect(view.getByRole('header')).toHaveTextContent('Update Calibrate to continue');
        expect(view.getByText(/Android version 0.2.0 or newer/)).toBeTruthy();
        expect(view.getByText(/pending offline changes are still stored/)).toBeTruthy();
        expect(view.getByText('https://health.example.com')).toBeTruthy();
        expect(view.getByLabelText('Check again')).toBeTruthy();
        expect(view.getByLabelText('Sign out and choose another server')).toBeTruthy();
    });

    it('renders the iOS version floor without Android-only copy', () => {
        const view = render(
            <ClientUpgradeRequiredScreen
                requirement={{ ...requirement, platform: 'ios', message: 'Update Calibrate for iOS.' }}
                serverUrl="https://health.example.com"
                onRecheck={jest.fn(async () => false)}
                onChooseServer={jest.fn(async () => undefined)}
            />
        );

        expect(view.getByText(/iOS version 0.2.0 or newer/)).toBeTruthy();
        expect(view.queryByText(/Android version/)).toBeNull();
    });

    it('rechecks without clearing local state and reports a still-incompatible server', async () => {
        const onRecheck = jest.fn(async () => false);
        const onChooseServer = jest.fn(async () => undefined);
        const view = render(
            <ClientUpgradeRequiredScreen
                requirement={requirement}
                serverUrl="https://health.example.com"
                onRecheck={onRecheck}
                onChooseServer={onChooseServer}
            />
        );

        fireEvent.press(view.getByLabelText('Check again'));
        await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
        expect(await view.findByText(/still requires a newer Calibrate version/)).toBeTruthy();
        expect(onChooseServer).not.toHaveBeenCalled();
    });
});
