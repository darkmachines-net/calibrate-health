/** @file Regression coverage for use App Update Controller: useAppUpdateController. */

import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockCheckForUpdateAsync = jest.fn();
const mockFetchUpdateAsync = jest.fn();
const mockReloadAsync = jest.fn();
const mockUpdatesState = {
    currentlyRunning: {
        channel: 'internal',
        createdAt: new Date('2026-07-21T20:00:00.000Z'),
        emergencyLaunchReason: null,
        isEmbeddedLaunch: true,
        isEmergencyLaunch: false,
        runtimeVersion: '0.2.1',
        updateId: '01234567-89ab-4def-8123-456789abcdef'
    },
    downloadProgress: undefined,
    isChecking: false,
    isDownloading: false,
    isRestarting: false,
    isUpdateAvailable: false,
    isUpdatePending: false
};

jest.mock('expo-application', () => ({
    nativeApplicationVersion: '0.2.1',
    nativeBuildVersion: '3'
}));
jest.mock('expo-updates', () => ({
    checkForUpdateAsync: (...args: unknown[]) => mockCheckForUpdateAsync(...args),
    fetchUpdateAsync: (...args: unknown[]) => mockFetchUpdateAsync(...args),
    isEnabled: true,
    reloadAsync: (...args: unknown[]) => mockReloadAsync(...args),
    useUpdates: () => mockUpdatesState
}));
jest.mock('./appUpdate', () => {
    const actual = jest.requireActual('./appUpdate');
    return {
        ...actual,
        canManageOtaUpdates: () => true
    };
});

import { useAppUpdateController } from './useAppUpdateController';

describe('useAppUpdateController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUpdatesState.isUpdateAvailable = false;
        mockUpdatesState.isUpdatePending = false;
    });

    it('checks, downloads, and restarts into an available update', async () => {
        mockCheckForUpdateAsync.mockResolvedValue({
            isAvailable: true,
            isRollBackToEmbedded: false
        });
        mockFetchUpdateAsync.mockResolvedValue({
            isNew: true,
            isRollBackToEmbedded: false
        });
        mockReloadAsync.mockResolvedValue(undefined);
        const { result } = renderHook(() => useAppUpdateController());

        await act(async () => result.current.action());
        expect(result.current.actionTitle).toBe('Install and restart');

        await act(async () => result.current.action());
        expect(mockFetchUpdateAsync).toHaveBeenCalledTimes(1);
        expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(result.current.actionTitle).toBe('Restarting...'));
    });

    it('restarts immediately when an update is already downloaded', async () => {
        mockUpdatesState.isUpdatePending = true;
        mockReloadAsync.mockResolvedValue(undefined);
        const { result } = renderHook(() => useAppUpdateController());

        expect(result.current.actionTitle).toBe('Restart to update');
        await act(async () => result.current.action());

        expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        expect(mockFetchUpdateAsync).not.toHaveBeenCalled();
    });
});
