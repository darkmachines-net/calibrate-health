/** @file Regression coverage for pairing Poll: Wear pairing inbox polling. */

import { pollWearPairingInbox, type WearPairingInboxCheck } from './pairingPoll';

const paired = {
    nodeId: 'node-1',
    watchDeviceId: 'watch-1',
    watchDeviceName: 'Galaxy Watch Ultra',
    serverOrigin: 'https://health.example',
    pairedAt: '2026-07-15T12:00:00.000Z'
};

const emptyResult: WearPairingInboxCheck = { processed: 0, paired: null, errors: [] };

describe('Wear pairing inbox polling', () => {
    it('processes delayed hello and result messages from one polling run', async () => {
        let clock = 0;
        const processInbox = jest.fn()
            .mockResolvedValueOnce({ processed: 1, paired: null, errors: [] })
            .mockResolvedValueOnce({ processed: 1, paired, errors: [] });
        const onProgress = jest.fn();

        const result = await pollWearPairingInbox({
            processInbox,
            onProgress,
            now: () => clock,
            wait: async (milliseconds) => { clock += milliseconds; },
            intervalMs: 100,
            timeoutMs: 1_000
        });

        expect(result).toEqual({
            processed: 2,
            paired,
            errors: [],
            timedOut: false,
            cancelled: false
        });
        expect(processInbox).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('stops immediately when the inbox reports an error', async () => {
        let clock = 0;
        const processInbox = jest.fn().mockResolvedValue({
            processed: 0,
            paired: null,
            errors: ['Credential rejected']
        });

        const result = await pollWearPairingInbox({
            processInbox,
            now: () => clock,
            wait: async (milliseconds) => { clock += milliseconds; },
            intervalMs: 100,
            timeoutMs: 1_000
        });

        expect(result.errors).toEqual(['Credential rejected']);
        expect(result.timedOut).toBe(false);
        expect(processInbox).toHaveBeenCalledTimes(1);
    });

    it('bounds empty inbox reads by the timeout', async () => {
        let clock = 0;
        const processInbox = jest.fn().mockResolvedValue(emptyResult);

        const result = await pollWearPairingInbox({
            processInbox,
            now: () => clock,
            wait: async (milliseconds) => { clock += milliseconds; },
            intervalMs: 100,
            timeoutMs: 350
        });

        expect(result.timedOut).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(processInbox).toHaveBeenCalledTimes(3);
    });

    it('cancels without another inbox read when the screen scope changes', async () => {
        let active = true;
        const processInbox = jest.fn().mockResolvedValue(emptyResult);

        const result = await pollWearPairingInbox({
            processInbox,
            isActive: () => active,
            wait: async () => { active = false; }
        });

        expect(result.cancelled).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(processInbox).not.toHaveBeenCalled();
    });
});
