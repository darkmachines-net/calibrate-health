/** @file Regression coverage for food Day Receipts: serializes a slow authoritative read before a newer direct completion receipt. */

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'request' }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { IDBFactory } from 'fake-indexeddb';
import type { FoodLogDay } from '@calibrate/api-client';
import { IndexedDbOutbox, openIndexedDbOutboxDatabase } from './indexedDbOutbox.web';
import { createOutboxDispatch } from './mutationDispatch';
import { executeOrQueueMutation, createQueuedMutationExecutor } from './operations';
import { OutboxReconciler } from './reconciler';
import { readAndRecordFoodDay, readAndRecordFoodDays, readAndRecordFoodPause, readFoodDayReceipts, recordFoodDayReceipt } from './foodDayReceipts';
import { queuedFoodDayStatus } from './foodDayIntent';

beforeEach(async () => { await AsyncStorage.clear(); });
const date = '2026-08-08';

it.each(['food-day.set-status', 'food-tracking-pause.start'])('retains applied %s after queue deletion and persisted reopen, without crossing accounts', async operation => {
    const factory = new IDBFactory();
    let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'receipts' });
    let store = new IndexedDbOutbox(database, 'account');
    try {
        await store.enqueue({ id: 'control', operation, payload: operation === 'food-day.set-status' ? { date, status: 'COMPLETE' } : { starts_on: date } });
        await new OutboxReconciler(store, async () => ({ currentControl: { day: { date, status: operation === 'food-day.set-status' ? 'COMPLETE' : 'PAUSED' } } }), 'account').reconcile();
        expect(await store.list()).toEqual([]);
        database.close(); database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'receipts' });
        store = new IndexedDbOutbox(database, 'account');
        const dispatch = createOutboxDispatch('account', () => store.list(), (kind, payload, id) => store.enqueue({ operation: kind, payload, id }), () => true, true);
        const execute = jest.fn(async () => undefined);
        for (const kind of ['food.create', 'food.update', 'food.delete'] as const) {
            await expect(executeOrQueueMutation({ withOutbox: dispatch, forceQueue: true, operation: kind, payload: { date }, execute, enqueue: async () => undefined })).rejects.toThrow(/Reopen or resume/);
        }
        expect(execute).not.toHaveBeenCalled(); expect(await store.list()).toEqual([]);
        expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date, 'OPEN')).toBe(operation === 'food-day.set-status' ? 'COMPLETE' : 'PAUSED');
        expect(await readFoodDayReceipts('other-account')).toEqual([]);
        // A verified newer server read reconciles acknowledged state; an old cached OPEN value did not.
        await readAndRecordFoodDay('account', date, async () => ({ date, status: 'OPEN' } as FoodLogDay));
        await expect(executeOrQueueMutation({ withOutbox: dispatch, forceQueue: true, operation: 'food.create', payload: { date }, execute, enqueue: async () => undefined })).resolves.toMatchObject({ disposition: 'queued' });
        expect(await store.list()).toHaveLength(1);
    } finally { database.close(); }
});

it('serializes a slow authoritative read before a newer direct completion receipt', async () => {
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const read = readAndRecordFoodDay('account', date, async () => { started(); await gate; return { date, status: 'OPEN' } as FoodLogDay; });
    await entered;
    const dispatch = createOutboxDispatch('account', async () => [], async () => undefined, () => true, true);
    const complete = executeOrQueueMutation({ withOutbox: dispatch, operation: 'food-day.set-status', payload: { date, status: 'COMPLETE' }, execute: async () => undefined, enqueue: async () => undefined });
    release(); await Promise.all([read, complete]);
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date, 'OPEN')).toBe('COMPLETE');
});

it('retains an acknowledged control under its original request ID if receipt persistence fails', async () => {
    const enqueue = jest.fn(async () => undefined);
    const dispatch = createOutboxDispatch('account', async () => [], enqueue, () => true, true);
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Quota exceeded'));
    await expect(executeOrQueueMutation({ withOutbox: dispatch, operation: 'food-day.set-status', payload: { date, status: 'COMPLETE' }, execute: async () => undefined, enqueue, createOperationId: () => 'original-control' })).resolves.toMatchObject({ disposition: 'queued', operationId: 'original-control' });
    expect(enqueue).toHaveBeenCalledWith('food-day.set-status', { date, status: 'COMPLETE' }, 'original-control');
});

