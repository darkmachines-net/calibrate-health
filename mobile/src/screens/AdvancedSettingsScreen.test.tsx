/** @file Regression coverage for Advanced Settings Screen: AdvancedSettingsScreen. */

/**
 * Exercises the consolidated Advanced settings route and interaction boundaries.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
/**
 * Exercises the consolidated Advanced settings route and interaction boundaries.
 */
import { Platform } from 'react-native';
/**
 * Exercises the consolidated Advanced settings route and interaction boundaries.
 */
import { HOSTED_SERVER_URL } from '../config/server';
/**
 * Exercises the consolidated Advanced settings route and interaction boundaries.
 */
import { useAuth } from '../auth/AuthContext';
/**
 * Exercises the consolidated Advanced settings route and interaction boundaries.
 */
import { useAppUpdateController } from '../updates/useAppUpdateController';
/**
 * Exercises the consolidated Advanced settings route and interaction boundaries.
 */
import AdvancedSettingsScreen from '../../app/(tabs)/(settings)/advanced';

jest.mock('@expo/vector-icons/Ionicons', () => ({
    __esModule: true,
    default: () => null
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));
jest.mock('../auth/AuthContext', () => ({
    useAuth: jest.fn()
}));
jest.mock('../updates/useAppUpdateController', () => ({
    useAppUpdateController: jest.fn()
}));

const mockedUseAuth = jest.mocked(useAuth);
const mockedUseAppUpdateController = jest.mocked(useAppUpdateController);
const mockSetServerUrl = jest.fn(async () => true);
const mockTestServerUrl = jest.fn(async () => true);

/** Build a complete update-controller fixture with optional state overrides. */
function updateController(overrides: Partial<ReturnType<typeof useAppUpdateController>> = {}) {
    return {
        action: jest.fn(async () => undefined),
        actionTitle: 'Check for updates',
        downloadProgress: undefined,
        isBusy: false,
        isSupported: true,
        isUpdateAvailable: false,
        isUpdatePending: false,
        manualPhase: 'idle' as const,
        status: 'Calibrate checks automatically when it opens. You can also check manually.',
        versionInfo: {
            nativeVersion: '0.2.5',
            nativeBuild: '7',
            nativeReleaseTag: 'v0.13.2',
            runtimeVersion: '0.2.5',
            channel: 'internal',
            updateId: null,
            updateLabel: 'Embedded in native build',
            updateCreatedAt: new Date('2026-08-09T20:00:00.000Z'),
            isEmbeddedLaunch: true,
            isEmergencyLaunch: false,
            emergencyLaunchReason: null
        },
        ...overrides
    } as ReturnType<typeof useAppUpdateController>;
}

describe('AdvancedSettingsScreen', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedUseAuth.mockReturnValue({
            serverUrl: HOSTED_SERVER_URL,
            serverConnection: {
                status: 'idle',
                testedInput: null,
                testedUrl: null,
                message: 'Test this address before continuing.'
            },
            setServerUrl: mockSetServerUrl,
            testServerUrl: mockTestServerUrl
        } as unknown as ReturnType<typeof useAuth>);
        mockedUseAppUpdateController.mockReturnValue(updateController());
    });

    it('combines connection, diagnostics, and software updates on one page', () => {
        const view = render(<AdvancedSettingsScreen />);

        expect(view.getByRole('header', { name: 'Connection' })).toBeTruthy();
        expect(view.getByRole('header', { name: 'Diagnostics' })).toBeTruthy();
        expect(view.getByRole('header', { name: 'Software updates' })).toBeTruthy();
        expect(view.getByLabelText('Server URL')).toBeTruthy();
        expect(view.getByText(HOSTED_SERVER_URL)).toBeTruthy();
        expect(view.getByText('0.2.5 (build 7)')).toBeTruthy();
    });

    it('tests and saves a selected server from the route', async () => {
        const view = render(<AdvancedSettingsScreen />);
        const serverUrl = 'https://self-hosted.example.invalid';

        fireEvent.changeText(view.getByLabelText('Server URL'), serverUrl);
        fireEvent.press(view.getByRole('button', { name: 'Test Calibrate server connection' }));
        fireEvent.press(view.getByRole('button', { name: 'Save connection' }));

        expect(mockTestServerUrl).toHaveBeenCalledWith(serverUrl);
        await waitFor(() => expect(mockSetServerUrl).toHaveBeenCalledWith(serverUrl));
    });

    it('does not offer the origin-bound server editor on web', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'web');
        try {
            const view = render(<AdvancedSettingsScreen />);

            expect(view.queryByRole('header', { name: 'Connection' })).toBeNull();
            expect(view.queryByLabelText('Server URL')).toBeNull();
            expect(view.queryByRole('button', { name: 'Save connection' })).toBeNull();
            expect(view.getByRole('header', { name: 'Diagnostics' })).toBeTruthy();
        } finally {
            platform.restore();
        }
    });

    it('uses iOS diagnostics and native-update copy on Apple devices', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'ios');
        try {
            const view = render(<AdvancedSettingsScreen />);

            expect(view.getByText('iOS')).toBeTruthy();
            expect(view.getByText(/OTA updates can change iOS JavaScript and assets/)).toBeTruthy();
        } finally {
            platform.restore();
        }
    });

    it('offers the update action from Advanced settings', () => {
        const action = jest.fn(async () => undefined);
        mockedUseAppUpdateController.mockReturnValue(updateController({
            action,
            actionTitle: 'Install and restart',
            isUpdateAvailable: true,
            manualPhase: 'available',
            status: 'A compatible OTA update is available and ready to download.'
        }));

        const view = render(<AdvancedSettingsScreen />);
        fireEvent.press(view.getByRole('button', { name: 'Install and restart' }));

        expect(action).toHaveBeenCalledTimes(1);
    });
});
