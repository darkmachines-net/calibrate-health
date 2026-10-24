/** @file Regression coverage for pairing: Wear phone pairing coordinator. */

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); })
    }
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-request') }));
jest.mock('@calibrate/wear-pairing', () => ({ __esModule: true, default: null }));

import {
    getWearPairingErrorMessage,
    parseWearAccountDisconnectAck,
    parsePairingHello,
    processWearPairingInbox,
    readStoredWearPairing,
    sendWearAccountDisconnect,
    startWearPairing,
    WEAR_PAIRING_PATHS
} from './pairing';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ORIGIN = 'https://health.example';
const USER_ID = 7;
const NOW = new Date('2026-07-11T20:00:00.000Z');
const EXPIRES_AT = '2026-07-11T20:05:00.000Z';
const storedPairing = {
    nodeId: 'node-1',
    watchDeviceId: 'watch-1',
    watchDeviceName: 'Galaxy Watch Ultra',
    serverOrigin: ORIGIN,
    pairedAt: NOW.toISOString()
};

function makeTransport(messages: Array<{
    id: string;
    nodeId: string;
    path: string;
    payload: string;
    receivedAt: number;
}> = []) {
    return {
        getPairingNodes: jest.fn(),
        sendMessage: jest.fn().mockResolvedValue(1),
        acknowledgeMessages: jest.fn(),
        listMessages: jest.fn(() => messages),
        prepareNetworkRelay: jest.fn(),
        commitNetworkRelay: jest.fn(),
        restoreNetworkRelay: jest.fn(),
        clearPendingNetworkRelay: jest.fn(),
        clearNetworkRelay: jest.fn()
    };
}

function helloPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        request_id: 'request-1',
        protocol_version: 1,
        server_origin: ORIGIN,
        expires_at: EXPIRES_AT,
        watch_device_id: 'watch-1',
        watch_device_name: 'Galaxy Watch Ultra',
        watch_public_key_spki: 'public-key',
        ...overrides
    });
}

function disconnectAckPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        kind: 'watch_account_disconnected',
        request_id: 'disconnect-request',
        protocol_version: 1,
        server_origin: ORIGIN,
        user_id: USER_ID,
        watch_device_id: 'watch-1',
        ok: true,
        ...overrides
    });
}

async function beginPairing(transport = makeTransport()) {
    await startWearPairing({
        node: { id: 'node-1', displayName: 'Galaxy Watch Ultra', isNearby: true },
        serverOrigin: ORIGIN,
        userId: USER_ID,
        transport,
        now: NOW,
        requestId: 'request-1'
    });
    return transport;
}

