/** @file Regression coverage for Progress Screen: Progress goal completion flow. */

jest.mock('../offline/provider', () => ({ useOfflineOutbox: () => ({ mutations: [] }) }));
import React from 'react';
import { router } from 'expo-router';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { GoalEntry } from '@calibrate/api-client';
import ProgressScreen from '../../app/(tabs)/(progress)/progress';

const GOAL: GoalEntry = {
    id: 1,
    start_weight: 175,
    target_weight: 170,
    target_date: null,
    daily_deficit: 500,
    created_at: '2026-07-01T00:00:00.000Z',
    plan_status: 'available',
    plan_reason_code: null,
    projection: { status: 'reached', projected_end_date: null, reason_code: null }
};

const mockApi = {
    getGoals: jest.fn(async () => GOAL),
    getUserProfile: jest.fn(async () => ({
        latest_weight_grams: 76657,
        profile: {
            timezone: 'UTC',
            date_of_birth: '1990-01-01',
            sex: 'MALE',
            height_mm: 1800,
            activity_level: 'LIGHT',
            weight_unit: 'LB',
            height_unit: 'FT_IN'
        },
        calorieSummary: {
            missing: [],
            eligibility: { status: 'eligible', reasonCode: null, ageYears: 36, localDate: '2026-07-24' },
            planStatus: 'available',
            planReasonCode: null,
            dailyCalorieTarget: 2200
        }
    })),
    getMetrics: jest.fn(async () => [
        { id: 1, date: '2026-07-20', weight: 171 },
        { id: 2, date: '2026-07-24', weight: 169 }
    ]),
    getTrendMetrics: jest.fn(async () => ({ metrics: [], meta: { total_points: 2 } })),
    getCaloriePlanOptions: jest.fn(async () => ({
        eligibility: { status: 'eligible', reasonCode: null, ageYears: 36, localDate: '2026-07-24' },
        bmr: 1750,
        tdee: 2400,
        minimumDailyCalorieTarget: 1750,
        planOptions: [{
            dailyDeficit: 0,
            available: true,
            dailyCalorieTarget: 2400,
            reasonCode: null
        }]
    })),
    createGoal: jest.fn(async () => GOAL)
};

let mockSearchParams: { openNextGoal?: string } = {};
let mockWeightChangePending = false;
let mockTrendPreviewProps: { onPress: () => void; onLogWeight: () => void } | null = null;
let mockPlanSummaryProps: { onPress: () => void; planAvailable?: boolean } | null = null;
jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-operation-001' }));
jest.mock('expo-router', () => ({
    router: { push: jest.fn() },
    useLocalSearchParams: () => mockSearchParams,
    usePathname: () => '/progress'
}));
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({
        api: mockApi,
        user: { weight_unit: 'LB', timezone: 'UTC' }
    })
}));
jest.mock('../components/progress/WeightTrendPreviewCard', () => ({
    WeightTrendPreviewCard: (props: { onPress: () => void; onLogWeight: () => void }) => {
        mockTrendPreviewProps = props;
        return null;
    }
}));
jest.mock('../components/progress/PlanCheckSummary', () => ({
    PlanCheckSummary: (props: { onPress: () => void; planAvailable?: boolean }) => {
        mockPlanSummaryProps = props;
        return null;
    }
}));
jest.mock('../components/BottomSheetModal', () => {
    const ReactModule = require('react') as typeof React;
    const { Text, View } = require('react-native') as typeof import('react-native');
    return {
        BottomSheetModal: ({ visible, children, title }: { visible: boolean; children: React.ReactNode; title?: string }) =>
            visible
                ? ReactModule.createElement(
                    View,
                    { accessibilityLabel: 'Goal editor' },
                    title ? ReactModule.createElement(Text, null, title) : null,
                    children
                )
                : null
    };
});
jest.mock('../offline/usePendingWeightMutation', () => ({
    usePendingWeightMutation: () => mockWeightChangePending
}));

