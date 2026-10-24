/** @file Regression coverage for Food Tracking Status: food tracking day resolution. */

import { createOutboxDispatch, type OutboxDispatch } from '../offline/mutationDispatch';
import type { QueuedMutation } from '../offline/queuedMutation';
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Dimensions, StyleSheet } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodLogDay, FoodTrackingPause } from '@calibrate/api-client';
import { DayStatusCard, ResumeTrackingPrompt, foodDayQueryKey } from './FoodTrackingStatus';
import { AppSection } from './AppSection';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'tracking-operation-id') }));

const mockEnqueue = jest.fn();
let mockWithOutbox: OutboxDispatch | undefined;
const mockReadFoodPause = jest.fn((fetch: () => Promise<unknown>) => fetch());
let mockMutations: unknown[] = [];
jest.mock('../offline/provider', () => ({
    useOfflineOutbox: () => ({ enqueue: mockEnqueue, withOutbox: mockWithOutbox, mutations: mockMutations, readFoodPause: mockReadFoodPause })
}));

const mockApi = {
    getFoodDay: jest.fn(),
    getFoodTrackingPause: jest.fn(),
    setFoodDayStatus: jest.fn(),
    startFoodTrackingPause: jest.fn(),
    updateFoodTrackingPause: jest.fn(),
    resumeFoodTracking: jest.fn()
};
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({
        api: mockApi,
        user: { id: 7, timezone: 'UTC' }, serverUrl: 'https://example.test'
    })
}));

jest.mock('./BottomSheetModal', () => {
    const ReactModule = require('react');
    const { Pressable, Text, View } = require('react-native');
    return {
        BottomSheetModal: ({
            visible,
            children,
            accessibilityLabel,
            onRequestClose
        }: {
            visible: boolean;
            children: any;
            accessibilityLabel?: string;
            onRequestClose: () => void;
        }) => visible
            ? ReactModule.createElement(
                View,
                { accessible: true, accessibilityRole: 'dialog', accessibilityLabel },
                children,
                ReactModule.createElement(
                    Pressable,
                    { accessibilityRole: 'button', onPress: onRequestClose },
                    ReactModule.createElement(Text, null, 'Dismiss sheet')
                )
            )
            : null
    };
});

jest.mock('./DatePickerField', () => {
    const ReactModule = require('react');
    const { Pressable, Text } = require('react-native');
    return {
        DatePickerField: ({
            label,
            onChangeDate
        }: {
            label: string;
            onChangeDate: (date: string) => void;
        }) => ReactModule.createElement(
            Pressable,
            { accessibilityRole: 'button', onPress: () => onChangeDate('2099-12-31') },
            ReactModule.createElement(Text, null, label)
        )
    };
});

const resolvedDay = (
    status: FoodLogDay['status'],
    source: FoodLogDay['source'] = 'STORED'
): FoodLogDay => ({
    date: '2026-07-23',
    status,
    origin: status === 'PAUSED' ? 'PAUSE' : 'USER',
    source,
    is_representative: status === 'COMPLETE',
    is_complete: status === 'COMPLETE',
    completed_at: null,
    updated_at: null
});

const duePause: FoodTrackingPause = {
    active: true,
    id: 4,
    starts_on: '2026-07-20',
    expected_resume_on: '2026-07-23',
    resumed_on: null,
    started_at: '2026-07-20T08:00:00.000Z',
    resumed_at: null,
    materialized_through: '2026-07-23',
    resume_confirmation_due: true
};

let foregroundListener: ((state: string) => void) | undefined;
let appStateSpy: jest.SpyInstance;

function renderWithQuery(ui: React.ReactElement, cachedDay?: FoodLogDay) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 }
        }
    });
    if (cachedDay) queryClient.setQueryData(foodDayQueryKey(cachedDay.date), cachedDay);
    return render(
        <QueryClientProvider client={queryClient}>
            {ui}
        </QueryClientProvider>
    );
}