it.each(['food-day.set-status', 'food-tracking-pause.start'])('does not resurrect stale %s state after lost-response replay and a second-client reopen', async operation => {
    const factory = new IDBFactory();
    const database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'lost-response' });
    const store = new IndexedDbOutbox(database, 'account');
    const oldStatus = operation === 'food-day.set-status' ? 'COMPLETE' : 'PAUSED';
    let serverStatus = 'OPEN'; let calls = 0; let writes = 0;
    const ids: string[] = [];
    const apply = async (_payload: unknown, id?: string) => {
        ids.push(id!); calls++;
        if (calls === 1) { writes++; serverStatus = oldStatus; throw new TypeError('Lost response after server commit'); }
        return { date, status: oldStatus, pause: { active: true, starts_on: date } }; // Cached receipt, no second write.
    };
    const api = {
        setFoodDayStatus: apply, startFoodTrackingPause: apply,
        getFoodDay: async () => ({ date, status: serverStatus }),
        getFoodTrackingPause: async () => ({ pause: { active: false, starts_on: null } })
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        await store.enqueue({ id: 'same-original-id', operation, payload: operation === 'food-day.set-status' ? { date, status: 'COMPLETE' } : { starts_on: date, expected_resume_on: null } });
        const execute = createQueuedMutationExecutor(api);
        expect((await new OutboxReconciler(store, execute, 'account').reconcile()).deferredMutation?.id).toBe('same-original-id');
        serverStatus = 'OPEN'; // A second client deliberately reopened/resumed after the first request committed.
        await readAndRecordFoodDay('account', date, () => api.getFoodDay(date));
        const result = await new OutboxReconciler(store, execute, 'account').reconcile();
        expect(result.replayed).toBe(1); expect(result.failedMutation).toBeNull();
        expect(writes).toBe(1); expect(ids).toEqual(['same-original-id', 'same-original-id']);
        expect(await store.list()).toEqual([]);
        expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date, 'OPEN')).toBe('OPEN');
        const dispatch = createOutboxDispatch('account', () => store.list(), (kind, payload, id) => store.enqueue({ operation: kind, payload, id }), () => true, true);
        await expect(executeOrQueueMutation({ withOutbox: dispatch, forceQueue: true, operation: 'food.create', payload: { date }, execute: async () => undefined, enqueue: async () => undefined })).resolves.toMatchObject({ disposition: 'queued' });
    } finally { database.close(); }
});

it('keeps the original control pending if its post-replay server read is unavailable', async () => {
    const { ApiError } = require('@calibrate/api-client');
    const factory = new IDBFactory(); const database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'verification-outage' });
    const store = new IndexedDbOutbox(database, 'account'); let unavailable = true;
    const api = {
        setFoodDayStatus: jest.fn(async () => ({ date, status: 'COMPLETE' })),
        getFoodDay: jest.fn(async () => { if (unavailable) throw new ApiError('Unavailable', 503, null); return { date, status: 'OPEN' }; })
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        await store.enqueue({ id: 'original', operation: 'food-day.set-status', payload: { date, status: 'COMPLETE' } });
        const execute = createQueuedMutationExecutor(api);
        const first = await new OutboxReconciler(store, execute, 'account').reconcile();
        expect(first.deferredMutation?.id).toBe('original');
        expect((await store.list())[0]).toMatchObject({ id: 'original', state: 'pending' });
        expect(await readFoodDayReceipts('account')).toEqual([]);
        unavailable = false;
        expect((await new OutboxReconciler(store, execute, 'account').reconcile()).replayed).toBe(1);
        expect(api.setFoodDayStatus).toHaveBeenNthCalledWith(1, { date, status: 'COMPLETE' }, 'original');
        expect(api.setFoodDayStatus).toHaveBeenNthCalledWith(2, { date, status: 'COMPLETE' }, 'original');
        expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date)).toBe('OPEN');
    } finally { database.close(); }
});

it('does not replay an old resume across a newer authoritative paused day', async () => {
    const laterDate = '2026-08-09';
    const factory = new IDBFactory(); const database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'resume-history' });
    const store = new IndexedDbOutbox(database, 'account');
    const api = {
        resumeFoodTracking: jest.fn(async () => ({ day: { date, status: 'OPEN' }, pause: { active: false, resumed_on: date } })),
        getFoodDay: async () => ({ date, status: 'OPEN' }),
        getFoodTrackingPause: async () => ({ pause: { active: false, starts_on: null } })
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        await readAndRecordFoodDay('account', laterDate, async () => ({ date: laterDate, status: 'PAUSED' } as FoodLogDay));
        await store.enqueue({ id: 'old-resume', operation: 'food-tracking-pause.resume', payload: { resumed_on: date } });
        expect((await new OutboxReconciler(store, createQueuedMutationExecutor(api), 'account').reconcile()).replayed).toBe(1);
        const receipts = await readFoodDayReceipts('account');
        expect(queuedFoodDayStatus(receipts, date)).toBe('OPEN');
        expect(queuedFoodDayStatus(receipts, laterDate)).toBe('PAUSED');
    } finally { database.close(); }
});

