/** @file Regression coverage for food Day Intent web: preserves earlier paused dates when a later date resumes and folds legacy completion. */

import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOutbox, openIndexedDbOutboxDatabase } from './indexedDbOutbox.web';
import { assertQueuedDayTransition, assertQueuedFoodDayOpen, queuedFoodDayStatus } from './foodDayIntent';
import { createOutboxDispatch } from './mutationDispatch';
import { executeOrQueueMutation } from './operations';
import { OutboxReconciler } from './reconciler';
import type { QueuedMutation } from './queuedMutation';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }));
const date = '2026-08-08';
const row = (operation: string, payload: QueuedMutation['payload'], state: QueuedMutation['state'] = 'pending'): QueuedMutation => ({
    id: operation, operation, payload, state, namespace: 'account', sequence: 1, attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1
});

it.each(['food.create', 'food.update', 'food.delete'])('%s requires explicit reopening and respects ordered day/pause intent', operation => {
    const complete = row('food-day.set-status', { date, status: 'COMPLETE' });
    const reopen = row('food-day.set-status', { date, status: 'OPEN' });
    const pause = row('food-tracking-pause.start', { starts_on: date });
    const resume = row('food-tracking-pause.resume', { resumed_on: date });
    for (const controls of [[complete], [reopen, complete], [pause], [complete, reopen, pause]]) {
        expect(() => assertQueuedFoodDayOpen(controls, operation, { date })).toThrow(/Reopen or resume/);
    }
    for (const controls of [[], [complete, reopen], [pause, resume], [row('food-day.update', { date, is_complete: false })], [complete, pause, resume]]) {
        expect(() => assertQueuedFoodDayOpen(controls, operation, { date })).not.toThrow();
    }
    expect(() => assertQueuedFoodDayOpen([complete], operation, { date: '2026-08-09' })).not.toThrow();
    expect(() => assertQueuedFoodDayOpen([row('food-day.set-status', { date, status: 'OPEN' }, 'failed')], operation, { date })).toThrow(/failed tracking/);
    expect(() => assertQueuedFoodDayOpen([complete], operation, {})).toThrow(/Refresh/);
});

it('preserves earlier paused dates when a later date resumes and folds legacy completion', () => {
    const controls = [row('food-tracking-pause.start', { starts_on: '2026-08-07' }), row('food-tracking-pause.resume', { resumed_on: '2026-08-09' })];
    expect(queuedFoodDayStatus(controls, date, 'OPEN')).toBe('PAUSED');
    expect(queuedFoodDayStatus(controls, '2026-08-09', 'PAUSED')).toBe('OPEN');
    expect(queuedFoodDayStatus([row('food-day.set-status', { date: '2026-08-10', status: 'COMPLETE' }), row('food-tracking-pause.resume', { resumed_on: '2026-08-09' })], '2026-08-10')).toBe('COMPLETE');
    expect(queuedFoodDayStatus([row('food-day.update', { date, is_complete: true })], date, 'OPEN')).toBe('COMPLETE');
});

it('rejects stale-tab food after completion, retains explicit repeated reopening, and replays the persisted sequence after restart', async () => {
    const factory = new IDBFactory();
    let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'day-transitions' });
    let store = new IndexedDbOutbox(database, 'account');
    let sequence = 0;
    const dispatch = () => createOutboxDispatch('account', () => store.list(), (operation, payload, id) => store.enqueue({ operation, payload, id: id ?? `request-${++sequence}` }), () => true);
    const firstTab = dispatch(), staleTab = dispatch();
    const execute = jest.fn(async () => undefined);
    const send = (withOutbox: ReturnType<typeof dispatch>, operation: 'food-day.set-status' | 'food.create' | 'food.update' | 'food.delete', payload: unknown) => executeOrQueueMutation({ withOutbox, forceQueue: true, operation, payload, execute, enqueue: async () => { throw new Error('Must use locked enqueue'); }, createOperationId: () => `request-${++sequence}` });
    try {
        for (let cycle = 0; cycle < 2; cycle++) {
            await send(firstTab, 'food-day.set-status', { date, status: 'COMPLETE' });
            for (const operation of ['food.create', 'food.update', 'food.delete'] as const) {
                await expect(send(staleTab, operation, { date, calories: 120 })).rejects.toThrow(/Reopen or resume/);
                await expect(store.enqueue({ id: `bypass-${cycle}-${operation}`, operation, payload: { date } })).rejects.toThrow(/Reopen or resume/);
            }
            // A deliberate day reopen, then an explicit food submission; never a replay-generated action.
            await send(staleTab, 'food-day.set-status', { date, status: 'OPEN' });
            await send(firstTab, 'food.create', { date, calories: 120 });
        }
        const before = await store.list();
        expect(before.map(item => (item.payload as { status?: string }).status ?? item.operation)).toEqual(['COMPLETE', 'OPEN', 'food.create', 'COMPLETE', 'OPEN', 'food.create']);
        expect(execute).not.toHaveBeenCalled();
        database.close();
        database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'day-transitions' });
        store = new IndexedDbOutbox(database, 'account');
        expect((await store.list()).map(item => item.id)).toEqual(before.map(item => item.id));
        let status = 'OPEN'; let foods = 0; const replayed: string[] = [];
        const result = await new OutboxReconciler(store, async item => {
            const payload = item.payload as { status?: string };
            if (payload.status) status = payload.status;
            else { expect(status).toBe('OPEN'); foods++; }
            replayed.push(item.id);
        }).reconcile();
        expect(result.failedMutation).toBeNull(); expect(result.replayed).toBe(6);
        expect(foods).toBe(2); expect(replayed).toEqual(before.map(item => item.id));
        expect(await store.list()).toEqual([]);
    } finally { database.close(); }
});