describe('Progress goal completion flow', () => {
    beforeEach(() => {
        mockSearchParams = {};
        mockWeightChangePending = false;
        mockTrendPreviewProps = null;
        mockPlanSummaryProps = null;
        (router.push as jest.Mock).mockClear();
        onlineManager.setOnline(true);
    });

    afterEach(() => {
        onlineManager.setOnline(true);
    });

    it('routes the preview Log weight action to weight entry', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const screen = render(
            <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
                <QueryClientProvider client={queryClient}><ProgressScreen /></QueryClientProvider>
            </SafeAreaProvider>
        );

        await screen.findByText('Snapshot');
        expect(mockTrendPreviewProps).not.toBeNull();
        act(() => mockTrendPreviewProps?.onPress());
        expect(router.push).not.toHaveBeenCalled();
        act(() => mockTrendPreviewProps?.onLogWeight());
        expect(router.push).toHaveBeenCalledWith('/weight');
        expect(mockPlanSummaryProps).not.toBeNull();
        act(() => mockPlanSummaryProps?.onPress());
        expect(router.push).not.toHaveBeenCalledWith('/plan-check');

        screen.unmount();
        queryClient.clear();
    });

    it('suppresses reached projection and target while a queued weight change is pending', async () => {
        mockWeightChangePending = true;
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const screen = render(
            <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
                <QueryClientProvider client={queryClient}><ProgressScreen /></QueryClientProvider>
            </SafeAreaProvider>
        );

        await screen.findByText('Weight change syncing. Calorie target and projection will return after the server rechecks this plan.');
        expect(screen.getByText('Unavailable')).toBeTruthy();
        expect(screen.queryByText('Current target: 2,200 kcal/day')).toBeNull();
        expect(screen.queryByLabelText('Set next goal')).toBeNull();
        expect(mockPlanSummaryProps).not.toBeNull();
        act(() => mockPlanSummaryProps?.onPress());
        expect(router.push).not.toHaveBeenCalled();
        screen.unmount();
        queryClient.clear();
    });

    it('opens Set next goal at the latest dated weight regardless of metric order', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
        });
        const screen = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 }
                }}
            >
                <QueryClientProvider client={queryClient}>
                    <ProgressScreen />
                </QueryClientProvider>
            </SafeAreaProvider>
        );

        fireEvent.press(await screen.findByLabelText('Set next goal'));

        expect(screen.getByText('Set a new goal')).toBeTruthy();
        expect(screen.getAllByText('169 lb')).toHaveLength(2);
        const targetInput = screen.getByLabelText('Target in pounds');
        expect(targetInput).toHaveProp('value', '169');
        expect(StyleSheet.flatten(targetInput.props.style)).toEqual(expect.objectContaining({
            fontSize: 52,
            textAlign: 'center',
            textAlignVertical: 'center'
        }));
        await waitFor(() => {
            expect(screen.getAllByRole('radio').map((radio) => radio.props.accessibilityState.checked))
                .toEqual([false, true, false]);
        });
        expect(screen.getByLabelText('Goal direction')).toHaveProp('accessibilityRole', 'radiogroup');
        expect(mockApi.createGoal).not.toHaveBeenCalled();
        expect(screen.queryByLabelText('Log weight')).toBeNull();
        screen.unmount();
        queryClient.clear();
    });

    it('accepts the one-shot next-goal handoff from a goal-reached weigh-in', async () => {
        mockSearchParams = { openNextGoal: 'true' };
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
        });
        const screen = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 }
                }}
            >
                <QueryClientProvider client={queryClient}>
                    <ProgressScreen />
                </QueryClientProvider>
            </SafeAreaProvider>
        );

        expect(await screen.findByText('Set a new goal')).toBeTruthy();
        expect(screen.getByLabelText('Target in pounds')).toHaveProp('value', '169');
        expect(mockApi.createGoal).not.toHaveBeenCalled();
        screen.unmount();
        queryClient.clear();
    });

    it('fails Save closed for cached option errors and offline state', async () => {
        mockSearchParams = { openNextGoal: 'true' };
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
        });
        const screen = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 }
                }}
            >
                <QueryClientProvider client={queryClient}>
                    <ProgressScreen />
                </QueryClientProvider>
            </SafeAreaProvider>
        );

        const editor = await screen.findByLabelText('Goal editor');
        const saveButton = within(editor).getByRole('button', { name: 'Save goal' });
        await waitFor(() => expect(saveButton).toBeEnabled());

        mockApi.getCaloriePlanOptions.mockRejectedValueOnce(new TypeError('Network unavailable'));
        await act(async () => {
            await queryClient.refetchQueries({ queryKey: ['calorie-plan-options'] });
        });
        await waitFor(() => {
            expect(within(editor).getByText("Couldn't refresh calorie plan options")).toBeTruthy();
            expect(saveButton).toBeDisabled();
        });

        fireEvent.press(within(editor).getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(saveButton).toBeEnabled());

        act(() => onlineManager.setOnline(false));
        await waitFor(() => {
            expect(within(editor).getByText('Offline - showing saved information')).toBeTruthy();
            expect(saveButton).toBeDisabled();
        });

        screen.unmount();
        queryClient.clear();
    });
});