const controlCases = [
    ['complete', 'food-day.set-status', { date, status: 'COMPLETE' }, 'setFoodDayStatus'],
    ['reopen', 'food-day.set-status', { date, status: 'OPEN' }, 'setFoodDayStatus'],
    ['legacy complete', 'food-day.update', { date, is_complete: true }, 'updateFoodDay'],
    ['legacy reopen', 'food-day.update', { date, is_complete: false }, 'updateFoodDay'],
    ['pause', 'food-tracking-pause.start', { starts_on: date, expected_resume_on: null }, 'startFoodTrackingPause'],
    ['expectation update', 'food-tracking-pause.update', { expected_resume_on: null }, 'updateFoodTrackingPause'],
    ['resume', 'food-tracking-pause.resume', { resumed_on: date }, 'resumeFoodTracking']
] as const;

it.each(controlCases)('verifies %s after a successful void response, retry, intervening change and restart', async (_name, operation, payload, method) => {
    const factory = new IDBFactory(); let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'all-controls' });
    let store = new IndexedDbOutbox(database, 'account');
    let readUnavailable = true;
    const { ApiError } = require('@calibrate/api-client');
    const mutate = jest.fn(async () => undefined); // Executor does not depend on a mutation response body.
    const api = {
        [method]: mutate,
        getFoodDay: async () => { if (readUnavailable) throw new ApiError('Unavailable', 503, null); return { date, status: 'OPEN' }; },
        getFoodTrackingPause: async () => { if (readUnavailable) throw new ApiError('Unavailable', 503, null); return { pause: { active: false, starts_on: null } }; }
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        await recordFoodDayReceipt('account', 'food-tracking-pause.start', { starts_on: date }, 'old-pause');
        await store.enqueue({ id: 'original-control', operation, payload });
        let result = await new OutboxReconciler(store, createQueuedMutationExecutor(api), 'account').reconcile();
        expect(result.deferredMutation?.id).toBe('original-control');
        expect(result.failedMutation).toBeNull();
        database.close(); database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'all-controls' });
        store = new IndexedDbOutbox(database, 'account');
        readUnavailable = false; // Another client has reopened/resumed; cached mutation response is irrelevant.
        result = await new OutboxReconciler(store, createQueuedMutationExecutor(api), 'account').reconcile();
        expect(result.replayed).toBe(1); expect(result.failedMutation).toBeNull(); expect(await store.list()).toEqual([]);
        expect(mutate).toHaveBeenNthCalledWith(1, payload, 'original-control');
        expect(mutate).toHaveBeenNthCalledWith(2, payload, 'original-control');
        if (operation.startsWith('food-tracking-pause.')) {
            expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), '2026-08-10', 'OPEN')).toBe('OPEN');
        }
    } finally { database.close(); }
});

it('replaces persisted pause history on verified resume while preserving newer exact-day authority', async () => {
    const factory = new IDBFactory(); let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'pause-boundary' });
    let store = new IndexedDbOutbox(database, 'account');
    const later = '2026-08-10';
    const api = {
        resumeFoodTracking: async () => undefined,
        getFoodDay: async () => ({ date, status: 'OPEN' }),
        getFoodTrackingPause: async () => ({ pause: { active: false, starts_on: null } })
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        await recordFoodDayReceipt('account', 'food-tracking-pause.start', { starts_on: date }, 'old-pause');
        await readAndRecordFoodDay('account', later, async () => ({ date: later, status: 'COMPLETE' } as FoodLogDay));
        await store.enqueue({ id: 'resume', operation: 'food-tracking-pause.resume', payload: { resumed_on: date } });
        expect((await new OutboxReconciler(store, createQueuedMutationExecutor(api), 'account').reconcile()).replayed).toBe(1);
        database.close(); database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'pause-boundary' });
        store = new IndexedDbOutbox(database, 'account');
        const rows = await readFoodDayReceipts('account');
        expect(await store.list()).toEqual([]);
        expect(queuedFoodDayStatus(rows, '2026-08-09', 'OPEN')).toBe('OPEN');
        expect(queuedFoodDayStatus(rows, later, 'OPEN')).toBe('COMPLETE');
        expect(queuedFoodDayStatus(rows, '2026-08-11', 'OPEN')).toBe('OPEN');
    } finally { database.close(); }
});

