/** @file Regression coverage for Android Integration Settings Screens: mounts the connection controls on Android. */

import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import HealthConnectSettingsScreen from '../../app/(tabs)/(settings)/health-connect';
import WatchSettingsScreen from '../../app/(tabs)/(settings)/watch';
import { HealthConnectCard } from '../components/HealthConnectCard';
import { WearPairingCard } from '../components/WearPairingCard';

jest.mock('../components/TabScreen', () => ({ TabScreen: require('react-native').View }));
jest.mock('../components/HealthConnectCard', () => ({ HealthConnectCard: jest.fn(() => null) }));
jest.mock('../components/WearPairingCard', () => ({ WearPairingCard: jest.fn(() => null) }));

describe.each([
    [HealthConnectSettingsScreen, HealthConnectCard, 'Health Connect is available in the Android app.'],
    [WatchSettingsScreen, WearPairingCard, 'Galaxy Watch pairing is available in the Android app.']
] as const)('Android integration route', (SettingsScreen, IntegrationCard, unavailableMessage) => {
    beforeEach(() => { jest.clearAllMocks(); });
    afterEach(() => { jest.restoreAllMocks(); });

    it.each(['ios', 'web'] as const)('does not mount native integration controls on %s direct entry', async (platform) => {
        jest.replaceProperty(Platform, 'OS', platform);
        const screen = await render(<SettingsScreen />);
        expect(screen.getByText(unavailableMessage)).toBeOnTheScreen();
        expect(IntegrationCard).not.toHaveBeenCalled();
    });

    it('mounts the connection controls on Android', async () => {
        jest.replaceProperty(Platform, 'OS', 'android');
        await render(<SettingsScreen />);
        expect(IntegrationCard).toHaveBeenCalled();
    });
});
