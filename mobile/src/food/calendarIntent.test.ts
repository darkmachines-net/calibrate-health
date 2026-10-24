/** @file Regression coverage for calendar Intent: projects absent dates and keeps the actual resume boundary open. */

import type { FoodLogDay } from '@calibrate/api-client';
import type { QueuedMutation } from '../offline/queuedMutation';
import { calendarDayWithIntent } from './calendarIntent';
const row = (operation: string, payload: QueuedMutation['payload'], id = 'queued'): QueuedMutation => ({ id, operation, payload, namespace: 'account', sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 });
const date = '2026-07-21';
const pause = row('food-tracking-pause.start', { starts_on: '2026-07-20' }, 'receipt:pause');
it('projects absent dates and keeps the actual resume boundary open', () => {
    expect(calendarDayWithIntent(date, undefined, [pause])?.status).toBe('PAUSED');
    const intent = [pause, row('food-tracking-pause.resume', { resumed_on: date })];
    expect(calendarDayWithIntent('2026-07-20', undefined, intent)?.status).toBe('PAUSED');
    expect(calendarDayWithIntent(date, undefined, intent)?.status).toBe('OPEN');
});
it('keeps fresh server receipts authoritative, then applies later explicit pending intent', () => {
    const receipt = row('food-day.set-status', { date, status: 'COMPLETE' }, 'receipt:day');
    const day = { date, status: 'COMPLETE', calorie_comparison: { consumed_kcal: 2000, target_kcal: 2100, maintenance_kcal: 2400, captured_at: '2026-07-21T20:00:00Z' } } as FoodLogDay;
    expect(calendarDayWithIntent(date, day, [pause, receipt])).toBe(day);
    expect(calendarDayWithIntent(date, day, [pause, receipt, row('food-tracking-pause.start', { starts_on: date })])).toMatchObject({ status: 'PAUSED' });
});
it('does not let stale generic controls override a pause, but permits intentional historical Backfill', () => {
    const stale = row('food-day.set-status', { date, status: 'OPEN' });
    expect(calendarDayWithIntent(date, undefined, [pause, stale])?.status).toBe('PAUSED');
    expect(calendarDayWithIntent(date, undefined, [pause, row('food-day.set-status', { date, status: 'OPEN', explicitPausedBackfill: true })])?.status).toBe('OPEN');
});
it('preserves missing data with no applicable intent and drops stale comparisons when status changes', () => {
    expect(calendarDayWithIntent('2026-07-19', undefined, [pause])).toBeUndefined();
    const day = { date, status: 'COMPLETE', calorie_comparison: { consumed_kcal: 1 } } as FoodLogDay;
    expect(calendarDayWithIntent(date, day, [pause])?.calorie_comparison).toBeUndefined();
});
it('keeps the comparison color when queued completion or reopening changes only the tracking shape', () => {
    const comparison = { consumed_kcal: 2600, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-21T20:00:00Z' };
    const day = { date, status: 'COMPLETE', calorie_comparison: comparison } as FoodLogDay;
    const reopened = calendarDayWithIntent(date, day, [row('food-day.set-status', { date, status: 'OPEN' })]);
    expect(reopened).toMatchObject({ status: 'OPEN', calorie_comparison: comparison });
    expect(calendarDayWithIntent(date, reopened, [row('food-day.set-status', { date, status: 'COMPLETE' })]))
        .toMatchObject({ status: 'COMPLETE', calorie_comparison: comparison });
});