describe('Wear phone pairing coordinator', () => {
    beforeEach(() => {
        mockStorage.clear();
        jest.clearAllMocks();
    });

    it('maps unavailable Play Services and raw native failures to actionable pairing guidance', () => {
        expect(getWearPairingErrorMessage(new Error(
            "Call to function 'CalibrateWearPairing.getPairingNodes' has been rejected. " +
            'Caused by: com.google.android.gms.common.api.ApiException: 17: API: Wearable.API is not available ' +
            'on this device. Connection failed with statusCode=API_UNAVAILABLE'
        ))).toBe(
            'Wear OS pairing is unavailable on this phone. Pair a Wear OS watch in Android and update Google Play services, then try again.'
        );
        expect(getWearPairingErrorMessage(new Error(
            'Call to function failed. Caused by: java.lang.IllegalStateException'
        ))).toBe(
            'Unable to check for a Wear OS watch. Confirm Bluetooth and Google Play services are available, then try again.'
        );
        expect(getWearPairingErrorMessage(new Error('Watch unavailable'))).toBe(
            'Unable to check for a Wear OS watch. Confirm Bluetooth and Google Play services are available, then try again.'
        );
    });

    it('validates the server-bound, expiring watch hello contract', () => {
        expect(parsePairingHello(helloPayload())).toEqual({
            requestId: 'request-1',
            serverOrigin: ORIGIN,
            expiresAt: EXPIRES_AT,
            watchDeviceId: 'watch-1',
            watchDeviceName: 'Galaxy Watch Ultra',
            watchPublicKeySpki: 'public-key'
        });
        expect(parsePairingHello(helloPayload({ protocol_version: 2 }))).toBeNull();
        expect(parsePairingHello(helloPayload({ server_origin: `${ORIGIN}/path` }))).toBeNull();
        expect(parsePairingHello(helloPayload({ watch_device_name: '' }))).toBeNull();
    });

    it('requires a positive correlated cleanup ACK from the exact stored node', async () => {
        const transport = makeTransport([{
            id: 'disconnect-result',
            nodeId: 'node-1',
            path: WEAR_PAIRING_PATHS.ACCOUNT_DISCONNECT_RESULT,
            payload: disconnectAckPayload(),
            receivedAt: NOW.getTime()
        }]);
        await sendWearAccountDisconnect({
            pairing: storedPairing,
            userId: USER_ID,
            transport,
            nowEpochMs: NOW.getTime(),
            requestId: 'disconnect-request'
        });

        expect(transport.sendMessage).toHaveBeenCalledWith(
            'node-1',
            WEAR_PAIRING_PATHS.ACCOUNT_DISCONNECT,
            JSON.stringify({
                kind: 'phone_account_deleted',
                request_id: 'disconnect-request',
                protocol_version: 1,
                server_origin: ORIGIN,
                user_id: USER_ID,
                watch_device_id: 'watch-1',
                issued_at_epoch_ms: NOW.getTime()
            })
        );
        expect(transport.acknowledgeMessages).toHaveBeenCalledWith(['disconnect-result']);
    });

    it('rejects negative malformed and extra-field cleanup acknowledgements', () => {
        expect(parseWearAccountDisconnectAck(disconnectAckPayload())).toEqual({
            requestId: 'disconnect-request',
            serverOrigin: ORIGIN,
            userId: USER_ID,
            watchDeviceId: 'watch-1'
        });
        expect(parseWearAccountDisconnectAck(disconnectAckPayload({ ok: false }))).toBeNull();
        expect(parseWearAccountDisconnectAck(disconnectAckPayload({ extra: true }))).toBeNull();
        expect(parseWearAccountDisconnectAck(disconnectAckPayload({ server_origin: `${ORIGIN}/path` }))).toBeNull();
    });

    it('times out with a manual-watch fallback when the ACK is from another node', async () => {
        const transport = makeTransport([{
            id: 'foreign-result',
            nodeId: 'other-node',
            path: WEAR_PAIRING_PATHS.ACCOUNT_DISCONNECT_RESULT,
            payload: disconnectAckPayload(),
            receivedAt: NOW.getTime()
        }]);

        await expect(sendWearAccountDisconnect({
            pairing: storedPairing,
            userId: USER_ID,
            transport,
            nowEpochMs: NOW.getTime(),
            requestId: 'disconnect-request',
            timeoutMs: 3,
            pollIntervalMs: 1
        })).rejects.toThrow('Disconnect Calibrate on the watch');
        expect(transport.acknowledgeMessages).not.toHaveBeenCalled();
    });

    it('persists a phone-owned invite before contacting the selected node', async () => {
        const transport = await beginPairing();

        expect(transport.sendMessage).toHaveBeenCalledWith(
            'node-1',
            WEAR_PAIRING_PATHS.HELLO,
            expect.stringContaining('"request_id":"request-1"')
        );
        expect(transport.prepareNetworkRelay).toHaveBeenCalledWith(
            'node-1',
            ORIGIN,
            'request-1',
            new Date(EXPIRES_AT).getTime()
        );
        expect([...mockStorage.values()].some((value) => value.includes('"userId":7'))).toBe(true);
        expect([...mockStorage.values()].some((value) => value.includes('"issuedAt":"2026-07-11T20:00:00.000Z"'))).toBe(true);
    });

    it('re-sends the same unexpired invite so a queued watch result can be correlated', async () => {
        const transport = await beginPairing();
        transport.sendMessage.mockClear();

        const pending = await startWearPairing({
            node: { id: 'node-1', displayName: 'Galaxy Watch Ultra', isNearby: true },
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport,
            now: new Date('2026-07-11T20:01:00.000Z')
        });

        expect(pending.requestId).toBe('request-1');
        expect(pending.expiresAt).toBe(EXPIRES_AT);
        expect(transport.sendMessage).toHaveBeenCalledWith(
            'node-1',
            WEAR_PAIRING_PATHS.HELLO,
            expect.stringContaining('"request_id":"request-1"')
        );
    });

    it('removes the pending invite when sending it fails', async () => {
        const transport = makeTransport();
        transport.sendMessage.mockRejectedValueOnce(new Error('Watch unavailable'));

        await expect(beginPairing(transport)).rejects.toThrow('Watch unavailable');
        expect(mockStorage.size).toBe(0);
        expect(transport.clearPendingNetworkRelay).toHaveBeenCalledWith('node-1', ORIGIN, 'request-1');
    });

    it('removes the pending invite when native relay preparation fails', async () => {
        const transport = makeTransport();
        transport.prepareNetworkRelay.mockImplementationOnce(() => {
            throw new Error('Relay storage unavailable');
        });

        await expect(beginPairing(transport)).rejects.toThrow('Relay storage unavailable');
        expect(mockStorage.size).toBe(0);
        expect(transport.sendMessage).not.toHaveBeenCalled();
        expect(transport.clearPendingNetworkRelay).toHaveBeenCalledWith('node-1', ORIGIN, 'request-1');
    });

    it('exchanges only a one-time server credential with the correlated node', async () => {
        const transport = await beginPairing();
        transport.listMessages.mockReturnValue([{
            id: 'message-1',
            nodeId: 'node-1',
            path: WEAR_PAIRING_PATHS.HELLO,
            payload: helloPayload(),
            receivedAt: NOW.getTime()
        }]);
        const issueWearPairingCredential = jest.fn().mockResolvedValue({
            pairing_token: 'one-time-token',
            server_origin: ORIGIN,
            watch_device_id: 'watch-1',
            protocol_version: 1,
            challenge: 'challenge',
            expires_at: EXPIRES_AT
        });

        const result = await processWearPairingInbox({
            api: { issueWearPairingCredential },
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport,
            now: NOW
        });

        expect(issueWearPairingCredential).toHaveBeenCalledWith(expect.objectContaining({
            server_origin: ORIGIN,
            watch_device_id: 'watch-1'
        }));
        expect(transport.sendMessage).toHaveBeenLastCalledWith(
            'node-1',
            WEAR_PAIRING_PATHS.CREDENTIAL,
            expect.not.stringContaining('refresh_token')
        );
        expect(result).toEqual({ processed: 1, paired: null, errors: [] });
        expect(transport.acknowledgeMessages).toHaveBeenCalledWith(['message-1']);
    });

    it.each([
        ['different node', 'node-2', helloPayload()],
        ['different server', 'node-1', helloPayload({ server_origin: 'https://other.example' })],
        ['different expiry', 'node-1', helloPayload({ expires_at: '2026-07-11T20:04:00.000Z' })]
    ])('rejects a %s hello without issuing a credential', async (_label, nodeId, payload) => {
        const transport = await beginPairing();
        transport.listMessages.mockReturnValue([{
            id: 'mismatch', nodeId, path: WEAR_PAIRING_PATHS.HELLO, payload, receivedAt: NOW.getTime()
        }]);
        const issueWearPairingCredential = jest.fn();

        const result = await processWearPairingInbox({
            api: { issueWearPairingCredential }, serverOrigin: ORIGIN, userId: USER_ID, transport, now: NOW
        });

        expect(issueWearPairingCredential).not.toHaveBeenCalled();
        expect(result.errors).toHaveLength(1);
        expect(transport.acknowledgeMessages).toHaveBeenCalledWith(['mismatch']);
    });

    it('retains a hello when the server credential request fails', async () => {
        const transport = await beginPairing();
        transport.listMessages.mockReturnValue([{
            id: 'message-1', nodeId: 'node-1', path: WEAR_PAIRING_PATHS.HELLO,
            payload: helloPayload(), receivedAt: NOW.getTime()
        }]);
        const result = await processWearPairingInbox({
            api: { issueWearPairingCredential: jest.fn().mockRejectedValue(new Error('Server unavailable')) },
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport,
            now: NOW
        });

        expect(result.errors).toEqual(['Unable to create a watch pairing credential.']);
        expect(transport.acknowledgeMessages).toHaveBeenCalledWith([]);
    });

    it('retains a hello when result correlation cannot be persisted', async () => {
        const transport = await beginPairing();
        transport.listMessages.mockReturnValue([{
            id: 'message-1', nodeId: 'node-1', path: WEAR_PAIRING_PATHS.HELLO,
            payload: helloPayload(), receivedAt: NOW.getTime()
        }]);
        jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Storage unavailable'));

        const result = await processWearPairingInbox({
            api: { issueWearPairingCredential: jest.fn().mockResolvedValue({ pairing_token: 'token' }) },
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport,
            now: NOW
        });

        expect(result.errors).toEqual(['Unable to create a watch pairing credential.']);
        expect(transport.acknowledgeMessages).toHaveBeenCalledWith([]);
    });

    it('correlates a successful result and stores it only for that account', async () => {
        const transport = await beginPairing();
        transport.listMessages.mockReturnValueOnce([{
            id: 'hello', nodeId: 'node-1', path: WEAR_PAIRING_PATHS.HELLO,
            payload: helloPayload(), receivedAt: NOW.getTime()
        }]);
        await processWearPairingInbox({
            api: { issueWearPairingCredential: jest.fn().mockResolvedValue({ pairing_token: 'token' }) },
            serverOrigin: ORIGIN, userId: USER_ID, transport, now: NOW
        });
        transport.listMessages.mockReturnValueOnce([{
            id: 'result', nodeId: 'node-1', path: WEAR_PAIRING_PATHS.RESULT,
            payload: JSON.stringify({
                ok: true,
                request_id: 'request-1',
                protocol_version: 1,
                server_origin: ORIGIN,
                watch_device_id: 'watch-1',
                watch_device_name: 'Galaxy Watch Ultra'
            }),
            receivedAt: NOW.getTime()
        }]);

        const result = await processWearPairingInbox({
            api: { issueWearPairingCredential: jest.fn() },
            serverOrigin: ORIGIN, userId: USER_ID, transport, now: NOW
        });

        expect(result.paired?.watchDeviceId).toBe('watch-1');
        expect(transport.commitNetworkRelay).toHaveBeenCalledWith('node-1', ORIGIN, 'request-1');
        expect(await readStoredWearPairing(ORIGIN, USER_ID)).toEqual(result.paired);
        expect(await readStoredWearPairing(ORIGIN, USER_ID + 1)).toBeNull();
        expect(transport.acknowledgeMessages).toHaveBeenLastCalledWith(['result']);
    });

    it('retires a consumed request when the watch reports an exchange failure', async () => {
        const transport = await beginPairing();
        transport.listMessages.mockReturnValueOnce([{
            id: 'hello', nodeId: 'node-1', path: WEAR_PAIRING_PATHS.HELLO,
            payload: helloPayload(), receivedAt: NOW.getTime()
        }]);
        await processWearPairingInbox({
            api: { issueWearPairingCredential: jest.fn().mockResolvedValue({ pairing_token: 'token' }) },
            serverOrigin: ORIGIN, userId: USER_ID, transport, now: NOW
        });
        transport.listMessages.mockReturnValueOnce([{
            id: 'failed-result',
            nodeId: 'node-1',
            path: WEAR_PAIRING_PATHS.RESULT,
            payload: JSON.stringify({
                ok: false,
                request_id: 'request-1',
                protocol_version: 1,
                server_origin: ORIGIN,
                watch_device_id: 'watch-1',
                message: 'Pairing response was unavailable. Start pairing again.'
            }),
            receivedAt: NOW.getTime()
        }]);

        const result = await processWearPairingInbox({
            api: { issueWearPairingCredential: jest.fn() },
            serverOrigin: ORIGIN, userId: USER_ID, transport, now: NOW
        });

        expect(result).toEqual({
            processed: 1,
            paired: null,
            errors: ['Pairing response was unavailable. Start pairing again.']
        });
        expect(transport.clearPendingNetworkRelay).toHaveBeenCalledWith('node-1', ORIGIN, 'request-1');
        expect([...mockStorage.values()].some((value) => value.includes('"requestId":"request-1"'))).toBe(false);
        expect(transport.acknowledgeMessages).toHaveBeenLastCalledWith(['failed-result']);
    });
});
