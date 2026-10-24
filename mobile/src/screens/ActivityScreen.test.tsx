/** @file Regression coverage for Activity Screen: ActivityScreen async resource states. */

import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ActivityScreen from '../../app/(tabs)/(settings)/activity';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({}) }));

const mockGetActivityDays = jest.fn();
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({
        api: {
            getActivityDays: mockGetActivityDays
        },
        user: { id: 7, weight_unit: 'KG', timezone: 'UTC' }
    })
}));

const mockUseHealthConnectPresentation = jest.fn();
let mockActionLabel = 'Manage Health Connect';
jest.mock('../healthConnect/useHealthConnectPresentation', () => ({
    useHealthConnectPresentation: (options: unknown) => mockUseHealthConnectPresentation(options)
}));
jest.mock('../components/HealthConnectConnectionAction', () => {
    const ReactModule = require('react');
    const { Pressable, Text } = require('react-native');
    return {
        HealthConnectConnectionAction: () => ReactModule.createElement(
            Pressable,
            {
                accessibilityRole: 'button',
                accessibilityLabel: mockActionLabel
            },
            ReactModule.createElement(Text, null, mockActionLabel)
        )
    };
});

const mockNavigation = {
    selectedDate: '2026-08-08',
    selectedDateLabel: 'Aug 8, 2026',
    today: '2026-08-08',
    minDate: '2026-07-01',
    maxDate: '2026-08-08',
    isToday: true,
    canGoBack: true,
    canGoForward: false,
    goToPreviousDate: jest.fn(),
    goToNextDate: jest.fn(),
    goToToday: jest.fn(),
    setDate: jest.fn()
};
jest.mock('../hooks/useLogDateNavigation', () => ({
    useLogDateNavigation: () => mockNavigation
}));

jest.mock('../components/DateNavigationHeader', () => {
    const ReactModule = require('react');
    const { View } = require('react-native');
    return {
        DateNavigationHeader: () => ReactModule.createElement(View, { testID: 'activity-date-navigation' })
    };
});
jest.mock('../components/TabScreen', () => {
    const ReactModule = require('react');
    const { View } = require('react-native');
    return {
        TabScreen: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(
            View,
            { testID: 'activity-scroll-content' },
            children
        )
    };
});

function readyPresentation() {
    return {
        state: 'ready',
        message: 'Health Connect is connected and activity is up to date.',
        tone: 'positive',
        action: 'manage',
        actionLabel: 'Manage Health Connect',
        shouldShowActivity: true,
        missingFeatures: []
    };
}

function renderScreen() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 }
        }
    });
    return render(
        <QueryClientProvider client={queryClient}>
            <ActivityScreen />
        </QueryClientProvider>
    );
}

describe('ActivityScreen async resource states', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        onlineManager.setOnline(true);
        mockUseHealthConnectPresentation.mockReturnValue(readyPresentation());
        mockActionLabel = 'Manage Health Connect';
        mockGetActivityDays.mockImplementation(({ start, end }: { start: string; end: string }) => {
            if (start === end) return Promise.reject(new TypeError('Network unavailable'));
            return Promise.resolve({ days: [] });
        });
    });

    afterEach(() => {
        onlineManager.setOnline(true);
    });

    it('keeps connected empty context concise and moves explanations behind Details', async () => {
        mockUseHealthConnectPresentation.mockReturnValue({
            ...readyPresentation(),
            state: 'empty',
            message: 'Health Connect is connected. No imported activity is available yet.'
        });
        mockGetActivityDays.mockResolvedValue({ days: [] });
        const screen = renderScreen();

        await waitFor(() => expect(screen.getByText('No imported activity for this day')).toBeTruthy());
        expect(screen.getByText('Today')).toBeTruthy();
        expect(screen.getByText('Recent Days')).toBeTruthy();
        expect(screen.getByTestId('activity-details')).toBeTruthy();
        expect(screen.queryByText('Imported weight')).toBeNull();
        expect(screen.queryByText('Exercise details')).toBeNull();

        fireEvent.press(screen.getByLabelText('Show activity details'));

        expect(screen.getByTestId('activity-details-content')).toBeTruthy();
        expect(screen.getByText('Imported weight')).toBeTruthy();
        expect(screen.getByText('No imported weight for this day.')).toBeTruthy();
        expect(screen.getByText(
            'Imported activity never automatically changes your calorie target.'
        )).toBeTruthy();
        expect(screen.getByText(/profile estimate for its calorie target/)).toBeTruthy();
    });

    it('shows one selected-day failure and retries only that resource', async () => {
        const screen = renderScreen();

        await waitFor(() => {
            expect(screen.getAllByText("Can't load selected-day activity")).toHaveLength(1);
        });
        expect(screen.queryByText("Can't load activity summary")).toBeNull();
        expect(screen.queryByText("Can't load activity details")).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);

        fireEvent.press(screen.getByRole('button', { name: 'Retry' }));

        await waitFor(() => {
            const selectedRequests = mockGetActivityDays.mock.calls.filter(
                ([request]) => request.start === request.end
            );
            expect(selectedRequests).toHaveLength(2);
        });
        const historyRequests = mockGetActivityDays.mock.calls.filter(
            ([request]) => request.start !== request.end
        );
        expect(historyRequests).toHaveLength(1);
    });

    it('hides activity history until a connection or imported data exists', async () => {
        mockActionLabel = 'Connect Health Connect';
        mockUseHealthConnectPresentation.mockReturnValue({
            state: 'disconnected',
            message: 'Connect Health Connect to import read-only activity from apps on this phone.',
            tone: 'neutral',
            action: 'connect',
            actionLabel: 'Connect Health Connect',
            shouldShowActivity: false,
            missingFeatures: []
        });
        mockGetActivityDays.mockResolvedValue({ days: [] });

        const screen = renderScreen();

        expect(screen.queryByTestId('activity-details')).toBeNull();
        expect(screen.getByText('No activity imported yet')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Connect Health Connect' })).toHaveLength(1);
        expect(screen.getByTestId('activity-date-navigation')).toBeTruthy();
        expect(within(screen.getByTestId('activity-scroll-content')).queryByTestId(
            'activity-date-navigation'
        )).toBeNull();
        expect(screen.queryByText('Today')).toBeNull();
        expect(screen.queryByText('Recent Days')).toBeNull();
        expect(screen.getByText(
            'Imported activity never automatically changes your calorie target.'
        )).toBeTruthy();
    });
});