describe('food tracking day resolution', () => {
    const originalWindow = Dimensions.get('window');
    beforeEach(() => {
        act(() => Dimensions.set({ window: { ...originalWindow, width: 320, fontScale: 1 } }));
        jest.clearAllMocks();
        mockMutations = [];
        mockWithOutbox = undefined;
        foregroundListener = undefined;
        appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
            foregroundListener = listener as (state: string) => void;
            return { remove: jest.fn() };
        });
    });

    afterEach(() => {
        appStateSpy.mockRestore();
        act(() => Dimensions.set({ window: originalWindow }));
    });

    it('queues day completion behind existing food intent even with healthy authentication', async () => {
        mockMutations = [{ id: 'pending-food', operation: 'food.create' }];
        mockApi.getFoodDay.mockResolvedValue(resolvedDay('OPEN'));
        const screen = renderWithQuery(<DayStatusCard date="2026-07-23" isToday />);
        await waitFor(() => expect(screen.getByText('Complete day')).toBeTruthy());
        fireEvent.press(screen.getByText('Complete day'));
        await waitFor(() => expect(mockEnqueue).toHaveBeenCalledWith('food-day.set-status', { date: '2026-07-23', status: 'COMPLETE' }, 'tracking-operation-id'));
        expect(mockApi.setFoodDayStatus).not.toHaveBeenCalled();
    });

    it.each([true, false])('distinguishes stale completed-day reopen from explicit paused historical backfill: stale=%s', async stale => {
        const date = '2026-07-23';
        const rows = [{ id: 'pause', namespace: 'test', sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1, operation: 'food-tracking-pause.start', payload: { starts_on: date } } as QueuedMutation];
        mockWithOutbox = createOutboxDispatch('day-override-' + stale, async () => rows, mockEnqueue, () => true);
        mockApi.getFoodDay.mockResolvedValue(resolvedDay(stale ? 'COMPLETE' : 'PAUSED'));
        const screen = renderWithQuery(<DayStatusCard date={date} isToday={stale} />);
        const button = await screen.findByRole('button', { name: stale ? 'Edit or backfill' : 'Backfill this day' });
        fireEvent.press(button);
        if (stale) { await screen.findByRole('alert'); expect(mockEnqueue).not.toHaveBeenCalled(); }
        else await waitFor(() => expect(mockEnqueue).toHaveBeenCalledWith('food-day.set-status', { date, status: 'OPEN', explicitPausedBackfill: true }, 'tracking-operation-id'));
        expect(mockApi.setFoodDayStatus).not.toHaveBeenCalled();
    });

    it('stacks completion and pause targets when native text is enlarged', async () => {
        act(() => Dimensions.set({ window: { ...originalWindow, width: 320, fontScale: 2 } }));
        mockApi.getFoodDay.mockResolvedValue(resolvedDay('OPEN'));
        const screen = renderWithQuery(<DayStatusCard date="2026-07-23" isToday compact />);
        await waitFor(() => expect(screen.getByText('Not fully logged')).toBeTruthy());
        for (const name of ['Complete day', 'Pause tracking']) {
            expect(screen.getByRole('button', { name })).toHaveStyle({ width: '100%', minHeight: 48 });
        }
    });

    it('offers completion, incomplete, and pause actions for an open current day', async () => {
        mockApi.getFoodDay.mockResolvedValue(resolvedDay('OPEN'));
        const screen = renderWithQuery(<DayStatusCard date="2026-07-23" isToday compact />);

        await waitFor(() => expect(screen.getByText('Not fully logged')).toBeTruthy());
        expect(screen.getByText('Complete day')).toBeTruthy();
        expect(screen.getByText('Pause tracking')).toBeTruthy();
        expect(screen.queryByText('Mark incomplete')).toBeNull();
        expect(screen.getByRole('button', { name: 'Complete day' })).toHaveStyle({
            elevation: 0,
            shadowOpacity: 0,
            width: 0
        });
        expect(screen.getByRole('button', { name: 'Pause tracking' })).toHaveStyle({
            width: 0
        });
        fireEvent.press(screen.getByLabelText('Pause tracking'));

        expect(screen.getByText('Pause calorie tracking?')).toBeTruthy();
        expect(screen.getByText(/Calorie tracking and all reminders will stop/)).toBeTruthy();
        expect(screen.getByText('Until I resume')).toBeTruthy();
        expect(screen.getByText('Choose expected resume date')).toBeTruthy();
        fireEvent.press(screen.getByText('Choose expected resume date'));
        expect(screen.queryByText('Choose expected resume date')).toBeNull();
        expect(screen.getByText('Pause with this date')).toBeTruthy();
    });

    it('removes the rectangular Android elevation from the past-day completion action', async () => {
        mockApi.getFoodDay.mockResolvedValue(resolvedDay('OPEN'));
        const screen = renderWithQuery(<DayStatusCard date="2026-07-23" isToday={false} />);

        await waitFor(() => expect(screen.getByText('Not fully logged')).toBeTruthy());
        expect(screen.getByRole('button', { name: 'Complete day' })).toHaveStyle({
            elevation: 0,
            shadowOpacity: 0
        });
    });

    it('presents inferred blank, incomplete, complete, and paused days without food prompts', async () => {
        const cases: Array<[FoodLogDay, string]> = [
            [resolvedDay('INCOMPLETE', 'INFERRED_EMPTY'), 'Not fully logged'],
            [resolvedDay('INCOMPLETE'), 'Not fully logged'],
            [resolvedDay('COMPLETE'), 'Fully logged'],
            [resolvedDay('PAUSED'), 'Paused']
        ];

        for (const [day, title] of cases) {
            mockApi.getFoodDay.mockResolvedValueOnce(day);
            const screen = renderWithQuery(<DayStatusCard date="2026-07-23" isToday />);
            await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
            expect(screen.queryByText('Complete day')).toBeNull();
            expect(screen.queryByText('Mark incomplete')).toBeNull();
            screen.unmount();
        }
    });

    it('does not present failed cached day data as fully logged', async () => {
        mockApi.getFoodDay.mockRejectedValue(new Error('Status unavailable'));
        const screen = renderWithQuery(
            <DayStatusCard date="2026-07-23" isToday />,
            resolvedDay('COMPLETE')
        );

        await waitFor(() => expect(screen.getByText('Not fully logged')).toBeTruthy());
        expect(screen.queryByText('Fully logged')).toBeNull();
        expect(screen.getByText(
            'Day status could not be refreshed, so this day is not treated as fully logged.'
        )).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Backfill this day' })).toBeTruthy();
    });

    it('does not present cached completion when another required Today resource failed', async () => {
        mockApi.getFoodDay.mockResolvedValue(resolvedDay('COMPLETE'));
        const screen = renderWithQuery(
            <DayStatusCard date="2026-07-23" isToday failed />
        );

        await waitFor(() => expect(screen.getByText('Not fully logged')).toBeTruthy());
        expect(screen.queryByText('Fully logged')).toBeNull();
        expect(screen.getByText(
            'Today data could not be refreshed, so this day is not treated as fully logged.'
        )).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit or backfill' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Backfill this day' })).toBeTruthy();
    });

    it('fills only the remaining Today space with a centered status hero', async () => {
        mockApi.getFoodDay.mockResolvedValue(resolvedDay('PAUSED'));
        const screen = renderWithQuery(
            <DayStatusCard
                date="2026-07-23"
                isToday
                compact
                expanded
            />
        );

        await waitFor(() => expect(screen.getByText('Paused')).toBeTruthy());
        expect(screen.getByText("Today's status")).toBeTruthy();
        expect(StyleSheet.flatten(screen.UNSAFE_getByType(AppSection).props.style)).toEqual(
            expect.objectContaining({
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center'
            })
        );
        expect(screen.getByRole('button', { name: 'Resume tracking' })).toHaveStyle({
            width: '100%',
            maxWidth: 320
        });
    });

    it('asks for confirmation when an expected resume date is due and exposes every extension path', async () => {
        mockApi.getFoodTrackingPause.mockResolvedValue({ pause: duePause });
        const screen = renderWithQuery(<ResumeTrackingPrompt />);

        await waitFor(() => expect(screen.getByText('Ready to resume tracking?')).toBeTruthy());
        expect(screen.getByRole('dialog', { name: 'Ready to resume tracking?' })).toBeTruthy();
        expect(screen.getByText('Resume tracking')).toBeTruthy();
        fireEvent.press(screen.getByText('Extend pause'));

        expect(screen.getByText('Tomorrow')).toBeTruthy();
        expect(screen.getByText('Choose another date')).toBeTruthy();
        expect(screen.getByText('Until I resume')).toBeTruthy();
    });

    it('keeps the pause active when the confirmation is dismissed and offers it again next foreground', async () => {
        mockApi.getFoodTrackingPause.mockResolvedValue({ pause: duePause });
        const screen = renderWithQuery(<ResumeTrackingPrompt />);

        await waitFor(() => expect(screen.getByText('Ready to resume tracking?')).toBeTruthy());
        fireEvent.press(screen.getByText('Dismiss sheet'));
        await waitFor(() => expect(screen.queryByText('Ready to resume tracking?')).toBeNull());
        expect(mockApi.resumeFoodTracking).not.toHaveBeenCalled();
        expect(mockApi.updateFoodTrackingPause).not.toHaveBeenCalled();

        await act(async () => {
            foregroundListener?.('active');
        });
        await waitFor(() => expect(screen.getByText('Ready to resume tracking?')).toBeTruthy());
    });

    it('updates the expected date for tomorrow, a chosen date, or until manual resume', async () => {
        mockApi.getFoodTrackingPause.mockResolvedValue({ pause: duePause });
        mockApi.updateFoodTrackingPause.mockImplementation(async ({ expected_resume_on }) => ({
            pause: { ...duePause, expected_resume_on, resume_confirmation_due: false }
        }));

        const tomorrowScreen = renderWithQuery(<ResumeTrackingPrompt />);
        await waitFor(() => expect(tomorrowScreen.getByText('Extend pause')).toBeTruthy());
        fireEvent.press(tomorrowScreen.getByText('Extend pause'));
        fireEvent.press(tomorrowScreen.getByText('Tomorrow'));
        await waitFor(() => expect(mockApi.updateFoodTrackingPause).toHaveBeenCalledWith(
            { expected_resume_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
            'tracking-operation-id'
        ));
        tomorrowScreen.unmount();

        mockApi.updateFoodTrackingPause.mockClear();
        const chosenScreen = renderWithQuery(<ResumeTrackingPrompt />);
        await waitFor(() => expect(chosenScreen.getByText('Extend pause')).toBeTruthy());
        fireEvent.press(chosenScreen.getByText('Extend pause'));
        fireEvent.press(chosenScreen.getByText('Choose another date'));
        fireEvent.press(chosenScreen.getByText('Use chosen date'));
        await waitFor(() => expect(mockApi.updateFoodTrackingPause).toHaveBeenCalledWith(
            { expected_resume_on: '2099-12-31' },
            'tracking-operation-id'
        ));
        chosenScreen.unmount();

        mockApi.updateFoodTrackingPause.mockClear();
        const manualScreen = renderWithQuery(<ResumeTrackingPrompt />);
        await waitFor(() => expect(manualScreen.getByText('Extend pause')).toBeTruthy());
        fireEvent.press(manualScreen.getByText('Extend pause'));
        fireEvent.press(manualScreen.getByText('Until I resume'));
        await waitFor(() => expect(mockApi.updateFoodTrackingPause).toHaveBeenCalledWith(
            { expected_resume_on: null },
            'tracking-operation-id'
        ));
    });

    it('confirms resume explicitly and reopens the local resume day', async () => {
        mockApi.getFoodTrackingPause.mockResolvedValue({ pause: duePause });
        mockApi.resumeFoodTracking.mockResolvedValue({
            pause: { ...duePause, active: false, resumed_on: '2026-07-23', resume_confirmation_due: false },
            day: resolvedDay('OPEN')
        });
        const screen = renderWithQuery(<ResumeTrackingPrompt />);

        await waitFor(() => expect(screen.getByText('Resume tracking')).toBeTruthy());
        fireEvent.press(screen.getByText('Resume tracking'));
        await waitFor(() => expect(mockApi.resumeFoodTracking).toHaveBeenCalledWith(
            { resumed_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
            'tracking-operation-id'
        ));
    });
it('routes ordinary pause queries and refetch through the receipt-aware reader', async () => {
    mockApi.getFoodTrackingPause.mockResolvedValue({ pause: { active: false } });
    const before = mockReadFoodPause.mock.calls.length;
    const screen = renderWithQuery(<ResumeTrackingPrompt />);
    await waitFor(() => expect(mockReadFoodPause.mock.calls.length).toBeGreaterThan(before));
    await act(async () => { foregroundListener?.('active'); });
    await waitFor(() => expect(mockReadFoodPause.mock.calls.length).toBeGreaterThan(before + 1));
    screen.unmount();
});

    it('keeps a persisted queued resume hidden after remount and foreground refetch', async () => {
        mockMutations = [{ id: 'saved-resume', namespace: 'https://example.test::user:7', sequence: 1, operation: 'food-tracking-pause.resume', payload: { resumed_on: '2026-07-23' }, state: 'pending' }];
        mockApi.getFoodTrackingPause.mockResolvedValue({ pause: duePause });
        for (let restart = 0; restart < 2; restart++) {
            const screen = renderWithQuery(<ResumeTrackingPrompt />);
            await waitFor(() => expect(mockReadFoodPause).toHaveBeenCalled());
            await act(async () => { foregroundListener?.('active'); });
            expect(screen.queryByText('Resume tracking')).toBeNull();
            expect(mockApi.resumeFoodTracking).not.toHaveBeenCalled();
            expect(mockEnqueue).not.toHaveBeenCalled();
            screen.unmount();
        }
    });

});
