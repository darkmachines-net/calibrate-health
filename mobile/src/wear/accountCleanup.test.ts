/** @file Regression coverage for account Cleanup: Wear account cleanup. */

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('@calibrate/wear-pairing', () => ({ __esModule: true, default: null }));

import { clearWearAccountData } from './accountCleanup';

const pairing = {
    nodeId: 'node-1',
    watchDeviceId: 'watch-1',
    watchDeviceName: 'Galaxy Watch Ultra',
    serverOrigin: 'https://health.example',
    pairedAt: '2026-07-12T20:00:00.000Z'
};

describe('Wear account cleanup', () => {
    const readPairing = jest.fn();
    const sendDisconnect = jest.fn(async () => undefined);
    const clearPairing = jest.fn(async () => undefined);
    const clearInvalidation = jest.fn(async () => undefined);
    const clearHandoffs = jest.fn(async () => undefined);
    const dependencies = { readPairing, sendDisconnect, clearPairing, clearInvalidation, clearHandoffs };

    beforeEach(() => {
        jest.clearAllMocks();
        readPairing.mockResolvedValue(pairing);
    });

    it('sends the watch erase command before clearing every phone-side namespace', async () => {
        await clearWearAccountData(pairing.serverOrigin, 7, dependencies);

        expect(sendDisconnect).toHaveBeenCalledWith({ pairing, userId: 7 });
        expect(clearPairing).toHaveBeenCalledWith(pairing.serverOrigin, 7);
        expect(clearInvalidation).toHaveBeenCalledWith(pairing.serverOrigin, 7);
        expect(clearHandoffs).toHaveBeenCalledWith(pairing.serverOrigin, 7);
    });

    it('retains phone pairing metadata until the watch cleanup ACK resolves', async () => {
        let confirmWatchCleanup: (() => void) | undefined;
        sendDisconnect.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
            confirmWatchCleanup = () => resolve(undefined);
        }));

        const cleanup = clearWearAccountData(pairing.serverOrigin, 7, dependencies);
        await Promise.resolve();
        await Promise.resolve();
        expect(clearPairing).not.toHaveBeenCalled();

        confirmWatchCleanup?.();
        await cleanup;
        expect(clearPairing).toHaveBeenCalledWith(pairing.serverOrigin, 7);
    });

    it('clears all phone state and reports recovery when the paired watch is unreachable', async () => {
        sendDisconnect.mockRejectedValueOnce(new Error('offline'));

        await expect(clearWearAccountData(pairing.serverOrigin, 7, dependencies)).rejects.toThrow('watch was unreachable');
        expect(clearPairing).toHaveBeenCalledTimes(1);
        expect(clearInvalidation).toHaveBeenCalledTimes(1);
        expect(clearHandoffs).toHaveBeenCalledTimes(1);
    });

    it('does not send a command when this account has no paired watch', async () => {
        readPairing.mockResolvedValueOnce(null);

        await clearWearAccountData(pairing.serverOrigin, 7, dependencies);
        expect(sendDisconnect).not.toHaveBeenCalled();
    });
});
