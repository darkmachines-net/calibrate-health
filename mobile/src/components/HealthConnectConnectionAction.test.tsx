/** @file Regression coverage for Health Connect Connection Action: HealthConnectConnectionAction. */

import { fireEvent, render } from '@testing-library/react-native';
import { useHealthConnect } from '../healthConnect/provider';
import { DEFAULT_HEALTH_CONNECT_SELECTION } from '../healthConnect/types';
import { HealthConnectConnectionAction } from './HealthConnectConnectionAction';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../healthConnect/provider', () => ({ useHealthConnect: jest.fn() }));

const mockUseHealthConnect = useHealthConnect as jest.MockedFunction<typeof useHealthConnect>;

function healthConnectValue(overrides: Partial<ReturnType<typeof useHealthConnect>> = {}) {
    return {
        connected: false,
        paused: false,
        selection: DEFAULT_HEALTH_CONNECT_SELECTION,
        connection: {
            availability: 'available' as const,
            initialized: true,
            grantedFeatures: []
        },
        isLoading: false,
        isBusy: false,
        isSyncing: false,
        lastRefreshedAt: null,
        lastSuccessfulSyncAt: null,
        error: null,
        syncError: null,
        restartMessage: null,
        connect: jest.fn(async () => undefined),
        refresh: jest.fn(async () => undefined),
        sync: jest.fn(async () => undefined),
        setFeatureEnabled: jest.fn(async () => undefined),
        setPaused: jest.fn(async () => undefined),
        manageAccess: jest.fn(async () => undefined),
        updateProvider: jest.fn(async () => undefined),
        disconnect: jest.fn(async () => undefined),
        clearAccountData: jest.fn(async () => undefined),
        ...overrides
    } satisfies ReturnType<typeof useHealthConnect>;
}

describe('HealthConnectConnectionAction', () => {
    it('offers one Connect action while disconnected', () => {
        const value = healthConnectValue();
        mockUseHealthConnect.mockReturnValue(value);
        const screen = render(<HealthConnectConnectionAction />);

        fireEvent.press(screen.getByRole('button', { name: 'Connect Health Connect' }));

        expect(value.connect).toHaveBeenCalledTimes(1);
        expect(value.manageAccess).not.toHaveBeenCalled();
        expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('maps denied selected access to one Manage action', () => {
        const value = healthConnectValue({ connected: true });
        mockUseHealthConnect.mockReturnValue(value);
        const screen = render(<HealthConnectConnectionAction />);

        fireEvent.press(screen.getByRole('button', { name: 'Manage Health Connect' }));

        expect(value.manageAccess).toHaveBeenCalledTimes(1);
        expect(value.connect).not.toHaveBeenCalled();
        expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('offers the provider update and hides unsupported actions', () => {
        const value = healthConnectValue({
            connection: {
                availability: 'provider_update_required',
                initialized: false,
                grantedFeatures: []
            }
        });
        mockUseHealthConnect.mockReturnValue(value);
        const screen = render(<HealthConnectConnectionAction />);

        fireEvent.press(screen.getByRole('button', { name: 'Update Health Connect' }));
        expect(value.updateProvider).toHaveBeenCalledTimes(1);

        mockUseHealthConnect.mockReturnValue(healthConnectValue({
            connection: { availability: 'not_android', initialized: false, grantedFeatures: [] }
        }));
        screen.rerender(<HealthConnectConnectionAction />);
        expect(screen.toJSON()).toBeNull();
    });

    it('announces the busy action and disables it during connection work', () => {
        mockUseHealthConnect.mockReturnValue(healthConnectValue({ isBusy: true }));
        const screen = render(<HealthConnectConnectionAction />);
        const action = screen.getByRole('button', { name: 'Connecting...' });

        expect(action).toHaveProp('accessibilityState', { busy: true, disabled: true });
    });
});
