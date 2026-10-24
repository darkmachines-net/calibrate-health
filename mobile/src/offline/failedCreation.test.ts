/** @file Regression coverage for failed Creation: matches failed updates/deletes on a server row without crossing dates or account namespaces. */

import { failedFoodDiscardIds, findFailedFood } from './failedCreation';
import type { QueuedMutation } from './queuedMutation';
const row = (id: string, payload: QueuedMutation['payload'], overrides: Partial<QueuedMutation> = {}): QueuedMutation => ({ id, namespace: 'origin::user:1', operation: 'food.update', payload, state: 'pending', sequence: 1, attemptCount: 0, createdAt: 1, updatedAt: 1, lastError: null, ...overrides });
it('matches failed updates/deletes on a server row without crossing dates or account namespaces', () => {
    const rows = [row('failed', { id: 42, date: '2026-07-18' }, { state: 'failed' }), row('edit', { id: 42, date: '2026-07-18' }), row('delete', { id: 42, date: '2026-07-18' }, { operation: 'food.delete' }), row('other-date', { id: 42, date: '2026-07-19' }), row('other-account', { id: 42, date: '2026-07-18' }, { namespace: 'origin::user:2' })];
    expect(failedFoodDiscardIds(rows, 'failed')).toEqual(['failed', 'edit', 'delete']);
    expect(findFailedFood(rows, { id: 42, date: '2026-07-19' })).toBeUndefined();
    expect(findFailedFood(rows, { id: 42, date: '2026-07-18' })?.id).toBe('failed');
});
it('never identifies optimistic rows by a colliding synthetic ID and refuses active replay', () => {
    const first = { id: -1, localCreation: { operationId: 'first' } };
    const second = { id: -1, localCreation: { operationId: 'second' } };
    const rows = [row('failed', first, { state: 'failed' }), row('independent', second)];
    expect(failedFoodDiscardIds(rows, 'failed')).toEqual(['failed']);
    expect(findFailedFood(rows, second)).toBeUndefined();
    expect(() => failedFoodDiscardIds([...rows, row('active', first, { state: 'replaying' })], 'failed')).toThrow('currently syncing');
});
it('supports failed deletion recovery and preserves the original payload on retry instead of fabricating a new request', () => {
    const failed = row('delete', { id: 42 }, { operation: 'food.delete', state: 'failed' });
    expect(findFailedFood([failed], { id: 42 })).toBe(failed);
    expect(failedFoodDiscardIds([failed], 'delete')).toEqual(['delete']);
    expect(() => failedFoodDiscardIds([{ ...failed, state: 'pending' }], 'delete')).toThrow('changed');
});