it('keeps a second-client active pause after replaying an old resume and later expectation update', async () => {
    const factory = new IDBFactory(); const database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'new-pause' });
    const store = new IndexedDbOutbox(database, 'account');
    const api = {
        resumeFoodTracking: async () => ({ pause: { active: false }, day: { date, status: 'OPEN' } }),
        updateFoodTrackingPause: async () => undefined,
        getFoodDay: async () => ({ date, status: 'OPEN' }),
        getFoodTrackingPause: async () => ({ pause: { active: true, starts_on: '2026-08-09' } })
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        await recordFoodDayReceipt('account', 'food-tracking-pause.resume', { resumed_on: '2026-08-11' }, 'obsolete-resume');
        await store.enqueue({ id: 'old-resume', operation: 'food-tracking-pause.resume', payload: { resumed_on: date } });
        expect((await new OutboxReconciler(store, createQueuedMutationExecutor(api), 'account').reconcile()).replayed).toBe(1);
        await store.enqueue({ id: 'expectation', operation: 'food-tracking-pause.update', payload: { expected_resume_on: null } });
        expect((await new OutboxReconciler(store, createQueuedMutationExecutor(api), 'account').reconcile()).replayed).toBe(1);
        const rows = await readFoodDayReceipts('account');
        expect(queuedFoodDayStatus(rows, date)).toBe('OPEN');
        expect(queuedFoodDayStatus(rows, '2026-08-10', 'OPEN')).toBe('PAUSED');
        expect(queuedFoodDayStatus(rows, '2026-08-12', 'OPEN')).toBe('PAUSED');
        expect(await store.list()).toEqual([]);
    } finally { database.close(); }
});

it('reconciles an ordinary pause refresh before later offline dispatch without erasing pending intent', async () => {
    const namespace = 'account';
    await recordFoodDayReceipt(namespace, 'food-tracking-pause.start', { starts_on: date }, 'old');
    await expect(readAndRecordFoodPause(namespace, async () => { throw new TypeError('offline'); })).rejects.toThrow('offline');
    expect(queuedFoodDayStatus(await readFoodDayReceipts(namespace), '2026-08-10', 'OPEN')).toBe('PAUSED');
    await readAndRecordFoodPause(namespace, async () => ({ pause: { active: false, starts_on: null } as import('@calibrate/api-client').FoodTrackingPause }));
    expect(queuedFoodDayStatus(await readFoodDayReceipts(namespace), '2026-08-10', 'OPEN')).toBe('OPEN');
    const factory = new IDBFactory(); const database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'ordinary-pause' });
    const store = new IndexedDbOutbox(database, namespace);
    try {
        const dispatch = createOutboxDispatch(namespace, () => store.list(), (operation, payload, id) => store.enqueue({ operation, payload, id }), () => true, true);
        await expect(executeOrQueueMutation({ withOutbox: dispatch, operation: 'food.create', payload: { date: '2026-08-10' }, forceQueue: true, execute: async () => undefined, enqueue: async () => undefined })).resolves.toMatchObject({ disposition: 'queued' });
        await store.enqueue({ id: 'pending-pause', operation: 'food-tracking-pause.start', payload: { starts_on: date } });
        await readAndRecordFoodPause(namespace, async () => ({ pause: { active: false, starts_on: null } as import('@calibrate/api-client').FoodTrackingPause }));
        await expect(executeOrQueueMutation({ withOutbox: dispatch, operation: 'food.update', payload: { date: '2026-08-10' }, forceQueue: true, execute: async () => undefined, enqueue: async () => undefined })).rejects.toThrow(/Reopen or resume/);
        expect((await store.list()).map(row => row.id)).toContain('pending-pause');
    } finally { database.close(); }
});

it('orders a slow ordinary pause read before a later explicit pause acknowledgement', async () => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const read = readAndRecordFoodPause('account', async () => { entered(); await gate; return { pause: { active: false, starts_on: null } as import('@calibrate/api-client').FoodTrackingPause }; });
    await started;
    const dispatch = createOutboxDispatch('account', async () => [], async () => undefined, () => true, true);
    const pause = executeOrQueueMutation({ withOutbox: dispatch, operation: 'food-tracking-pause.start', payload: { starts_on: date }, execute: async () => undefined, enqueue: async () => undefined });
    release(); await Promise.all([read, pause]);
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), '2026-08-10', 'OPEN')).toBe('PAUSED');
});

