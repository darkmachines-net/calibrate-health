/** @file Regression coverage for copy Food When Synchronized: rejects stale-tab copy after durable food intent and serializes a copy before later intent. */

import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOutbox, openIndexedDbOutboxDatabase } from '../offline/indexedDbOutbox.web';
import { createOutboxDispatch } from '../offline/mutationDispatch';
import { copyFoodWhenSynchronized } from './copyFoodWhenSynchronized';
jest.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
it('rejects stale-tab copy after durable food intent and serializes a copy before later intent', async () => {
    const database = await openIndexedDbOutboxDatabase({ factory: new IDBFactory(), databaseName: 'copy-ordering' });
    const store = new IndexedDbOutbox(database, 'account');
    const dispatch = () => createOutboxDispatch('account', () => store.list(), (operation, payload, id) => store.enqueue({ operation, payload, id }), () => true);
    try {
        const staleTab = dispatch();
        await store.enqueue({ id: 'food', operation: 'food.create', payload: { date: '2026-08-08' } });
        const copy = jest.fn(async () => ({ copied_count: 1 }));
        await expect(copyFoodWhenSynchronized(staleTab, copy)).rejects.toThrow(/Synchronize saved changes/);
        expect(copy).not.toHaveBeenCalled();
        expect((await store.claimNext())?.id).toBe('food');
        await store.complete('food');
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
        const events: string[] = [];
        const copying = copyFoodWhenSynchronized(staleTab, async () => { entered(); await gate; events.push('copy'); return 1; });
        await started;
        const later = dispatch()(async enqueue => { events.push('food'); await enqueue('food.create', { date: '2026-08-08' }, 'later'); });
        await Promise.resolve(); expect(events).toEqual([]);
        release(); await Promise.all([copying, later]); expect(events).toEqual(['copy', 'food']);
    } finally { database.close(); }
});
