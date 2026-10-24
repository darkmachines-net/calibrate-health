/** @file Regression coverage for sync: foreground Health Connect sync. */

jest.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: async (_algorithm: string, value: string) =>
        Array.from(value).reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 7)
            .toString(16)
            .padStart(64, '0')
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(),
        setItem: jest.fn(),
        removeItem: jest.fn()
    }
}));

import { DEFAULT_HEALTH_CONNECT_SELECTION } from './types';
import { ACTIVITY_RECORD_TYPES, type ActivityRecordType } from '@calibrate/shared';
import {
    clearHealthConnectSyncStorage,
    HEALTH_CONNECT_SYNC_STORAGE_KEYS,
    HealthConnectSyncCancelledError,
    synchronizeHealthConnect
} from './sync';

const SERVER_URL = 'https://health.example.com';

function tokenReceipt(token: string, timeZone: string): string {
    return JSON.stringify({ token, timeZone });
}

function storedToken(values: Map<string, string>, key: string): string | undefined {
    const value = values.get(key);
    return value ? (JSON.parse(value) as { token: string }).token : undefined;
}

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: jest.fn(async (key: string) => values.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { values.delete(key); }),
        values
    };
}

function stepsRecord(id: string, count: number) {
    return {
        metadata: {
            id,
            dataOrigin: 'com.sec.android.app.shealth',
            lastModifiedTime: '2026-07-11T18:00:00.000Z'
        },
        startTime: '2026-07-11T17:00:00.000Z',
        endTime: '2026-07-11T18:00:00.000Z',
        count
    };
}

const acknowledged = (recordType: ActivityRecordType = ACTIVITY_RECORD_TYPES.STEPS) => ({
    record_type: recordType,
    upserted: 0,
    deleted: 0,
    stale_ignored: 0,
    tombstoned_ignored: 0,
    day_summaries_upserted: 0,
    day_summaries_stale_ignored: 0,
    reset_deleted: 0,
    checkpoint_advanced: true as const
});

