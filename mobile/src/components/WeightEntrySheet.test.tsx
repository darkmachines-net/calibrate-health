/** @file Regression coverage for Weight Entry Sheet: WeightEntrySheet. */

import type { QueuedMutation } from '../offline/queuedMutation';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MetricSaveResponse, TrendMetricsResponse } from '@calibrate/api-client';
import { WeightEntrySheet } from './WeightEntrySheet';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'weight-operation-id') }));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
    router: { replace: (...args: unknown[]) => mockReplace(...args) }
}));

const mockEnqueue = jest.fn();
const mockMutations: QueuedMutation[] = [];
const mockRetryFailed = jest.fn(async () => undefined);
const mockDiscardFailed = jest.fn(async () => undefined);
jest.mock('../offline/provider', () => ({
    useOfflineOutbox: () => ({ enqueue: mockEnqueue, mutations: mockMutations, retryFailed: mockRetryFailed, discardFailedMutation: mockDiscardFailed })
}));

const mockTriggerWeightHaptic = jest.fn();
jest.mock('../utils/haptics', () => ({
    triggerHapticFeedback: (...args: unknown[]) => mockTriggerWeightHaptic(...args)
}));

jest.mock('../hooks/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true
}));

const mockApi = {
    getMetrics: jest.fn(),
    getTrendMetrics: jest.fn(),
    addMetric: jest.fn(),
    deleteMetric: jest.fn()
};
const mockUser = {
    id: 7,
    timezone: 'UTC',
    weight_unit: 'LB' as const,
    haptics_enabled: true
};
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ api: mockApi, user: mockUser })
}));

jest.mock('./BottomSheetModal', () => ({
    BottomSheetModal: (() => {
        const ReactModule = require('react');
        const { Pressable: NativePressable, Text: NativeText, View: NativeView } = require('react-native');
        return ({
            visible,
            accessibilityLabel,
            children,
            footer,
            onRequestClose
        }: {
            visible: boolean;
            accessibilityLabel?: string;
            children: React.ReactNode;
            footer?: React.ReactNode;
            onRequestClose: () => void;
        }) => visible ? ReactModule.createElement(
            NativeView,
            { accessibilityLabel },
            children,
            footer,
            ReactModule.createElement(
                NativePressable,
                { accessibilityRole: 'button', accessibilityLabel: 'Dismiss test sheet', onPress: onRequestClose },
                ReactModule.createElement(NativeText, null, 'Dismiss test sheet')
            )
        ) : null;
    })()
}));

const TREND_RESPONSE: TrendMetricsResponse = {
    metrics: [
        {
            id: 2,
            user_id: 7,
            date: '2026-08-03',
            weight: 169.5,
            body_fat_percent: null,
            trend_is_materialized: true,
            trend_weight: 169.7,
            trend_ci_lower: 169.3,
            trend_ci_upper: 170.1,
            trend_std: 0.2
        },
        {
            id: 1,
            user_id: 7,
            date: '2026-08-02',
            weight: 170,
            body_fat_percent: null,
            trend_is_materialized: true,
            trend_weight: 170,
            trend_ci_lower: 169.6,
            trend_ci_upper: 170.4,
            trend_std: 0.2
        }
    ],
    meta: { weekly_rate: -0.3, volatility: 'low', total_points: 2, total_span_days: 2 }
};

const GOAL_REACHED_RESPONSE: MetricSaveResponse = {
    id: 2,
    date: '2026-08-03',
    weight: 169.5,
    progress_update: {
        save_kind: 'created',
        local_date: '2026-08-03',
        is_current_day: true,
        current_weight_grams: 76884,
        goal: {
            id: 3,
            mode: 'lose',
            previous_progress_percent: 98,
            current_progress_percent: 100,
            remaining_weight_grams: 0,
            is_complete: true,
            reached_local_date: '2026-08-03'
        },
        recognitions: [{ type: 'goal_reached' }]
    }
};

