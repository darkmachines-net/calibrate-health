/** @file Regression coverage for use Tracking Queries: rehydrates intent without polluting server snapshots and filters another account or server synchronously. */

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTrackingFood } from './useTrackingQueries';
import type { QueuedMutation } from './queuedMutation';

const mockGetFoodLog = jest.fn();
let mockAuth = { serverUrl: 'https://one.invalid', user: { id: 1 }, api: { getFoodLog: mockGetFoodLog } };
let mockMutations: QueuedMutation[] = [];
jest.mock('../auth/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('./provider', () => ({ useOfflineOutbox: () => ({ mutations: mockMutations }) }));
const date = '2026-07-21';
const queued = { sequence: 1, id: 'create-one', namespace: 'https://one.invalid::user:1', operation: 'food.create', payload: { date, meal_period: 'BREAKFAST', name: 'Local oats', calories: 200 }, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 } as QueuedMutation;

it('rehydrates intent without polluting server snapshots and filters another account or server synchronously', async () => {
    mockMutations = JSON.parse(JSON.stringify([queued]));
    mockGetFoodLog.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['mobile-food', date], []);
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = await renderHook(() => useTrackingFood(date), { wrapper });
    expect(view.result.current.data).toEqual([expect.objectContaining({ name: 'Local oats', calories: 200 })]);
    expect(client.getQueryData(['mobile-food', date])).toEqual([]);
    expect(mockGetFoodLog).not.toHaveBeenCalled();
    mockAuth = { ...mockAuth, user: { id: 2 } }; await view.rerender({});
    expect(view.result.current.data).toEqual([]);
    mockAuth = { ...mockAuth, user: { id: 1 }, serverUrl: 'https://two.invalid' }; await view.rerender({});
    expect(view.result.current.data).toEqual([]);
    await waitFor(() => expect(mockGetFoodLog).toHaveBeenCalled());
    await view.unmount(); client.clear();
});

it('fetches unrelated dates and refreshes through a failed food edit without erasing queued intent', async () => {
    mockAuth = { ...mockAuth, serverUrl: 'https://one.invalid', user: { id: 1 } };
    mockGetFoodLog.mockReset().mockResolvedValue([{ id: 7, name: 'Server oats', calories: 100, meal_period: 'BREAKFAST' }]);
    mockMutations = [{ ...queued, payload: { ...queued.payload as object, date: '2026-07-22' } }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = await renderHook(() => useTrackingFood(date), { wrapper });
    await waitFor(() => expect(view.result.current.data?.[0].name).toBe('Server oats'));
    mockMutations = [{ ...queued, operation: 'food.update', payload: { date, id: 7, update: { calories: 200 } }, state: 'failed' }];
    await view.rerender({});
    await view.result.current.refetch();
    await waitFor(() => expect(mockGetFoodLog).toHaveBeenCalledTimes(2));
    expect(view.result.current.data?.[0].calories).toBe(200);
    expect(client.getQueryData(['mobile-food', date])).toEqual([expect.objectContaining({ calories: 100 })]);
    await view.unmount(); client.clear();
});
