/** @file Regression coverage for handoff: Wear continue-on-phone handoff. */

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); })
    }
}));
jest.mock('@calibrate/wear-pairing', () => ({ __esModule: true, default: null }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-request') }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    getPendingWearHandoffs,
    getWearHandoffHref,
    getWearHandoffPublicUrl,
    markWearHandoffsHandled,
    parseWearHandoffPayload,
    processWearHandoffInbox,
    selectNextWearHandoffBatch,
    type WearHandoff
} from './handoff';
import { WEAR_PAIRING_PATHS } from './pairing';

const ORIGIN = 'https://health.example';
const USER_ID = 7;
const RECEIVED_AT = Date.parse('2026-07-12T18:00:00.000Z');

function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        protocol_version: 1,
        server_origin: ORIGIN,
        user_id: USER_ID,
        destination: 'food_log',
        local_date: '2026-07-12',
        ...overrides
    });
}

function transport(messageOverrides: Record<string, unknown> = {}) {
    return {
        listMessages: jest.fn(() => [{
            id: 'handoff-1',
            nodeId: 'node-1',
            path: WEAR_PAIRING_PATHS.CONTINUE_ON_PHONE,
            payload: payload(),
            receivedAt: RECEIVED_AT,
            ...messageOverrides
        }]),
        acknowledgeMessages: jest.fn()
    };
}

const storedPairing = {
    nodeId: 'node-1',
    watchDeviceId: 'watch-1',
    watchDeviceName: 'Galaxy Watch Ultra',
    serverOrigin: ORIGIN,
    pairedAt: '2026-07-11T18:00:00.000Z'
};

