/** @file Regression coverage for pending Pause: reconstructs a queued start over an inactive or unavailable server response. */

import type { FoodTrackingPause } from '@calibrate/api-client';
import type { QueuedMutation } from '../offline/queuedMutation';
import { applyQueuedPauseIntent } from './pendingPause';
jest.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
const namespace = 'https://example.test::user:7';
const pause: FoodTrackingPause = { active: true, id: 4, starts_on: '2026-07-20', expected_resume_on: '2026-08-03', resumed_on: null, started_at: null, resumed_at: null, materialized_through: '2026-07-21', resume_confirmation_due: false };
const queued = (sequence: number, operation: string, payload: QueuedMutation['payload']): QueuedMutation => ({ sequence, operation, payload, namespace, id: String(sequence), state: 'pending', attemptCount: 0, lastError: null, createdAt: sequence, updatedAt: sequence });

it('reconstructs a queued start over an inactive or unavailable server response', () => {
    const start = queued(1, 'food-tracking-pause.start', { starts_on: '2026-07-21', expected_resume_on: '2026-08-03' });
    for (const server of [undefined, { ...pause, active: false }]) {
        expect(applyQueuedPauseIntent(server, [start], namespace)).toMatchObject({ hasQueuedIntent: true, pause: { active: true, starts_on: '2026-07-21', expected_resume_on: '2026-08-03' } });
    }
});

it('applies durable sequence order, including open-ended updates and early resume', () => {
    const start = queued(1, 'food-tracking-pause.start', { starts_on: '2026-07-21', expected_resume_on: '2026-08-03' });
    const update = queued(2, 'food-tracking-pause.update', { expected_resume_on: null });
    const resume = queued(3, 'food-tracking-pause.resume', { resumed_on: '2026-07-21' });
    expect(applyQueuedPauseIntent(pause, [update, start], namespace).pause).toMatchObject({ active: true, expected_resume_on: null });
    expect(applyQueuedPauseIntent(pause, [resume, update, start], namespace).pause).toMatchObject({ active: false, resumed_on: '2026-07-21' });
});

it('ignores failed, malformed, unrelated, other-account and other-server records', () => {
    const start = queued(1, 'food-tracking-pause.start', { starts_on: '2026-07-21', expected_resume_on: null });
    const ignored: QueuedMutation[] = [{ ...start, state: 'failed' }, { ...start, namespace: 'https://example.test::user:8' }, { ...start, namespace: 'https://other.test::user:7' }, { ...start, payload: null }, { ...start, operation: 'metric.add' }];
    expect(applyQueuedPauseIntent(pause, ignored, namespace)).toEqual({ pause, hasQueuedIntent: false });
    expect(applyQueuedPauseIntent(pause, [start], null)).toEqual({ pause, hasQueuedIntent: false });
    expect(applyQueuedPauseIntent(pause, [{ ...start, state: 'replaying' }], namespace).hasQueuedIntent).toBe(true);
});

it('does not invent a start for an update when canonical metadata is unavailable', () => {
    expect(applyQueuedPauseIntent(undefined, [queued(1, 'food-tracking-pause.update', { expected_resume_on: null })], namespace).pause).toBeUndefined();
});

it('retains an acknowledged inactive snapshot even when canonical metadata is stale, then layers new intent', () => {
    const snapshot = queued(1, 'food-tracking-pause.snapshot', { pause: { ...pause, active: false } });
    const acknowledged = applyQueuedPauseIntent(pause, [snapshot], namespace);
    expect(acknowledged.pause?.active).toBe(false);
    expect(applyQueuedPauseIntent(acknowledged.pause, [queued(1, 'food-tracking-pause.start', { starts_on: '2026-08-05', expected_resume_on: null })], namespace).pause?.active).toBe(true);
    expect(applyQueuedPauseIntent(undefined, [queued(1, 'food-tracking-pause.resume', { resumed_on: '2026-08-05' })], namespace).pause?.active).toBe(false);
});
