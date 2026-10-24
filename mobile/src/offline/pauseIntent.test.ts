/** @file Regression coverage for pause Intent: checks every active/inactive transition and coalesces only identical final pending intent. */

import { IDBFactory } from 'fake-indexeddb';
import { validatePauseTransition } from './pauseIntent';
import { assertRecoverableEnqueue } from './failedMutationRecovery';
import { IndexedDbOutbox, openIndexedDbOutboxDatabase } from './indexedDbOutbox.web';
import { createOutboxDispatch } from './mutationDispatch';
import { executeOrQueueMutation } from './operations';
import { OutboxReconciler } from './reconciler';
import type { QueuedMutation } from './queuedMutation';
jest.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
const start = 'food-tracking-pause.start', update = 'food-tracking-pause.update', resume = 'food-tracking-pause.resume';
const payloads: Record<string, QueuedMutation['payload']> = { [start]: { starts_on: '2026-08-08', expected_resume_on: null }, [update]: { expected_resume_on: '2026-08-10' }, [resume]: { resumed_on: '2026-08-08' } };
const row = (operation: string, payload: QueuedMutation['payload'] = payloads[operation]): QueuedMutation => ({ id: operation, operation, payload, namespace: 'account', sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 });

it.each([start, update, resume])('accepts %s with unknown state, preserves explicit authority, and rejects failed pause barriers', operation => {
    expect(validatePauseTransition([], operation, payloads[operation])).toBeUndefined();
    expect(() => validatePauseTransition([{ ...row(start), state: 'failed' }], operation, payloads[operation])).toThrow(/failed pause/);
});
it('checks every active/inactive transition and coalesces only identical final pending intent', () => {
    const active = row('food-tracking-pause.snapshot', { pause: { active: true } });
    const inactive = row('food-tracking-pause.snapshot', { pause: { active: false } });
    for (const rows of [[active], [row(start)]]) {
        expect(validatePauseTransition(rows, update, payloads[update])).toBeUndefined();
        expect(validatePauseTransition(rows, resume, payloads[resume])).toBeUndefined();
        expect(() => validatePauseTransition(rows, start, { starts_on: '2026-08-09', expected_resume_on: null })).toThrow(/already paused/);
    }
    for (const rows of [[inactive], [row(resume)]]) {
        expect(validatePauseTransition(rows, start, payloads[start])).toBeUndefined();
        expect(() => validatePauseTransition(rows, update, payloads[update])).toThrow(/resumed|resume is already saved/);
        expect(() => validatePauseTransition(rows, resume, { resumed_on: '2026-08-09' })).toThrow(/resumed|resume is already saved/);
    }
    for (const operation of [start, update, resume]) {
        const existing = row(operation);
        expect(validatePauseTransition([existing], operation, payloads[operation])).toBe(existing);
        expect(() => assertRecoverableEnqueue([existing], { id: 'duplicate', operation, payload: payloads[operation] }, 'account')).toThrow(/already saved/);
    }
    expect(validatePauseTransition([row(start), row(resume), row(start)], update, payloads[update])).toBeUndefined();
    expect(validatePauseTransition([row(start), row(update), row(resume)], start, payloads[start])).toBeUndefined();
});

it('protects stale producers and both transactional guards through repeated cycles, restart and replay', async () => {
    const factory = new IDBFactory(); let database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'pause-matrix' });
    let store = new IndexedDbOutbox(database, 'account'); let next = 0;
    const dispatch = () => createOutboxDispatch('account', () => store.list(), (operation, payload, id) => store.enqueue({ operation, payload, id }), () => true);
    const send = (operation: typeof start | typeof update | typeof resume, payload = payloads[operation]) => executeOrQueueMutation({ withOutbox: dispatch(), forceQueue: true, operation, payload, execute: async () => undefined, enqueue: async () => undefined, createOperationId: () => String(++next) });
    try {
        for (let cycle = 0; cycle < 2; cycle++) {
            const first = await send(start); expect(await send(start)).toEqual(first);
            await expect(store.enqueue({ id: 'duplicate-start', operation: start, payload: payloads[start] })).rejects.toThrow(/already saved/);
            await send(update); await send(resume);
            await expect(send(update)).rejects.toThrow(/resume is already saved/);
            await expect(store.enqueue({ id: 'stale-update', operation: update, payload: payloads[update] })).rejects.toThrow(/resume is already saved/);
        }
        const before = await store.list(); expect(before).toHaveLength(6);
        database.close(); database = await openIndexedDbOutboxDatabase({ factory, databaseName: 'pause-matrix' }); store = new IndexedDbOutbox(database, 'account');
        expect((await store.list()).map(r => r.id)).toEqual(before.map(r => r.id));
        let active = false;
        const result = await new OutboxReconciler(store, async mutation => {
            if (mutation.operation === start) { expect(active).toBe(false); active = true; }
            else { expect(active).toBe(true); if (mutation.operation === resume) active = false; }
        }).reconcile();
        expect(result.replayed).toBe(6); expect(result.failedMutation).toBeNull(); expect(active).toBe(false);
    } finally { database.close(); }
});
