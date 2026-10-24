/** @file Regression coverage for sync Invalidation: Wear sync invalidation coordinator. */

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); })
    }
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-invalidation') }));
jest.mock('@calibrate/wear-pairing', () => ({ __esModule: true, default: null }));

import {
    flushWearSyncInvalidation,
    queueWearSyncInvalidation,
    type SyncInvalidationTransport
} from './syncInvalidation';
import type { StoredWearPairing } from './pairing';

const ORIGIN = 'https://health.example';
const USER_ID = 7;
const NOW = 1_800_000_000_000;
const PAIRING: StoredWearPairing = {
    nodeId: 'paired-node',
    watchDeviceId: 'watch-1',
    watchDeviceName: 'Galaxy Watch Ultra',
    serverOrigin: ORIGIN,
    pairedAt: '2026-07-11T20:00:00.000Z'
};

function transport(): jest.Mocked<SyncInvalidationTransport> {
    return { sendMessage: jest.fn().mockResolvedValue(1) };
}

describe('Wear sync invalidation coordinator', () => {
    beforeEach(() => {
        mockStorage.clear();
        jest.clearAllMocks();
    });

    it('persists before sending only bounded account metadata to the exact paired node', async () => {
        const native = transport();
        const result = await queueWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: async () => PAIRING,
            nowEpochMs: NOW,
            invalidationId: 'invalidate-1'
        });

        expect(result).toEqual({ status: 'sent', invalidationId: 'invalidate-1' });
        expect(native.sendMessage).toHaveBeenCalledWith(
            'paired-node',
            '/calibrate/v1/sync/invalidate',
            expect.stringContaining('"watch_device_id":"watch-1"')
        );
        const sentPayload = JSON.parse(native.sendMessage.mock.calls[0][2]) as Record<string, unknown>;
        expect(sentPayload).toEqual({
            kind: 'sync_invalidation',
            protocol_version: 1,
            invalidation_id: 'invalidate-1',
            server_origin: ORIGIN,
            user_id: USER_ID,
            watch_device_id: 'watch-1',
            issued_at_epoch_ms: NOW,
            expires_at_epoch_ms: NOW + 10 * 60 * 1000
        });
        expect(JSON.stringify(sentPayload)).not.toMatch(/calories|weight|food|token/i);
        expect(mockStorage.size).toBe(0);
    });

    it('retains one coalesced invalidation across disconnect and retries it unchanged', async () => {
        const offline = transport();
        offline.sendMessage.mockRejectedValue(new Error('Bluetooth unavailable'));
        await expect(queueWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: offline,
            readPairing: async () => PAIRING,
            nowEpochMs: NOW,
            invalidationId: 'invalidate-2'
        })).resolves.toEqual({ status: 'pending', invalidationId: 'invalidate-2' });
        expect(mockStorage.size).toBe(1);

        const online = transport();
        await expect(flushWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: online,
            readPairing: async () => PAIRING,
            nowEpochMs: NOW + 1_000
        })).resolves.toEqual({ status: 'sent', invalidationId: 'invalidate-2' });
        expect(online.sendMessage.mock.calls[0][2]).toContain('"invalidation_id":"invalidate-2"');
        expect(mockStorage.size).toBe(0);
    });

    it('coalesces repeated disconnected mutations to the newest bounded signal', async () => {
        const offline = transport();
        offline.sendMessage.mockRejectedValue(new Error('offline'));
        const common = {
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: offline,
            readPairing: async () => PAIRING
        };
        await queueWearSyncInvalidation({ ...common, nowEpochMs: NOW, invalidationId: 'invalidate-old' });
        await queueWearSyncInvalidation({ ...common, nowEpochMs: NOW + 1, invalidationId: 'invalidate-new' });
        expect(mockStorage.size).toBe(1);

        const online = transport();
        await flushWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: online,
            readPairing: async () => PAIRING,
            nowEpochMs: NOW + 2
        });
        expect(online.sendMessage.mock.calls[0][2]).toContain('"invalidation_id":"invalidate-new"');
        expect(online.sendMessage.mock.calls[0][2]).not.toContain('invalidate-old');
    });

    it('drops pending coordination when pairing node or account binding changes', async () => {
        const offline = transport();
        offline.sendMessage.mockRejectedValue(new Error('offline'));
        await queueWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: offline,
            readPairing: async () => PAIRING,
            nowEpochMs: NOW,
            invalidationId: 'invalidate-3'
        });

        const native = transport();
        await expect(flushWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: async () => ({ ...PAIRING, nodeId: 'replacement-node' }),
            nowEpochMs: NOW + 1_000
        })).resolves.toEqual({ status: 'unpaired', invalidationId: null });
        expect(native.sendMessage).not.toHaveBeenCalled();
        expect(mockStorage.size).toBe(0);
    });

    it('does not queue or send without the account-scoped stored pairing', async () => {
        const native = transport();
        await expect(queueWearSyncInvalidation({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: async () => null,
            nowEpochMs: NOW
        })).resolves.toEqual({ status: 'unpaired', invalidationId: null });
        expect(native.sendMessage).not.toHaveBeenCalled();
    });
});
