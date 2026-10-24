/** @file Regression coverage for failed Mutation Recovery: scopes metric recovery by day and namespace, preserving food and other dates. */

import { assertRecoverableEnqueue, failedMutationDiscardIds, findFailedMetric } from './failedMutationRecovery';
import { OFFLINE_MUTATION_OPERATIONS } from './mutationKinds';
import type { QueuedMutation } from './queuedMutation';
const ns = 'https://health.example::user:7';
const row = (id: string, operation: string, payload: QueuedMutation['payload'], state: QueuedMutation['state'] = 'pending', namespace = ns): QueuedMutation => ({ id, operation, payload, state, namespace, sequence: 1, attemptCount: 1, lastError: null, createdAt: 1, updatedAt: 1 });

it.each(Object.values(OFFLINE_MUTATION_OPERATIONS))('enforces failed-head recovery for %s without changing the original request', operation => {
    const parent = row('failed', operation, { id: 42, date: '2026-07-21', weight: 88 }, 'failed');
    let correction = { operation, payload: { id: 42, date: '2026-07-21', weight: 89 } as QueuedMutation['payload'] };
    if (operation === 'food.create') correction = { operation: 'food.update', payload: { localCreation: { operationId: 'failed' }, update: { calories: 400 }, date: '2026-07-21' } };
    if (operation === 'food-tracking-pause.start') correction = { operation: 'food-tracking-pause.resume', payload: { resumed_on: '2026-07-21' } };
    if (operation === 'food-tracking-pause.update') correction = { operation, payload: { expected_resume_on: '2026-07-22' } };
    if (operation === 'food-tracking-pause.resume') correction = { operation: 'food-tracking-pause.start', payload: { starts_on: '2026-07-22', expected_resume_on: null } };
    expect(() => assertRecoverableEnqueue([parent], correction, ns)).toThrow(/Resolve the failed (related|pause|tracking) change/);
    expect(() => assertRecoverableEnqueue([parent], correction, 'https://other.example::user:7')).not.toThrow();
    expect(() => assertRecoverableEnqueue([{ ...parent, state: 'pending' }], correction, ns)).not.toThrow();
    expect(parent.payload).toEqual({ id: 42, date: '2026-07-21', weight: 88 });
});
it('scopes metric recovery by day and namespace, preserving food and other dates', () => {
    const rows = [row('failed', 'metric.add', { date: '2026-07-21', weight: 88 }, 'failed'), row('correction', 'metric.add', { date: '2026-07-21', weight: 89 }), row('delete', 'metric.delete', { id: -1, date: '2026-07-21' }), row('next-day', 'metric.add', { date: '2026-07-22', weight: 90 }), row('food', 'food.create', { date: '2026-07-21', calories: 400 }), row('other-account', 'metric.add', { date: '2026-07-21' }, 'pending', 'https://health.example::user:8')];
    expect(failedMutationDiscardIds(rows, 'failed')).toEqual(['failed', 'correction', 'delete']);
    expect(findFailedMetric(rows, '2026-07-22')).toBeUndefined();
    expect(() => assertRecoverableEnqueue(rows, { operation: 'metric.add', payload: { date: '2026-07-22', weight: 90 } }, ns)).not.toThrow();
    expect(() => failedMutationDiscardIds(rows.map(r => r.id === 'delete' ? { ...r, state: 'replaying' } : r), 'failed')).toThrow('currently syncing');
});
it('requires recovery of a legacy deletion with unknown date without discarding unrelated dates', () => {
    const rows = [row('failed', 'metric.delete', { id: 42 }, 'failed'), row('same-id', 'metric.delete', { id: 42 }), row('other-day', 'metric.add', { date: '2026-07-22', weight: 90 })];
    expect(findFailedMetric(rows, '2026-07-21')?.id).toBe('failed');
    expect(() => assertRecoverableEnqueue(rows, { operation: 'metric.add', payload: { date: '2026-07-22', weight: 90 } }, ns)).toThrow('Resolve');
    expect(failedMutationDiscardIds(rows, 'failed')).toEqual(['failed', 'same-id']);
});
it('reviews dependent tracking-control requests together without discarding food or weight', () => {
    const rows = [row('failed', 'food-tracking-pause.start', { starts_on: '2026-07-21' }, 'failed'), row('resume', 'food-tracking-pause.resume', { date: '2026-07-22' }), row('complete', 'food-day.set-status', { date: '2026-07-23' }), row('weight', 'metric.add', { date: '2026-07-21', weight: 88 })];
    expect(failedMutationDiscardIds(rows, 'failed')).toEqual(['failed', 'resume', 'complete']);
    expect(() => failedMutationDiscardIds([{ ...rows[0], state: 'pending' }], 'failed')).toThrow('changed');
});
