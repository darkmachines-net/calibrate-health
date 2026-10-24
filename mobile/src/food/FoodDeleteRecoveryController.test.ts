/** @file Regression coverage for Food Delete Recovery Controller: FoodDeleteRecoveryController. */

import { FoodDeleteRecoveryController } from './FoodDeleteRecoveryController';
import { getFoodDeleteHiddenIds, type FoodDeleteTicket } from './foodDeleteRecovery';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

type Entry = { id: number; name: string };

const entry = (id: number): Entry => ({ id, name: `Food ${id}` });

async function drainPromises(): Promise<void> {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('FoodDeleteRecoveryController', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('optimistically hides for six seconds and Undo performs zero delete work', async () => {
        const commit = jest.fn(async () => 'synced');
        const controller = new FoodDeleteRecoveryController<Entry, string>({
            commit,
            createOperationId: () => 'delete-1',
            now: () => 1_000
        });

        const ticket = controller.requestDelete(entry(1));
        expect(ticket).toEqual(expect.objectContaining({
            operationId: 'delete-1',
            requestedAt: 1_000,
            expiresAt: 7_000
        }));
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([1]);

        jest.advanceTimersByTime(5_999);
        await drainPromises();
        expect(commit).not.toHaveBeenCalled();
        expect(controller.undo('delete-1')).toBe(true);
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([]);

        jest.advanceTimersByTime(10_000);
        await drainPromises();
        expect(commit).not.toHaveBeenCalled();
    });

    it('commits once after six seconds and keeps the stable operation ID', async () => {
        const commit = jest.fn(async () => 'synced');
        const controller = new FoodDeleteRecoveryController<Entry, string>({
            commit,
            createOperationId: () => 'stable-delete-id'
        });

        const firstRequest = controller.requestDelete(entry(2));
        const duplicateRequest = controller.requestDelete(entry(2));
        expect(duplicateRequest).toBe(firstRequest);
        jest.advanceTimersByTime(6_000);
        await drainPromises();
        await controller.flush();

        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith(expect.objectContaining({
            operationId: 'stable-delete-id',
            entry: entry(2)
        }));
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([2]);
    });

    it('flushes the first delete before opening the second Undo window and serializes commits', async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const events: string[] = [];
        const commit = jest.fn(async (ticket: FoodDeleteTicket<Entry>) => {
            events.push(`start:${ticket.entry.id}`);
            if (ticket.entry.id === 1) await firstGate;
            events.push(`finish:${ticket.entry.id}`);
            return 'synced';
        });
        const ids = ['delete-1', 'delete-2'];
        const controller = new FoodDeleteRecoveryController<Entry, string>({
            commit,
            createOperationId: () => ids.shift() ?? 'unexpected'
        });

        controller.requestDelete(entry(1));
        controller.requestDelete(entry(2));
        await drainPromises();
        expect(events).toEqual(['start:1']);
        expect(controller.getSnapshot().pending?.entry.id).toBe(2);

        jest.advanceTimersByTime(6_000);
        await drainPromises();
        expect(commit).toHaveBeenCalledTimes(1);
        releaseFirst();
        await drainPromises();

        expect(events).toEqual(['start:1', 'finish:1', 'start:2', 'finish:2']);
        expect(commit.mock.calls.map(([ticket]) => ticket.operationId)).toEqual(['delete-1', 'delete-2']);
    });

    it('restores a failed entry and retries only that entry with the same operation ID', async () => {
        const commit = jest.fn()
            .mockRejectedValueOnce(new Error('secret database detail'))
            .mockResolvedValueOnce('synced');
        const controller = new FoodDeleteRecoveryController<Entry, string>({
            commit,
            createOperationId: () => 'stable-retry-id'
        });

        controller.requestDelete(entry(3));
        const firstAttempt = await controller.flush();

        expect(firstAttempt).toEqual(expect.objectContaining({ status: 'failed' }));
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([]);
        expect(controller.getSnapshot().failures).toEqual([
            expect.objectContaining({
                ticket: expect.objectContaining({ operationId: 'stable-retry-id', entry: entry(3) }),
                message: 'Unable to delete this food entry.'
            })
        ]);
        expect(controller.getSnapshot().failures[0].message).not.toContain('database');

        await controller.retry('another-operation');
        expect(commit).toHaveBeenCalledTimes(1);
        await controller.retry('stable-retry-id');
        expect(commit).toHaveBeenCalledTimes(2);
        expect(commit.mock.calls[1][0].operationId).toBe('stable-retry-id');
        expect(controller.getSnapshot().failures).toEqual([]);
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([3]);
    });

    it('releases a completed tombstone only after refreshed entries confirm deletion', async () => {
        const controller = new FoodDeleteRecoveryController<Entry, string>({
            commit: async () => 'queued',
            createOperationId: () => 'queued-delete'
        });
        controller.requestDelete(entry(9));
        await controller.flush();

        controller.reconcileEntries([entry(9), entry(10)]);
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([9]);
        controller.reconcileEntries([entry(10)]);
        expect(getFoodDeleteHiddenIds(controller.getSnapshot())).toEqual([]);
    });
});