describe('Wear continue-on-phone handoff', () => {
    beforeEach(() => {
        mockStorage.clear();
        jest.clearAllMocks();
    });

    it('strictly parses an account and server-bound food log destination', () => {
        expect(parseWearHandoffPayload(payload())).toEqual({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            destination: 'food_log',
            localDate: '2026-07-12'
        });
        expect(parseWearHandoffPayload(payload({ local_date: '2026-02-30' }))).toBeNull();
        expect(parseWearHandoffPayload(payload({ server_origin: `${ORIGIN}/path` }))).toBeNull();
        expect(parseWearHandoffPayload(payload({ user_id: USER_ID, extra: true }))).toBeNull();
        expect(parseWearHandoffPayload(payload({ destination: 'barcode' }))).toBeNull();
    });

    it.each([
        ['privacy', '/privacy'],
        ['account_deletion', '/account-deletion']
    ])('accepts only the exact %s public destination and maps it to a fixed server path', (destination, path) => {
        const legalPayload = payload({ destination });
        const withoutFoodDate = JSON.stringify(
            Object.fromEntries(Object.entries(JSON.parse(legalPayload)).filter(([key]) => key !== 'local_date'))
        );
        const parsed = parseWearHandoffPayload(withoutFoodDate);

        expect(parsed).toEqual({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            destination,
            localDate: null
        });
        expect(getWearHandoffPublicUrl({
            messageId: 'legal-1',
            nodeId: 'node-1',
            receivedAt: RECEIVED_AT,
            ...parsed!
        })).toBe(`${ORIGIN}${path}`);
        expect(parseWearHandoffPayload(legalPayload)).toBeNull();
    });

    it('acknowledges only after persisting a handoff from the paired node', async () => {
        const native = transport();
        const result = await processWearHandoffInbox({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: jest.fn().mockResolvedValue(storedPairing)
        });

        expect(result).toEqual({ persisted: 1, errors: [] });
        expect(await getPendingWearHandoffs(ORIGIN, USER_ID)).toEqual([
            expect.objectContaining({ messageId: 'handoff-1', nodeId: 'node-1', localDate: '2026-07-12' })
        ]);
        expect(native.acknowledgeMessages).toHaveBeenCalledWith(['handoff-1']);
        expect(jest.mocked(AsyncStorage.setItem).mock.invocationCallOrder[0]).toBeLessThan(
            native.acknowledgeMessages.mock.invocationCallOrder[0]
        );
    });

    it('does not acknowledge a valid handoff for another signed-in account', async () => {
        const native = transport({ payload: payload({ user_id: USER_ID + 1 }) });
        await processWearHandoffInbox({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: jest.fn().mockResolvedValue(storedPairing)
        });

        expect(native.acknowledgeMessages).toHaveBeenCalledWith([]);
        expect(await getPendingWearHandoffs(ORIGIN, USER_ID)).toEqual([]);
    });

    it('handles and acknowledges a node mismatch without routing it', async () => {
        const native = transport({ nodeId: 'node-2' });
        const result = await processWearHandoffInbox({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: jest.fn().mockResolvedValue(storedPairing)
        });

        expect(result.errors).toEqual(['A phone handoff came from a watch that is not paired to this account.']);
        expect(native.acknowledgeMessages).toHaveBeenCalledWith(['handoff-1']);
        expect(await getPendingWearHandoffs(ORIGIN, USER_ID)).toEqual([]);
    });

    it('leaves the native message unacknowledged if durable storage fails', async () => {
        const native = transport();
        const failingStorage = {
            getItem: jest.fn().mockResolvedValue(null),
            setItem: jest.fn().mockRejectedValue(new Error('disk full')),
            removeItem: jest.fn().mockResolvedValue(undefined)
        };

        await expect(processWearHandoffInbox({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            storage: failingStorage,
            readPairing: jest.fn().mockResolvedValue(storedPairing)
        })).rejects.toThrow('disk full');
        expect(native.acknowledgeMessages).not.toHaveBeenCalled();
    });

    it('routes to the dated food logger and removes handled durable requests', async () => {
        const native = transport();
        await processWearHandoffInbox({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: jest.fn().mockResolvedValue(storedPairing)
        });
        const [handoff] = await getPendingWearHandoffs(ORIGIN, USER_ID);
        expect(getWearHandoffHref(handoff as WearHandoff)).toEqual({
            pathname: '/log',
            params: { date: '2026-07-12' }
        });
        await markWearHandoffsHandled(ORIGIN, USER_ID, ['handoff-1']);
        expect(await getPendingWearHandoffs(ORIGIN, USER_ID)).toEqual([]);
    });

    it('persists a legal handoff only from the paired node and never derives a free-form URL', async () => {
        const native = transport({
            payload: JSON.stringify({
                protocol_version: 1,
                server_origin: ORIGIN,
                user_id: USER_ID,
                destination: 'account_deletion'
            })
        });
        await processWearHandoffInbox({
            serverOrigin: ORIGIN,
            userId: USER_ID,
            transport: native,
            readPairing: jest.fn().mockResolvedValue(storedPairing)
        });

        const [handoff] = await getPendingWearHandoffs(ORIGIN, USER_ID);
        expect(getWearHandoffPublicUrl(handoff)).toBe(`${ORIGIN}/account-deletion`);
        expect(getWearHandoffHref(handoff)).toBeNull();
    });

    it('routes distinct intents in arrival order and coalesces only repeated equivalent taps', () => {
        const pending: WearHandoff[] = [
            {
                messageId: 'food-1', nodeId: 'node-1', serverOrigin: ORIGIN, userId: USER_ID,
                destination: 'food_log', localDate: '2026-07-12', receivedAt: RECEIVED_AT
            },
            {
                messageId: 'privacy-1', nodeId: 'node-1', serverOrigin: ORIGIN, userId: USER_ID,
                destination: 'privacy', localDate: null, receivedAt: RECEIVED_AT + 1
            },
            {
                messageId: 'food-2', nodeId: 'node-1', serverOrigin: ORIGIN, userId: USER_ID,
                destination: 'food_log', localDate: '2026-07-12', receivedAt: RECEIVED_AT + 2
            }
        ];

        expect(selectNextWearHandoffBatch(pending)).toEqual({
            handoff: pending[0],
            messageIds: ['food-1', 'food-2']
        });
        expect(selectNextWearHandoffBatch(pending.slice(1))).toEqual({
            handoff: pending[1],
            messageIds: ['privacy-1']
        });
    });
});