it('rejects all stale day transitions under pending or acknowledged pause while preserving explicit backfill and server authority', () => {
    const pause = row('food-tracking-pause.start', { starts_on: date });
    const forms = [row('food-day.set-status', { date, status: 'OPEN' }), row('food-day.set-status', { date, status: 'COMPLETE' }), row('food-day.set-status', { date, status: 'INCOMPLETE' }), row('food-day.update', { date, is_complete: false }), row('food-day.update', { date, is_complete: true })];
    for (const paused of [pause, { ...pause, id: 'receipt:pause' }]) for (const form of forms) {
        expect(() => assertQueuedDayTransition([paused], form.operation, form.payload)).toThrow(/paused/);
        expect(queuedFoodDayStatus([paused, form], date)).toBe('PAUSED');
        expect(() => assertQueuedFoodDayOpen([paused, form], 'food.create', { date })).toThrow(/Reopen or resume/);
        expect(() => assertQueuedDayTransition([paused, row('food-tracking-pause.resume', { resumed_on: date })], form.operation, form.payload)).not.toThrow();
    }
    const backfill = row('food-day.set-status', { date, status: 'OPEN', explicitPausedBackfill: true });
    expect(() => assertQueuedDayTransition([pause], backfill.operation, backfill.payload)).not.toThrow();
    expect(queuedFoodDayStatus([pause, backfill], date)).toBe('OPEN');
    expect(queuedFoodDayStatus([pause, { ...forms[0], id: 'receipt:server-day' }], date)).toBe('OPEN');
    expect(() => assertQueuedDayTransition([pause], 'food-day.update', { date, is_complete: false, explicitPausedBackfill: true })).toThrow(/paused/);
});

it('rejects stale reopen before insertion and preserves explicit historical backfill through restart and replay', async () => {
    const factory = new IDBFactory(); let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'paused-backfill' });
    let store = new IndexedDbOutbox(database, 'account'); let id = 0;
    const dispatch = createOutboxDispatch('account', () => store.list(), (operation, payload, requestId) => store.enqueue({ operation, payload, id: requestId }), () => true);
    const send = (operation: 'food-tracking-pause.start' | 'food-day.set-status' | 'food.create', payload: unknown) => executeOrQueueMutation({ withOutbox: dispatch, forceQueue: true, operation, payload, execute: async () => undefined, enqueue: async () => undefined, createOperationId: () => String(++id) });
    try {
        await send('food-tracking-pause.start', { starts_on: date, expected_resume_on: null });
        await expect(send('food-day.set-status', { date, status: 'OPEN' })).rejects.toThrow(/paused/);
        await expect(store.enqueue({ id: 'bypass', operation: 'food-day.update', payload: { date, is_complete: false } })).rejects.toThrow(/paused/);
        expect(await store.list()).toHaveLength(1);
        await send('food-day.set-status', { date, status: 'OPEN', explicitPausedBackfill: true });
        await send('food.create', { date, calories: 120 });
        const ids = (await store.list()).map(row => row.id);
        database.close(); database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'paused-backfill' }); store = new IndexedDbOutbox(database, 'account');
        expect((await store.list()).map(row => row.id)).toEqual(ids);
        const applied: QueuedMutation[] = [];
        const result = await new OutboxReconciler(store, async mutation => {
            if (mutation.operation === 'food.create') expect(queuedFoodDayStatus(applied, date)).toBe('OPEN');
            applied.push(mutation);
        }).reconcile();
        expect(result.replayed).toBe(3); expect(result.failedMutation).toBeNull();
        expect(queuedFoodDayStatus(applied, '2026-08-09')).toBe('PAUSED');
    } finally { database.close(); }
});