function renderSheet(props: Partial<React.ComponentProps<typeof WeightEntrySheet>> = {}) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 }
        }
    });
    const onClose = jest.fn();
    const onSaved = jest.fn();
    const screen = render(
        <QueryClientProvider client={queryClient}>
            <WeightEntrySheet
                visible
                date="2026-08-03"
                onClose={onClose}
                onSaved={onSaved}
                {...props}
            />
        </QueryClientProvider>
    );
    return { ...screen, onClose, onSaved, queryClient };
}

describe('WeightEntrySheet', () => {
    beforeAll(() => {
        jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
        jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
        jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => undefined);
    });

    beforeEach(() => {
        mockMutations.length = 0;
        jest.clearAllMocks();
        mockUser.haptics_enabled = true;
        mockApi.getMetrics.mockResolvedValue([{ id: 1, date: '2026-08-02', weight: 170 }]);
        mockApi.getTrendMetrics.mockResolvedValue(TREND_RESPONSE);
        mockApi.addMetric.mockResolvedValue(GOAL_REACHED_RESPONSE);
        mockApi.deleteMetric.mockResolvedValue(undefined);
        mockEnqueue.mockResolvedValue({ id: 'weight-operation-id' });
    });

    it('allows a new weigh-in equal to the previous day but disables an unchanged same-day edit', async () => {
        const newEntry = renderSheet();
        await waitFor(() => expect(newEntry.getByLabelText('Weight in pounds')).toHaveProp('value', '170'));
        expect(AccessibilityInfo.isScreenReaderEnabled).not.toHaveBeenCalled();
        expect(newEntry.getByRole('button', { name: 'Log weight' }).props.accessibilityState.disabled).toBe(false);
        newEntry.unmount();

        mockApi.getMetrics.mockResolvedValue([{ id: 2, date: '2026-08-03', weight: 170 }]);
        const edit = renderSheet();
        await waitFor(() => expect(edit.getByRole('button', { name: 'Save weight' })).toBeTruthy());
        expect(edit.getByRole('button', { name: 'Save weight' }).props.accessibilityState.disabled).toBe(true);
    });

    it('asks for a soft confirmation before saving an unusually large change', async () => {
        const screen = renderSheet();
        await waitFor(() => expect(screen.getByLabelText('Weight in pounds')).toBeTruthy());
        fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '190,0');
        fireEvent.press(screen.getByRole('button', { name: 'Log weight' }));

        expect(screen.getByText('Check this weight')).toBeTruthy();
        expect(screen.getByText('Is 190 lb correct?')).toBeTruthy();
        expect(mockApi.addMetric).not.toHaveBeenCalled();
    });

    it('keeps the sheet open and celebrates a confirmed goal reach', async () => {
        const screen = renderSheet();
        const invalidateQueries = jest.spyOn(screen.queryClient, 'invalidateQueries');
        await waitFor(() => expect(screen.getByLabelText('Weight in pounds')).toBeTruthy());
        fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '169.5');
        fireEvent.press(screen.getByRole('button', { name: 'Log weight' }));

        await waitFor(() => expect(screen.getByText('Goal reached!')).toBeTruthy());
        expect(screen.getByTestId('goal-celebration-static', { includeHiddenElements: true })).toBeTruthy();
        await waitFor(() => expect(screen.getByText('Trend line: down 0.3 lb over 1 day.')).toBeTruthy());
        expect(screen.getByRole('progressbar', { name: 'Goal progress' }).props.accessibilityValue.now).toBe(100);
        expect(screen.onClose).not.toHaveBeenCalled();
        expect(screen.onSaved).toHaveBeenCalledTimes(1);
        expect(mockTriggerWeightHaptic).toHaveBeenCalledWith(true, 'success');
        await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mobile-goal'] }));

        fireEvent.press(screen.getByRole('button', { name: 'Set next goal' }));
        expect(screen.onClose).toHaveBeenCalledTimes(1);
        expect(mockReplace).toHaveBeenCalledWith({
            pathname: '/progress',
            params: { openNextGoal: 'true' }
        });
    });

    it('persists a weigh-in when the network manager is offline instead of pausing the mutation', async () => {
        const screen = renderSheet();
        await waitFor(() => expect(screen.getByLabelText('Weight in pounds')).toBeTruthy());
        act(() => onlineManager.setOnline(false));
        try {
            fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '169.5');
            fireEvent.press(screen.getByRole('button', { name: 'Log weight' }));
            await waitFor(() => expect(screen.getByText('Saved on this device')).toBeTruthy());
            expect(mockEnqueue).toHaveBeenCalled();
            expect(mockApi.addMetric).not.toHaveBeenCalled();
        } finally { act(() => onlineManager.setOnline(true)); }
    });

    it('shows a neutral queued result without authoritative progress or confetti', async () => {
        mockApi.addMetric.mockRejectedValue(new TypeError('Network unavailable'));
        const screen = renderSheet();
        await waitFor(() => expect(screen.getByLabelText('Weight in pounds')).toBeTruthy());
        fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '169.5');
        fireEvent.press(screen.getByRole('button', { name: 'Log weight' }));

        await waitFor(() => expect(screen.getByText('Saved on this device')).toBeTruthy());
        expect(screen.getByText(/milestones will update after this weigh-in syncs/)).toBeTruthy();
        expect(screen.queryByText('Goal reached!')).toBeNull();
        expect(screen.queryByTestId('goal-celebration-static')).toBeNull();
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(mockEnqueue).toHaveBeenCalled();
        expect(screen.onClose).not.toHaveBeenCalled();
    });

    it('passes the disabled account preference through the logging flow', async () => {
        mockUser.haptics_enabled = false;
        const screen = renderSheet();
        await waitFor(() => expect(screen.getByLabelText('Weight in pounds')).toBeTruthy());
        fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '169.5');
        fireEvent.press(screen.getByRole('button', { name: 'Log weight' }));

        await waitFor(() => expect(screen.getByText('Goal reached!')).toBeTruthy());
        expect(mockTriggerWeightHaptic).toHaveBeenCalledWith(false, 'success');
    });

    it('requires confirmation before deleting and does not auto-dismiss afterward', async () => {
        mockApi.getMetrics.mockResolvedValue([{ id: 2, date: '2026-08-03', weight: 170 }]);
        const screen = renderSheet();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete weigh-in' })).toBeTruthy());
        fireEvent.press(screen.getByRole('button', { name: 'Delete weigh-in' }));

        expect(screen.getByText('Delete this weigh-in?')).toBeTruthy();
        expect(mockApi.deleteMetric).not.toHaveBeenCalled();
        fireEvent.press(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(screen.getByText('Weigh-in deleted')).toBeTruthy());
        expect(mockApi.deleteMetric).toHaveBeenCalledWith(2, 'weight-operation-id');
        expect(screen.onClose).not.toHaveBeenCalled();
    });
    it.each(['metric.add', 'metric.delete'])('does not claim save/delete success behind failed %s and exposes explicit recovery', async operation => {
        mockApi.getMetrics.mockResolvedValue([{ id: 2, date: '2026-08-03', weight: 170 }]);
        mockMutations.push({ id: 'failed-weight', operation, payload: { id: 2, date: '2026-08-03', weight: 170 }, namespace: 'https://health.example::user:7', sequence: 1, state: 'failed', attemptCount: 1, lastError: 'Rejected', createdAt: 1, updatedAt: 1 });
        const screen = renderSheet();
        await waitFor(() => expect(screen.getByLabelText('Weight in pounds')).toBeTruthy());
        fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '169.5');
        expect(screen.getByRole('button', { name: 'Save weight' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Delete weigh-in' })).toBeDisabled();
        expect(screen.queryByText('Saved on this device')).toBeNull();
        expect(mockEnqueue).not.toHaveBeenCalled();
        fireEvent.press(screen.getByRole('button', { name: 'Discard related queued changes' }));
        expect(mockDiscardFailed).not.toHaveBeenCalled();
        expect(screen.getByText(/This does not undo anything/)).toBeTruthy();
        fireEvent.press(screen.getByRole('button', { name: 'Confirm discard related changes' }));
        await waitFor(() => expect(mockDiscardFailed).toHaveBeenCalledWith('failed-weight'));
    });

});