it('coalesces repeated resume after storage restart and replays a lost response with the original ID only', async () => {
    const factory = new IDBFactory(); let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'resume-duplicates' });
    let store = new IndexedDbOutbox(database, 'account');
    const makeDispatch = () => createOutboxDispatch('account', () => store.list(), (operation, payload, id) => store.enqueue({ operation, payload, id }), () => true, true);
    const submit = (resumed_on = date) => executeOrQueueMutation({ withOutbox: makeDispatch(), forceQueue: true, operation: 'food-tracking-pause.resume', payload: { resumed_on }, execute: async () => undefined, enqueue: async () => undefined, createOperationId: () => 'original-resume' });
    let writes = 0, attempts = 0; const ids: string[] = [];
    const api = {
        resumeFoodTracking: async (_payload: unknown, id: string) => { ids.push(id); if (++attempts === 1) { writes++; throw new TypeError('Response lost after commit'); } return undefined; },
        getFoodDay: async () => ({ date, status: 'OPEN' }),
        getFoodTrackingPause: async () => ({ pause: { active: false, starts_on: null } })
    } as unknown as import('@calibrate/api-client').CalibrateApiClient;
    try {
        expect(await submit()).toMatchObject({ disposition: 'queued', operationId: 'original-resume' });
        database.close(); database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'resume-duplicates' });
        store = new IndexedDbOutbox(database, 'account');
        expect(await submit()).toMatchObject({ disposition: 'queued', operationId: 'original-resume' });
        await expect(submit('2026-08-09')).rejects.toThrow(/already saved/);
        expect(await store.list()).toHaveLength(1);
        const executor = createQueuedMutationExecutor(api);
        expect((await new OutboxReconciler(store, executor, 'account').reconcile()).deferredMutation?.id).toBe('original-resume');
        expect((await new OutboxReconciler(store, executor, 'account').reconcile()).replayed).toBe(1);
        expect(ids).toEqual(['original-resume', 'original-resume']); expect(writes).toBe(1); expect(await store.list()).toEqual([]);
    } finally { database.close(); }
});

 it('serializes calendar reads before later controls and keeps failed reads from erasing receipts', async () => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const reading = readAndRecordFoodDays('account', async () => {
        entered(); await gate;
        return { start_date: date, end_date: date, days: [{ date, status: 'OPEN' } as FoodLogDay] };
    });
    await started;
    const dispatch = createOutboxDispatch('account', async () => [], async () => undefined, () => true, true);
    const pausing = executeOrQueueMutation({ withOutbox: dispatch, operation: 'food-tracking-pause.start', payload: { starts_on: date }, execute: async () => undefined, enqueue: async () => undefined });
    release(); await Promise.all([reading, pausing]);
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date)).toBe('PAUSED');
    await expect(readAndRecordFoodDays('account', async () => { throw new Error('range unavailable'); })).rejects.toThrow('range unavailable');
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date)).toBe('PAUSED');
    await readAndRecordFoodDays('account', async () => ({ start_date: date, end_date: date, days: [{ date, status: 'OPEN' } as FoodLogDay] }));
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date)).toBe('OPEN');
    expect(await readFoodDayReceipts('other')).toEqual([]);
 });

it('pause refresh preserves later authoritative backfill while a new explicit start still wins', async () => {
    const pause = { active: true, starts_on: date } as import('@calibrate/api-client').FoodTrackingPause;
    await readAndRecordFoodDay('account', date, async () => ({ date, status: 'OPEN' } as FoodLogDay));
    await recordFoodDayReceipt('account', 'food-tracking-pause.start', { starts_on: date }, 'start');
    await readAndRecordFoodPause('account', async () => ({ pause }));
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date)).toBe('PAUSED');
    await readAndRecordFoodDays('account', async () => ({ start_date: date, end_date: date, days: [{ date, status: 'OPEN' } as FoodLogDay] }));
    await readAndRecordFoodPause('account', async () => ({ pause }));
    await readAndRecordFoodPause('account', async () => ({ pause }));
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), date)).toBe('OPEN');
    expect(queuedFoodDayStatus(await readFoodDayReceipts('account'), '2026-08-09')).toBe('PAUSED');
});
