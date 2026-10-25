/** @file Regression coverage for use Food Tracking Pause: keeps queued start/date across a new observer, manual refetch and another remount. */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueuedMutation } from '../offline/queuedMutation';
import { useFoodTrackingPause } from './useFoodTrackingPause';
jest.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
const mockGetPause = jest.fn();
let mockMutations: QueuedMutation[] = [];
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 7 }, serverUrl: 'https://example.test', api: { getFoodTrackingPause: mockGetPause } }) }));
jest.mock('../offline/provider', () => ({ useOfflineOutbox: () => ({ mutations: mockMutations }) }));
const serverPause = { active: true, id: 4, starts_on: '2026-07-20', expected_resume_on: '2026-08-03', resumed_on: null, started_at: null, resumed_at: null, materialized_through: '2026-07-21', resume_confirmation_due: false };
const queued = (operation: string, payload: QueuedMutation['payload']): QueuedMutation => ({ sequence: 1, operation, payload, namespace: 'https://example.test::user:7', id: '1', state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 });
async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const screen = await renderHook(() => useFoodTrackingPause(), { wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    return { ...screen, client };
}

it('keeps queued start/date across a new observer, manual refetch and another remount', async () => {
    mockMutations = [queued('food-tracking-pause.start', { starts_on: '2026-07-21', expected_resume_on: '2026-08-04' })];
    mockGetPause.mockResolvedValue({ pause: { ...serverPause, active: false } });
    for (let mountCount = 0; mountCount < 2; mountCount++) {
        const screen = await mount();
        await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
        await act(async () => { await screen.result.current.refetch(); });
        expect(screen.result.current.data?.pause).toMatchObject({ active: true, starts_on: '2026-07-21', expected_resume_on: '2026-08-04' });
        await screen.unmount(); screen.client.clear();
    }
});

it.each([
    ['food-tracking-pause.update', { expected_resume_on: null }, { active: true, expected_resume_on: null }],
    ['food-tracking-pause.resume', { resumed_on: '2026-07-21' }, { active: false }]
] as const)('keeps %s through server refetch until replay removes the overlay', async (operation, payload, expected) => {
    mockMutations = [queued(operation, payload)];
    mockGetPause.mockResolvedValue({ pause: serverPause });
    const screen = await mount();
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    await act(async () => { await screen.result.current.refetch(); });
    expect(screen.result.current.data?.pause).toMatchObject(expected);
    mockGetPause.mockResolvedValue({ pause: { ...serverPause, ...expected } });
    mockMutations = []; await screen.rerender({});
    await waitFor(() => expect(screen.result.current.data?.pause).toMatchObject(expected));
    await screen.unmount(); screen.client.clear();
});

it.each(['failed', 'discarded'])('restores server metadata when queued intent is %s', async disposition => {
    const mutation = queued('food-tracking-pause.update', { expected_resume_on: '2026-09-01' });
    mockMutations = [mutation]; mockGetPause.mockResolvedValue({ pause: serverPause });
    const screen = await mount();
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    expect(screen.result.current.data?.pause.expected_resume_on).toBe('2026-09-01');
    mockMutations = disposition === 'failed' ? [{ ...mutation, state: 'failed' }] : [];
    await screen.rerender({});
    await waitFor(() => expect(screen.result.current.data?.pause.expected_resume_on).toBe('2026-08-03'));
    await screen.unmount(); screen.client.clear();
});
