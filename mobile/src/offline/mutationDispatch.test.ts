/** @file Regression coverage for mutation Dispatch: consults durable state after another producer enqueues despite an empty React snapshot. */

import { createOutboxDispatch } from './mutationDispatch';
import { executeOrQueueMutation, OFFLINE_MUTATION_OPERATIONS } from './operations';
import type { QueuedMutation } from './queuedMutation';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'completion' }));

it('consults durable state after another producer enqueues despite an empty React snapshot', async () => {
    const rows: QueuedMutation[] = [];
    const enqueue = jest.fn(async (operation: string, payload: unknown, id?: string) => { rows.push({ id, operation, payload } as QueuedMutation); });
    const first = createOutboxDispatch('same-account', async () => rows, enqueue, () => true);
    const second = createOutboxDispatch('same-account', async () => rows, enqueue, () => true);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const queued = first(async write => { await barrier; await write('food.create', {}, 'food'); });
    const execute = jest.fn(async () => undefined);
    const completion = executeOrQueueMutation({ operation: OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS,
        forceQueue: false, withOutbox: second, payload: { date: '2026-07-21', status: 'COMPLETE' }, execute, enqueue });
    release(); await queued;
    await expect(completion).resolves.toEqual({ disposition: 'queued', operationId: 'completion' });
    expect(rows.map(row => row.id)).toEqual(['food', 'completion']);
    expect(execute).not.toHaveBeenCalled();
});

it('holds the namespace lock through a direct attempt and isolates other accounts', async () => {
    const order: string[] = []; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const a = createOutboxDispatch('one', async () => [], async () => undefined, () => true);
    const b = createOutboxDispatch('two', async () => [], async () => undefined, () => true);
    const first = a(async () => { order.push('first'); await barrier; order.push('done'); });
    const second = a(async () => { order.push('second'); });
    await b(async () => { order.push('other-account'); });
    expect(order).toEqual(['first', 'other-account']);
    release(); await Promise.all([first, second]);
    expect(order).toEqual(['first', 'other-account', 'done', 'second']);
});

it('rejects a stale account binding before dispatch', async () => {
    const work = jest.fn(async () => undefined);
    await expect(createOutboxDispatch('old', async () => [], async () => undefined, () => false)(work)).rejects.toThrow('account changed');
    expect(work).not.toHaveBeenCalled();
});
