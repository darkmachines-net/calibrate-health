/** @file Regression coverage for tracking Projection: durable tracking overlays. */

import { projectFood, projectMetrics, localTarget, foodWirePayload } from './trackingProjection';
import type { QueuedMutation } from './queuedMutation';
const mutation = (sequence: number, operation: string, payload: unknown): QueuedMutation => ({ sequence, id: 'operation-' + sequence, namespace: 'https://one.invalid::user:1', operation, payload: payload as QueuedMutation['payload'], state: 'pending', attemptCount: 0, lastError: null, createdAt: sequence, updatedAt: sequence });
const date = '2026-07-21';

describe('durable tracking overlays', () => {
    it('shows weight additions, repeated corrections and deletion after JSON restart without mutating server cache', () => {
        const base = [{ id: 7, date: '2026-07-20', weight: 90 }];
        const queue = [mutation(1, 'metric.add', { date, weight: 88 }), mutation(2, 'metric.add', { date, weight: 87.9 })];
        const rows = projectMetrics(base, JSON.parse(JSON.stringify(queue)))!;
        expect(rows.find(row => row.date === date)?.weight).toBe(87.9);
        expect(base).toEqual([{ id: 7, date: '2026-07-20', weight: 90 }]);
        const deletion = mutation(3, 'metric.delete', localTarget(rows.find(row => row.date === date)!));
        expect(projectMetrics(base, [...queue, deletion])).toEqual(base);
    });
    it('upserts an existing weight by date instead of adding a duplicate', () => {
        expect(projectMetrics([{ id: 7, date: date + 'T00:00:00Z', weight: 90 }], [mutation(1, 'metric.add', { date, weight: 88 })])).toEqual([{ id: 7, date, weight: 88 }]);
    });
    it('retains food additions, repeated edits and deletion across restart and partial parent replay', () => {
        const create = mutation(1, 'food.create', { date, meal_period: 'BREAKFAST', name: 'Oats', calories: 200 });
        const first = projectFood([], [create], date)![0];
        const edit = mutation(2, 'food.update', { ...localTarget(first), update: { name: 'Oats and milk', calories: 300 } });
        const edited = projectFood([], [create, edit], date)![0];
        const again = mutation(3, 'food.update', { ...localTarget(edited), update: { calories: 350 } });
        const restarted = JSON.parse(JSON.stringify([again]));
        expect(projectFood([], restarted, date)).toEqual([expect.objectContaining({ name: 'Oats and milk', calories: 350, id: -1 })]);
        const remove = mutation(4, 'food.delete', localTarget(projectFood([], restarted, date)![0]));
        expect(projectFood([], [again, remove], date)).toEqual([]);
        expect(projectFood([], [remove], date)).toEqual([]);
    });
    it('scopes food changes by date and uses stable local identities for equal food names', () => {
        const queue = [1, 2].map(n => mutation(n, 'food.create', { date, meal_period: 'BREAKFAST', name: 'Oats', calories: 200 }));
        expect(projectFood([], queue, date)?.map(row => row.id)).toEqual([-1, -2]);
        expect(projectFood([], queue, '2026-07-22')).toEqual([]);
    });
    it('projects saved-food calories and serving edits from immutable local snapshots', () => {
        const create = mutation(1, 'food.create', { date, meal_period: 'BREAKFAST', my_food_id: 9, servings_consumed: 2, localSnapshot: { name: 'Saved oats', calories: 300, calories_per_serving_snapshot: 150 } });
        const row = projectFood([], [create], date)![0];
        expect(row).toMatchObject({ name: 'Saved oats', calories: 300 });
        expect(projectFood([], [create, mutation(2, 'food.update', { ...localTarget(row), update: { servings_consumed: 3 } })], date)![0].calories).toBe(450);
        expect(foodWirePayload(create.payload as Record<string, unknown>)).not.toHaveProperty('localSnapshot');
    });
    it('restores a failed deletion for correction instead of hiding rejected intent', () => {
        const row = { id: 5, name: 'Existing', meal_period: 'BREAKFAST' as const, calories: 200 };
        expect(projectFood([row], [{ ...mutation(1, 'food.delete', { id: 5 }), state: 'failed' }], date)).toEqual([row]);
    });
});

it('does not invent zero nutrition for legacy saved-food intent without a local snapshot', () => {
    expect(projectFood([], [mutation(1, 'food.create', { date, meal_period: 'BREAKFAST', my_food_id: 9, servings_consumed: 2 })], date)).toEqual([]);
});

it('keeps an entry visible when deletion is trapped behind its failed edit', () => {
    const entry = { id: 5, name: 'Existing', meal_period: 'BREAKFAST' as const, calories: 200 };
    const update = { ...mutation(1, 'food.update', { id: 5, date, update: { calories: 300 } }), state: 'failed' as const };
    const deletion = mutation(2, 'food.delete', { id: 5, date });
    expect(projectFood([entry], [update, deletion], date)).toEqual([expect.objectContaining({ id: 5, calories: 300 })]);
});

it('retains optimistic and existing weight rows when deletion is behind a failed same-day upsert', () => {
    const add = { ...mutation(1, 'metric.add', { date, weight: 88 }), state: 'failed' as const };
    const optimistic = projectMetrics([], [add])![0];
    expect(projectMetrics([], [add, mutation(2, 'metric.delete', { ...localTarget(optimistic), date })])).toEqual([expect.objectContaining({ weight: 88 })]);
    const existing = { id: 42, date, weight: 90 };
    expect(projectMetrics([existing], [add, mutation(2, 'metric.delete', { id: 42, date })])).toEqual([expect.objectContaining({ id: 42, weight: 88 })]);
});
