/** @file Regression coverage for tracking Receipts: keeps acknowledged food visible through partial replay and deduplicates a pre-dequeue crash. */

import { QueryClient } from '@tanstack/react-query';
import { applyTrackingReceipt } from './trackingReceipts';
import { projectFood, preserveFoodReceiptIdentities } from './trackingProjection';
import type { QueuedMutation } from './queuedMutation';

it('keeps acknowledged food visible through partial replay and deduplicates a pre-dequeue crash', () => {
    const client = new QueryClient();
    const date = '2026-07-21';
    const create = { id: 'stable-create', sequence: 1, operation: 'food.create', payload: { date, name: 'Oats', calories: 200, meal_period: 'BREAKFAST' }, state: 'replaying', namespace: 'https://one.invalid::user:1', attemptCount: 1, lastError: null, createdAt: 1, updatedAt: 1 } as QueuedMutation;
    applyTrackingReceipt(client, create, { id: 501, name: 'Oats', calories: 200, meal_period: 'BREAKFAST' });
    const snapshot = JSON.parse(JSON.stringify(client.getQueryData(['mobile-food', date])));
    expect(projectFood(snapshot, [create], date)).toEqual([expect.objectContaining({ id: 501, name: 'Oats' })]);
    expect(projectFood(snapshot, [], date)).toEqual(snapshot);
    const refreshed = preserveFoodReceiptIdentities([{ id: 501, name: 'Server refreshed oats', calories: 210, meal_period: 'BREAKFAST' }], snapshot);
    expect(projectFood(refreshed, [create], date)).toEqual([expect.objectContaining({ id: 501, name: 'Server refreshed oats', calories: 210 })]);
    const edit = { ...create, id: 'stable-edit', operation: 'food.update', payload: { id: 501, update: { calories: 300 } } } as QueuedMutation;
    applyTrackingReceipt(client, edit, { id: 501, name: 'Oats', calories: 300, meal_period: 'BREAKFAST' });
    expect(projectFood(client.getQueryData(['mobile-food', date]), [], date)).toEqual([expect.objectContaining({ calories: 300, localOperationId: 'stable-create' })]);
    applyTrackingReceipt(client, { ...edit, operation: 'food.delete' }, { id: 501 });
    expect(client.getQueryData(['mobile-food', date])).toEqual([]);
    client.clear();
});
