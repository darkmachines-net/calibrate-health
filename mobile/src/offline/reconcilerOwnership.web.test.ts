/** @file Regression coverage for reconciler Ownership web: preserves queued work without attempting recovery or replay when exclusive ownership is unavailable. */

jest.mock('./mutationLock', () => ({ withMutationLock: async (_namespace: string, work: (exclusive: boolean) => Promise<unknown>) => work(false) }));
import { OutboxReconciler } from './reconciler';
import type { OutboxStore } from './outbox';

it('preserves queued work without attempting recovery or replay when exclusive ownership is unavailable', async () => {
    const recoverInterrupted = jest.fn(async () => undefined);
    const execute = jest.fn(async () => undefined);
    const reconciler = new OutboxReconciler({ recoverInterrupted } as unknown as OutboxStore, execute, 'account');
    await expect(reconciler.reconcile()).rejects.toThrow('requires browser Web Locks');
    expect(recoverInterrupted).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
});
