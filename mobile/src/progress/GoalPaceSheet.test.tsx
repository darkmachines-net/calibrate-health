/** @file Regression coverage for Goal Pace Sheet: cancel never writes and a failed save retains draft and identical operation for retry. */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, type GoalEntry } from '@calibrate/api-client';
import { GoalPaceSheet } from './GoalPaceSheet';
import { confirmDiscardChanges } from '../components/confirmDiscardChanges';
const goal: GoalEntry = { id: 7, start_weight: 90, target_weight: 75, target_date: null,
    created_at: '2026-01-01T12:00:00Z', daily_deficit: 500, plan_status: 'available' };
const options = { goal, expected_plan_version: 'a'.repeat(64), effective_local_date: '2026-07-21',
    planOptions: [250, 500].map(dailyDeficit => ({ dailyDeficit, available: true, dailyCalorieTarget: 2600 - dailyDeficit })) };
const mockApi = { getGoalPaceOptions: jest.fn(), adjustGoalPace: jest.fn() };
let mockOnline = true;
let mockPending = false;
let mockReconnection = false;
const mockRecheck = jest.fn();
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'stable-operation-001') }));
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({ api: mockApi, pendingReconnection: mockReconnection, recheckClientCompatibility: mockRecheck, user: { weight_unit: 'KG', timezone: 'UTC' } }) }));
jest.mock('../offline/usePendingWeightMutation', () => ({ usePendingWeightMutation: () => mockPending }));
jest.mock('../components/AsyncStateBoundary', () => ({ useOnlineStatus: () => mockOnline }));
jest.mock('../components/confirmDiscardChanges', () => ({ confirmDiscardChanges: jest.fn(async () => true) }));
jest.mock('../components/BottomSheetModal', () => ({ BottomSheetModal: ({ children }: {
        children: React.ReactNode;
    }) => children }));
jest.mock('../components/GoalDailyChangeSelect', () => {
    const { Button, Text, View } = require('react-native');
    return { GoalDailyChangeSelect: ({ value, onChange }: {
            value: string;
            onChange: (value: string) => void;
        }) => <View><Text>{value}</Text><Button title="Choose 250" onPress={() => onChange('250')}/></View> };
});
async function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    const close = jest.fn();
    const startNewGoal = jest.fn();
    const screen = await render(<QueryClientProvider client={client}><GoalPaceSheet goal={goal} onClose={close} onStartNewGoal={startNewGoal}/></QueryClientProvider>);
    return { ...screen, client, close, startNewGoal };
}
beforeEach(() => {
    jest.clearAllMocks();
    mockOnline = true;
    mockPending = false;
    mockReconnection = false;
    mockRecheck.mockResolvedValue(true);
    mockApi.getGoalPaceOptions.mockResolvedValue(options);
    mockApi.adjustGoalPace.mockResolvedValue({ ...goal, daily_deficit: 250 });
});
test('cancel never writes and a failed save retains draft and identical operation for retry', async () => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    await fireEvent.press(screen.getByText('Choose 250'));
    await fireEvent.press(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.close).toHaveBeenCalledTimes(1));
    expect(mockApi.adjustGoalPace).not.toHaveBeenCalled();
    mockApi.adjustGoalPace.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Save pace')).toBeEnabled());
    expect(screen.getByText('250')).toBeTruthy();
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(2));
    expect(mockApi.adjustGoalPace.mock.calls[0]).toEqual(mockApi.adjustGoalPace.mock.calls[1]);
    expect(mockApi.adjustGoalPace.mock.calls[1]).toEqual([7, { daily_deficit: 250, expected_plan_version: 'a'.repeat(64) }, 'stable-operation-001']);
    await screen.unmount();
    screen.client.clear();
});
test('pending duplicate presses submit once and keep dismissal disabled', async () => {
    let resolveSave!: (value: GoalEntry) => void;
    mockApi.adjustGoalPace.mockImplementation(() => new Promise(resolve => { resolveSave = resolve; }));
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    await fireEvent.press(screen.getByText('Choose 250'));
    await fireEvent.press(screen.getByText('Save pace'));
    await fireEvent.press(screen.getByRole('button', { name: /Sav(?:e|ing) pace/ }));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Set a new goal' })).toBeDisabled();
    await act(async () => resolveSave({ ...goal, daily_deficit: 250 }));
    await screen.unmount();
    screen.client.clear();
});
test.each(['offline', 'pending weight', 'cached preview failure'])('%s prevents saving', async (condition) => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    if (condition === 'offline')
        mockOnline = false;
    if (condition === 'pending weight')
        mockPending = true;
    if (condition === 'cached preview failure') {
        mockApi.getGoalPaceOptions.mockRejectedValueOnce(new TypeError('failed check'));
        await act(async () => { await screen.client.refetchQueries({ queryKey: ['goal-pace-options'] }); });
    }
    await screen.rerender(<QueryClientProvider client={screen.client}><GoalPaceSheet goal={goal} onClose={screen.close} onStartNewGoal={screen.startNewGoal}/></QueryClientProvider>);
    expect(screen.getByRole('button', { name: 'Save pace' })).toBeDisabled();
    expect(mockApi.adjustGoalPace).not.toHaveBeenCalled();
    await screen.unmount();
    screen.client.clear();
});
test('stale goal conflict refreshes honestly and cannot silently save a replacement goal', async () => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    mockApi.adjustGoalPace.mockRejectedValueOnce(new ApiError('Your goal changed.', 409, { code: 'GOAL_PLAN_CHANGED' }));
    mockApi.getGoalPaceOptions.mockResolvedValue({ ...options, goal: { ...goal, id: 8 } });
    await fireEvent.press(screen.getByText('Choose 250'));
    await fireEvent.press(screen.getByText('Save pace'));
    await screen.findByText('A new goal is active. Close and reopen to use the current goal.');
    expect(screen.getByRole('button', { name: 'Save pace' })).toBeDisabled();
    expect(mockApi.adjustGoalPace.mock.calls[0][0]).toBe(7);
    await screen.unmount();
    screen.client.clear();
});