describe('foreground Health Connect sync', () => {
    it('clears checkpoints only for the selected server account', async () => {
        const firstToken = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const firstPending = HEALTH_CONNECT_SYNC_STORAGE_KEYS.pending(SERVER_URL, 7, 'STEPS');
        const secondToken = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token('https://other.example.com', 7, 'STEPS');
        const storage = memoryStorage({
            [firstToken]: tokenReceipt('first-token', 'UTC'),
            [firstPending]: '{}',
            [secondToken]: tokenReceipt('second-token', 'UTC')
        });

        await clearHealthConnectSyncStorage(SERVER_URL, 7, storage);

        expect(storage.values.has(firstToken)).toBe(false);
        expect(storage.values.has(firstPending)).toBe(false);
        expect(storedToken(storage.values, secondToken)).toBe('second-token');
    });

    it('uploads an initial reset and advances the local token only after acknowledgement', async () => {
        const storage = memoryStorage();
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const api = {
            syncHealthConnect: jest.fn(async () => {
                expect(storage.values.has(tokenKey)).toBe(false);
                return acknowledged();
            })
        };
        const native = {
            getChanges: jest.fn(async () => ({
                upsertionChanges: [], deletionChanges: [], nextChangesToken: 'steps-token-1',
                changesTokenExpired: false, hasMore: false
            })),
            readRecords: jest.fn(async () => ({ records: [stepsRecord('steps-1', 900)] })),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 900 }))
        };

        const result = await synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'America/Los_Angeles',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            now: new Date('2026-07-11T20:00:00.000Z')
        });

        expect(api.syncHealthConnect).toHaveBeenCalledWith(
            expect.objectContaining({
                sync_mode: 'reset',
                record_type: 'STEPS',
                previous_changes_token: null,
                next_changes_token: 'steps-token-1',
                replace_window: {
                    start_date: '2026-06-12',
                    end_date: '2026-07-11'
                },
                upserts: [expect.objectContaining({ record_id: 'steps-1', count: 900 })]
            }),
            expect.stringMatching(/^health-connect:steps:/)
        );
        expect(storedToken(storage.values, tokenKey)).toBe('steps-token-1');
        expect(result.lastSuccessfulSyncAt).toBe('2026-07-11T20:00:00.000Z');
    });

    it('pages incremental changes and persists every acknowledged checkpoint in order', async () => {
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const storage = memoryStorage({
            [tokenKey]: tokenReceipt('steps-token-1', 'America/Los_Angeles')
        });
        const seenTokens: Array<string | undefined> = [];
        const api = {
            syncHealthConnect: jest.fn(async (payload: any) => {
                seenTokens.push(storedToken(storage.values, tokenKey));
                return acknowledged(payload.record_type);
            })
        };
        const native = {
            getChanges: jest.fn()
                .mockResolvedValueOnce({
                    upsertionChanges: [{ record: stepsRecord('steps-2', 100) }],
                    deletionChanges: [], nextChangesToken: 'steps-token-2', changesTokenExpired: false, hasMore: true
                })
                .mockResolvedValueOnce({
                    upsertionChanges: [], deletionChanges: [{ recordId: 'steps-old' }],
                    nextChangesToken: 'steps-token-3', changesTokenExpired: false, hasMore: false
                }),
            readRecords: jest.fn(),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 1_000 }))
        };

        await synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'America/Los_Angeles',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            now: new Date('2026-07-11T20:00:00.000Z')
        });

        expect(seenTokens).toEqual(['steps-token-1', 'steps-token-2']);
        expect(storedToken(storage.values, tokenKey)).toBe('steps-token-3');
        expect(api.syncHealthConnect).toHaveBeenCalledTimes(2);
        for (const [payload] of api.syncHealthConnect.mock.calls) {
            expect(payload).not.toHaveProperty('replace_window');
        }
    });

    it('resets transparently when Health Connect expires a changes token', async () => {
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const storage = memoryStorage({ [tokenKey]: tokenReceipt('expired-token', 'UTC') });
        const native = {
            getChanges: jest.fn()
                .mockResolvedValueOnce({
                    upsertionChanges: [], deletionChanges: [], nextChangesToken: 'ignored',
                    changesTokenExpired: true, hasMore: false
                })
                .mockResolvedValueOnce({
                    upsertionChanges: [], deletionChanges: [], nextChangesToken: 'replacement-token',
                    changesTokenExpired: false, hasMore: false
                }),
            readRecords: jest.fn(async () => ({ records: [] })),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 0 }))
        };
        const api = { syncHealthConnect: jest.fn(async (_payload: any, _operationId: string) => acknowledged()) };

        await synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'UTC',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            now: new Date('2026-07-11T20:00:00.000Z')
        });

        expect(api.syncHealthConnect).toHaveBeenCalledWith(
            expect.objectContaining({ sync_mode: 'reset', previous_changes_token: null }),
            expect.any(String)
        );
        expect(storedToken(storage.values, tokenKey)).toBe('replacement-token');
    });

    it('discards a pending upload containing the native negative client-version sentinel', async () => {
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const pendingKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.pending(SERVER_URL, 7, 'STEPS');
        const storage = memoryStorage({
            [tokenKey]: tokenReceipt('steps-token-1', 'UTC'),
            [pendingKey]: JSON.stringify({
                nextToken: 'bad-token',
                timeZone: 'UTC',
                nextPageIndex: 0,
                pages: [{
                    operationId: 'stale-operation',
                    payload: {
                        sync_mode: 'incremental',
                        record_type: 'STEPS',
                        previous_changes_token: 'steps-token-1',
                        next_changes_token: 'bad-token',
                        upserts: [{
                            ...stepsRecord('steps-bad', 100),
                            record_id: 'steps-bad',
                            data_origin: 'com.sec.android.app.shealth',
                            source_updated_at: '2026-07-11T18:00:00.000Z',
                            start_time: '2026-07-11T17:00:00.000Z',
                            end_time: '2026-07-11T18:00:00.000Z',
                            client_record_version: '-1'
                        }],
                        deleted_record_ids: [],
                        day_summaries: []
                    }
                }]
            })
        });
        const native = {
            getChanges: jest.fn(async () => ({
                upsertionChanges: [], deletionChanges: [], nextChangesToken: 'steps-token-2',
                changesTokenExpired: false, hasMore: false
            })),
            readRecords: jest.fn(),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 1_000 }))
        };
        const api = { syncHealthConnect: jest.fn(async () => acknowledged()) };

        await synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'UTC',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            now: new Date('2026-07-11T20:00:00.000Z')
        });

        expect(api.syncHealthConnect).not.toHaveBeenCalledWith(
            expect.anything(),
            'stale-operation'
        );
        expect(storage.values.has(pendingKey)).toBe(false);
        expect(storedToken(storage.values, tokenKey)).toBe('steps-token-2');
    });

    it('chunks combined incremental changes and advances the checkpoint only on the final chunk', async () => {
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const storage = memoryStorage({ [tokenKey]: tokenReceipt('steps-token-1', 'UTC') });
        const api = { syncHealthConnect: jest.fn(async (_payload: any, _operationId: string) => acknowledged()) };
        const native = {
            getChanges: jest.fn(async () => ({
                upsertionChanges: Array.from({ length: 499 }, (_, index) => ({
                    record: stepsRecord(`steps-${index}`, index + 1)
                })),
                deletionChanges: [{ recordId: 'deleted-1' }, { recordId: 'deleted-2' }],
                nextChangesToken: 'steps-token-2',
                changesTokenExpired: false,
                hasMore: false
            })),
            readRecords: jest.fn(),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 1_000 }))
        };

        await synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'UTC',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            now: new Date('2026-07-11T20:00:00.000Z')
        });

        const firstPayload = api.syncHealthConnect.mock.calls[0][0];
        const finalPayload = api.syncHealthConnect.mock.calls[1][0];
        expect(firstPayload.upserts.length + firstPayload.deleted_record_ids.length).toBe(500);
        expect(firstPayload.next_changes_token).toBe('steps-token-1');
        expect(finalPayload.upserts.length + finalPayload.deleted_record_ids.length).toBe(1);
        expect(finalPayload.previous_changes_token).toBe('steps-token-1');
        expect(finalPayload.next_changes_token).toBe('steps-token-2');
    });

    it('invalidates a checkpoint when the user timezone changes', async () => {
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const storage = memoryStorage({
            [tokenKey]: tokenReceipt('steps-token-1', 'America/Los_Angeles')
        });
        const native = {
            getChanges: jest.fn(async (_recordType: string, token?: string) => {
                expect(token).toBeUndefined();
                return {
                    upsertionChanges: [], deletionChanges: [], nextChangesToken: 'utc-token-1',
                    changesTokenExpired: false, hasMore: false
                };
            }),
            readRecords: jest.fn(async () => ({ records: [] })),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 0 }))
        };
        const api = { syncHealthConnect: jest.fn(async () => acknowledged()) };

        await synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'UTC',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            now: new Date('2026-07-11T20:00:00.000Z')
        });

        expect(api.syncHealthConnect).toHaveBeenCalledWith(
            expect.objectContaining({ sync_mode: 'reset', replace_window: expect.any(Object) }),
            expect.any(String)
        );
        expect(storage.values.get(tokenKey)).toBe(tokenReceipt('utc-token-1', 'UTC'));
    });

    it('stops after an account generation changes without advancing the local checkpoint', async () => {
        const tokenKey = HEALTH_CONNECT_SYNC_STORAGE_KEYS.token(SERVER_URL, 7, 'STEPS');
        const storage = memoryStorage({ [tokenKey]: tokenReceipt('steps-token-1', 'UTC') });
        let canContinue = true;
        const api = {
            syncHealthConnect: jest.fn(async () => {
                canContinue = false;
                return acknowledged();
            })
        };
        const native = {
            getChanges: jest.fn(async () => ({
                upsertionChanges: Array.from({ length: 501 }, (_, index) => ({
                    record: stepsRecord(`steps-${index}`, index + 1)
                })),
                deletionChanges: [], nextChangesToken: 'steps-token-2',
                changesTokenExpired: false, hasMore: false
            })),
            readRecords: jest.fn(),
            aggregateRecords: jest.fn(async () => ({ COUNT_TOTAL: 1_000 }))
        };

        await expect(synchronizeHealthConnect({
            serverUrl: SERVER_URL,
            userId: 7,
            timeZone: 'UTC',
            selection: { ...DEFAULT_HEALTH_CONNECT_SELECTION, active_calories: false, total_calories: false, exercise: false },
            grantedFeatures: ['steps'],
            api,
            storage,
            native: native as any,
            shouldContinue: () => canContinue,
            now: new Date('2026-07-11T20:00:00.000Z')
        })).rejects.toBeInstanceOf(HealthConnectSyncCancelledError);

        expect(api.syncHealthConnect).toHaveBeenCalledTimes(1);
        expect(storedToken(storage.values, tokenKey)).toBe('steps-token-1');
    });
});