test('same-goal conflict presents the new authoritative pace before a second save', async () => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    mockApi.adjustGoalPace.mockRejectedValueOnce(new ApiError('Your plan changed.', 409, { code: 'GOAL_PLAN_CHANGED' }));
    mockApi.getGoalPaceOptions.mockResolvedValue({ ...options, goal: { ...goal, daily_deficit: 750 },
        expected_plan_version: 'b'.repeat(64), planOptions: [...options.planOptions, { dailyDeficit: 750, available: true, dailyCalorieTarget: 1850 }] });
    await fireEvent.press(screen.getByText('Choose 250'));
    await fireEvent.press(screen.getByText('Save pace'));
    await screen.findByText('750');
    expect(screen.queryByText('250')).toBeNull();
    expect(screen.getByText('That information changed. Refresh it and try again.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(2));
    expect(mockApi.adjustGoalPace.mock.calls[1][1]).toEqual({ daily_deficit: 750, expected_plan_version: 'b'.repeat(64) });
    await screen.unmount();
    screen.client.clear();
});

test('starting a new goal confirms a dirty pace draft and never saves that draft', async () => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    await fireEvent.press(screen.getByText('Choose 250'));
    jest.mocked(confirmDiscardChanges).mockResolvedValueOnce(false);
    await fireEvent.press(screen.getByText('Set a new goal'));
    await waitFor(() => expect(confirmDiscardChanges).toHaveBeenCalledTimes(1));
    expect(screen.startNewGoal).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Set a new goal'));
    await waitFor(() => expect(screen.startNewGoal).toHaveBeenCalledTimes(1));
    expect(mockApi.adjustGoalPace).not.toHaveBeenCalled();
    await screen.unmount();
    screen.client.clear();
});

test('manual plan refresh replaces a stale draft before enabling a save with the new version', async () => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    await fireEvent.press(screen.getByText('Choose 250'));
    mockApi.getGoalPaceOptions.mockResolvedValue({ ...options, goal: { ...goal, daily_deficit: 750 },
        expected_plan_version: 'b'.repeat(64), planOptions: [...options.planOptions, { dailyDeficit: 750, available: true, dailyCalorieTarget: 1850 }] });
    await fireEvent.press(screen.getByText('Retry plan check'));
    await screen.findByText('750');
    expect(screen.queryByText('250')).toBeNull();
    expect(mockApi.adjustGoalPace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(1));
    expect(mockApi.adjustGoalPace.mock.calls[0][1]).toEqual({ daily_deficit: 750, expected_plan_version: 'b'.repeat(64) });
    await screen.unmount();
    screen.client.clear();
});

test('manual refresh of an unchanged plan retains the unsaved draft', async () => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    await fireEvent.press(screen.getByText('Choose 250'));
    await fireEvent.press(screen.getByText('Retry plan check'));
    await waitFor(() => expect(mockApi.getGoalPaceOptions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Save pace')).toBeEnabled());
    expect(screen.getByText('250')).toBeTruthy();
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(1));
    expect(mockApi.adjustGoalPace.mock.calls[0][1]).toEqual({ daily_deficit: 250, expected_plan_version: 'a'.repeat(64) });
    await screen.unmount();
    screen.client.clear();
});

 test.each([false, true])('pace retry requires verified reconnection (%s) and preserves the operation', async (verified) => {
    const screen = await setup();
    await waitFor(() => expect(screen.getByText('500')).toBeTruthy());
    await fireEvent.press(screen.getByText('Choose 250'));
    mockApi.adjustGoalPace.mockRejectedValueOnce(new TypeError('Lost response'));
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Save pace')).toBeEnabled());
    mockReconnection = true;
    mockRecheck.mockResolvedValue(verified);
    await screen.rerender(<QueryClientProvider client={screen.client}><GoalPaceSheet goal={goal} onClose={screen.close} onStartNewGoal={screen.startNewGoal}/></QueryClientProvider>);
    await fireEvent.press(screen.getByText('Save pace'));
    await waitFor(() => expect(mockRecheck).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(verified ? 'Retry refresh' : 'Save pace')).toBeTruthy());
    expect(mockApi.adjustGoalPace).toHaveBeenCalledTimes(verified ? 2 : 1);
    if (verified) expect(mockApi.adjustGoalPace.mock.calls[1]).toEqual(mockApi.adjustGoalPace.mock.calls[0]);
    await screen.unmount();
    screen.client.clear();
});
