/** @file Regression coverage for Historical Date Picker: HistoricalDatePicker. */

jest.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
jest.mock('../offline/provider', () => ({ useOfflineOutbox: () => mockOutbox }));
import type { QueuedMutation } from '../offline/queuedMutation';
import { createOutboxNamespace } from '../offline/queuedMutation';
const mockOutbox = { mutations: [] as QueuedMutation[], dayIntents: [] as QueuedMutation[], readFoodDays: jest.fn((fetch: () => Promise<unknown>) => fetch()) };
import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodLogDay, FoodLogDaySource, FoodLogDayStatus } from '@calibrate/api-client';
import { themes } from '../theme';
import { foodDayRangeQueryKey } from './calendar';
import { HistoricalDatePicker } from './HistoricalDatePicker';

const mockGetFoodDays = jest.fn();
const mockGetPause = jest.fn().mockResolvedValue({ pause: { active: false } });

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ user: { id: 1 }, serverUrl: 'https://example.test', api: { getFoodDays: mockGetFoodDays, getFoodTrackingPause: mockGetPause } })
}));
jest.mock('../components/BottomSheetModal', () => {
    const ReactModule = require('react') as typeof import('react');
    const { View } = require('react-native') as typeof import('react-native');
    return {
        BottomSheetModal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
            visible ? ReactModule.createElement(View, null, children) : null
    };
});

function day(
    date: string,
    status: FoodLogDayStatus,
    source: FoodLogDaySource
): FoodLogDay {
    return {
        date,
        status,
        source,
        origin: source === 'STORED' ? 'USER' : source === 'ACTIVE_PAUSE' ? 'PAUSE' : null,
        is_representative: status === 'COMPLETE',
        is_complete: status === 'COMPLETE',
        completed_at: null,
        updated_at: null
    };
}

const RANGE_RESPONSE = {
    start_date: '2026-07-11',
    end_date: '2026-07-18',
    days: [
        day('2026-07-11', 'COMPLETE', 'STORED'),
        day('2026-07-12', 'INCOMPLETE', 'STORED'),
        day('2026-07-13', 'INCOMPLETE', 'INFERRED_EMPTY'),
        day('2026-07-14', 'PAUSED', 'ACTIVE_PAUSE'),
        day('2026-07-18', 'OPEN', 'DEFAULT')
    ]
};

function renderPicker(queryClient: QueryClient) {
    return render(
        <QueryClientProvider client={queryClient}>
            <HistoricalDatePicker
                visible
                selectedDate="2026-07-12"
                minDate="2026-07-11"
                maxDate="2026-07-18"
                onSelectDate={jest.fn()}
                onRequestClose={jest.fn()}
            />
        </QueryClientProvider>
    );
}

describe('HistoricalDatePicker', () => {
    beforeEach(() => {
        onlineManager.setOnline(true);
        mockGetFoodDays.mockReset();
        mockGetPause.mockResolvedValue({ pause: { active: false } });
        mockGetFoodDays.mockResolvedValue(RANGE_RESPONSE);
    });

    afterEach(() => {
        onlineManager.setOnline(true);
    });

    it('loads the visible range, exposes status labels, and selects a day', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { gcTime: Infinity, retry: false } }
        });
        const onSelectDate = jest.fn();
        const onRequestClose = jest.fn();
        const screen = render(
            <QueryClientProvider client={queryClient}>
                <HistoricalDatePicker
                    visible
                    selectedDate="2026-07-12"
                    minDate="2026-07-11"
                    maxDate="2026-07-18"
                    onSelectDate={onSelectDate}
                    onRequestClose={onRequestClose}
                />
            </QueryClientProvider>
        );

        await waitFor(() => expect(mockGetFoodDays).toHaveBeenCalledWith('2026-07-11', '2026-07-18'));
        const completeDay = await screen.findByLabelText(/Jul 11, 2026, completed/i);
        expect(completeDay).toBeTruthy();
        expect(screen.getByLabelText(/Jul 12, 2026, incomplete/i)).toBeTruthy();
        expect(screen.getByLabelText(/Jul 13, 2026, not started/i)).toBeTruthy();
        expect(screen.getByLabelText(/Jul 14, 2026, tracking paused/i)).toBeTruthy();
        expect(screen.getByLabelText(/Jul 18, 2026, today, in progress/i)).toBeTruthy();

        expect(StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-11').props.style)).toEqual(
            expect.objectContaining({
                minWidth: 34,
                minHeight: 34,
                borderRadius: 17,
                backgroundColor: themes.light.colors.success
            })
        );
        expect(StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-12').props.style)).toEqual(
            expect.objectContaining({
                minWidth: 34,
                minHeight: 34,
                borderWidth: 2,
                borderColor: themes.light.colors.success
            })
        );
        expect(StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-13').props.style)).toEqual(
            expect.objectContaining({
                backgroundColor: themes.light.colors.surfaceContainer
            })
        );
        expect(StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-14').props.style)).toEqual(
            expect.objectContaining({
                borderColor: themes.light.colors.outline,
                backgroundColor: themes.light.colors.surfaceContainerHigh
            })
        );

        fireEvent.press(completeDay);
        expect(onSelectDate).toHaveBeenCalledWith('2026-07-11');
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText('Previous month').props.accessibilityState.disabled).toBe(true);
        expect(screen.getByLabelText('Next month').props.accessibilityState.disabled).toBe(true);
        screen.unmount();
        queryClient.clear();
    });
    it('never exposes unresolved days as selectable status after an uncached failure and announces Retry', async () => {
        let resolveRetry!: (value: typeof RANGE_RESPONSE) => void;
        const retryResult = new Promise<typeof RANGE_RESPONSE>((resolve) => { resolveRetry = resolve; });
        mockGetFoodDays
            .mockRejectedValueOnce(new Error('provider details that must stay private'))
            .mockImplementationOnce(() => retryResult);
        const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
        const screen = renderPicker(queryClient);

        expect(await screen.findByText("Can't load tracking history")).toBeTruthy();
        expect(screen.queryByLabelText(/in progress/i)).toBeNull();
        expect(screen.queryByText(/provider details that must stay private/i)).toBeNull();

        fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByText('Loading history...')).toBeTruthy();
        expect(screen.getByText('Retrying tracking history').props.accessibilityLiveRegion).toBe('polite');

        resolveRetry(RANGE_RESPONSE);
        expect(await screen.findByLabelText(/Jul 11, 2026, completed/i)).toBeTruthy();
        screen.unmount();
        queryClient.clear();
    });

    it('keeps cached calendar days selectable and labels refresh failure as degraded', async () => {
        mockGetFoodDays.mockRejectedValue(new Error('private SQL exception'));
        const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
        queryClient.setQueryData(
            foodDayRangeQueryKey('2026-07-11', '2026-07-18'),
            RANGE_RESPONSE
        );
        const screen = renderPicker(queryClient);

        expect(await screen.findByText("Couldn't refresh tracking history")).toBeTruthy();
        expect(screen.getByLabelText(/Jul 11, 2026, completed/i)).toBeTruthy();
        expect(screen.queryByText(/private SQL exception/i)).toBeNull();
        screen.unmount();
        queryClient.clear();
    });

    it('labels cached calendar days stale while native or web connectivity is offline', async () => {
        onlineManager.setOnline(false);
        const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
        queryClient.setQueryData(
            foodDayRangeQueryKey('2026-07-11', '2026-07-18'),
            RANGE_RESPONSE
        );
        const screen = renderPicker(queryClient);

        expect(await screen.findByText('Offline - showing saved information')).toBeTruthy();
        expect(screen.getByLabelText(/Jul 11, 2026, completed/i)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        screen.unmount();
        queryClient.clear();
    });
});

it('browses the target month without requesting future history or enabling future selection, and clamps a shortened plan', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const pause = { active: true, starts_on: '2026-07-17', expected_resume_on: '2027-01-02', resumed_on: null };
    mockGetPause.mockResolvedValue({ pause });
    mockGetFoodDays.mockClear();
    mockGetFoodDays.mockResolvedValue(RANGE_RESPONSE);
    const screen = renderPicker(queryClient);
    await waitFor(() => expect(screen.getByLabelText('Next month')).not.toBeDisabled());
    expect(screen.getByTestId('calendar-day-2026-07-19').props.accessibilityLabel).toMatch(/planned tracking pause/);
    expect(screen.getByTestId('calendar-day-2026-07-19')).toBeDisabled();
    for (let month = 0; month < 6; month++) fireEvent.press(screen.getByLabelText('Next month'));
    expect(screen.getByTestId('calendar-day-2027-01-01').props.accessibilityLabel).toMatch(/planned tracking pause/);
    expect(screen.getByTestId('calendar-day-2027-01-02').props.accessibilityLabel).toMatch(/future date/);
    expect(screen.getByLabelText('Next month')).toBeDisabled();
    expect(mockGetFoodDays).toHaveBeenCalledTimes(1);
    mockGetPause.mockResolvedValue({ pause: { ...pause, expected_resume_on: null } });
    await act(async () => {
        await queryClient.cancelQueries({ queryKey: ['mobile-food-tracking-pause'] });
        queryClient.setQueryData(['mobile-food-tracking-pause'], { pause: { ...pause, expected_resume_on: null } });
    });
    await waitFor(() => expect(screen.getByTestId('calendar-day-2026-07-31').props.accessibilityLabel).toMatch(/planned tracking pause, until resumed/));
    expect(screen.getByLabelText('Next month')).toBeDisabled();
    mockGetPause.mockResolvedValue({ pause: { ...pause, active: false } });
    await act(async () => { queryClient.setQueryData(['mobile-food-tracking-pause'], { pause: { ...pause, active: false } }); });
    await waitFor(() => expect(screen.getByTestId('calendar-day-2026-07-19').props.accessibilityLabel).not.toMatch(/planned/));
    screen.unmount(); queryClient.clear();
});

it('keeps factual date labels while revealing the short calendar key and color guide on demand', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const comparisons = [
        { consumed_kcal: 2000, target_kcal: 2000, maintenance_kcal: 2500 },
        { consumed_kcal: 2500, target_kcal: 2000, maintenance_kcal: 2500 },
        { consumed_kcal: 2501, target_kcal: 2000, maintenance_kcal: 2500 },
        { consumed_kcal: 2499, target_kcal: 3000, maintenance_kcal: 2500 }
    ];
    mockGetFoodDays.mockResolvedValue({ ...RANGE_RESPONSE, days: comparisons.map((value, index) => ({
        ...day('2026-07-' + (11 + index), 'COMPLETE', 'STORED'),
        calorie_comparison: { ...value, captured_at: '2026-07-11T18:00:00Z' }
    })) });
    const screen = renderPicker(queryClient);
    expect(await screen.findByLabelText(/Jul 11, 2026, completed, at or below target/)).toBeTruthy();
    expect(screen.getByLabelText(/Jul 12, 2026, completed, above target, at or below maintenance/)).toBeTruthy();
    expect(screen.getByLabelText(/Jul 13, 2026, completed, above maintenance/)).toBeTruthy();
    expect(screen.getByLabelText(/Jul 14, 2026, completed, below maintenance/)).toBeTruthy();
    expect(screen.queryByTestId('calendar-key-content')).toBeNull();
    expect(screen.queryByText('Completing your log is worth recognizing.')).toBeNull();
    const keyToggle = screen.getByRole('button', { name: 'Calendar key' });
    expect(keyToggle.props.accessibilityState.expanded).toBe(false);
    fireEvent.press(keyToggle);
    expect(screen.getByRole('button', { name: 'Calendar key' }).props.accessibilityState.expanded).toBe(true);
    expect(screen.queryByText(/comparison unavailable/i)).toBeNull();
    for (const number of [11, 12, 13, 14]) {
        const badge = within(screen.getByTestId('calendar-date-badge-2026-07-' + number));
        expect(badge.getByText(String(number))).toBeTruthy();
        expect(badge.queryByText(/^[TMB?]$/, { includeHiddenElements: true })).toBeNull();
    }
    for (const label of ['Met target', 'Near target', 'Off target']) {
        expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByTestId('calendar-color-guide')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'How colors work' }));
    expect(screen.getByTestId('calendar-color-guide')).toBeTruthy();
    expect(screen.getByText('Between the saved target and maintenance.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Calendar key' }));
    expect(screen.queryByTestId('calendar-key-content')).toBeNull();
    expect(screen.queryByTestId('calendar-color-guide')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-12').props.style).backgroundColor).toBe(themes.light.colors.calendarBetween);
    expect(StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-13').props.style).backgroundColor).toBe(themes.light.colors.calendarBeyond);
    screen.unmount(); queryClient.clear();
});

it('starts with the key collapsed each time the picker opens', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const renderContents = (visible: boolean) => (
        <QueryClientProvider client={queryClient}>
            <HistoricalDatePicker
                visible={visible}
                selectedDate="2026-07-12"
                minDate="2026-07-11"
                maxDate="2026-07-18"
                onSelectDate={jest.fn()}
                onRequestClose={jest.fn()}
            />
        </QueryClientProvider>
    );
    const screen = render(renderContents(true));
    fireEvent.press(await screen.findByRole('button', { name: 'Calendar key' }));
    expect(screen.getByTestId('calendar-key-content')).toBeTruthy();
    screen.rerender(renderContents(false));
    screen.rerender(renderContents(true));
    expect(screen.getByRole('button', { name: 'Calendar key' }).props.accessibilityState.expanded).toBe(false);
    expect(screen.queryByTestId('calendar-key-content')).toBeNull();
    screen.unmount(); queryClient.clear();
});

it('uses comparison-colored outlines and neutral tracking shapes, with an x inside not-started badges', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const days = [2000, 2300, 2600].map((consumed, index) => ({
        ...day(`2026-07-${11 + index}`, 'INCOMPLETE', 'STORED'),
        calorie_comparison: { consumed_kcal: consumed, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-11T18:00:00Z' }
    }));
    mockGetFoodDays.mockResolvedValue({ ...RANGE_RESPONSE, days: [...days, day('2026-07-14', 'INCOMPLETE', 'INFERRED_EMPTY')] });
    const screen = renderPicker(client);
    await screen.findByLabelText(/Jul 12, 2026, incomplete, above target, at or below maintenance/);
    for (const [index, color] of [themes.light.colors.success, themes.light.colors.calendarBetween, themes.light.colors.calendarBeyond].entries()) {
        expect(StyleSheet.flatten(screen.getByTestId(`calendar-date-badge-2026-07-${11 + index}`).props.style))
            .toEqual(expect.objectContaining({ borderWidth: 2, borderColor: color }));
    }
    const notStarted = StyleSheet.flatten(screen.getByTestId('calendar-date-badge-2026-07-14').props.style);
    expect(notStarted.backgroundColor).toBe(themes.light.colors.surfaceContainer);
    expect(notStarted.borderWidth).toBeUndefined();
    expect(screen.getByTestId('calendar-not-started-glyph-2026-07-14', { includeHiddenElements: true })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Calendar key' }));
    expect(StyleSheet.flatten(screen.getByTestId('calendar-marker-incomplete').props.style).borderColor).toBe(themes.light.colors.onSurfaceVariant);
    expect(screen.getByTestId('calendar-marker-not-started')).toBeTruthy();
    expect(screen.getByTestId('calendar-marker-paused')).toBeTruthy();
    screen.unmount(); client.clear();
});

it('projects durable receipts then pending controls on absent range dates across refetch and remount', async () => {
    const namespace = createOutboxNamespace('https://example.test', 1);
    const row = (operation: string, payload: QueuedMutation['payload'], id: string): QueuedMutation => ({ namespace, id, operation, payload, sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 });
    mockGetFoodDays.mockResolvedValue({ ...RANGE_RESPONSE, days: [] });
    mockGetPause.mockResolvedValue({ pause: { active: false } });
    mockOutbox.dayIntents = [row('food-tracking-pause.start', { starts_on: '2026-07-17' }, 'receipt:pause')];
    mockOutbox.mutations = [row('food-tracking-pause.resume', { resumed_on: '2026-07-18' }, 'resume')];
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    let screen = renderPicker(client);
    await waitFor(() => expect(screen.getByTestId('calendar-day-2026-07-17').props.accessibilityLabel).toMatch(/tracking paused/));
    expect(screen.getByTestId('calendar-day-2026-07-18').props.accessibilityLabel).toMatch(/in progress/);
    await act(async () => { await client.refetchQueries({ queryKey: ['mobile-food-days'] }); });
    expect(mockOutbox.readFoodDays).toHaveBeenCalled();
    screen.unmount(); screen = renderPicker(client);
    await waitFor(() => expect(screen.getByTestId('calendar-day-2026-07-18').props.accessibilityLabel).toMatch(/in progress/));
    screen.unmount(); client.clear(); mockOutbox.dayIntents = []; mockOutbox.mutations = [];
});
it('excludes failed and foreign-account projection without changing completed history', async () => {
    const namespace = createOutboxNamespace('https://example.test', 1);
    mockOutbox.mutations = [
        { namespace, id: 'failed', operation: 'food-tracking-pause.start', payload: { starts_on: '2026-07-11' }, sequence: 1, state: 'failed', attemptCount: 1, lastError: null, createdAt: 1, updatedAt: 1 },
        { namespace: 'other', id: 'foreign', operation: 'food-tracking-pause.start', payload: { starts_on: '2026-07-11' }, sequence: 2, state: 'pending', attemptCount: 0, lastError: null, createdAt: 2, updatedAt: 2 }
    ] as QueuedMutation[];
    mockGetFoodDays.mockResolvedValue(RANGE_RESPONSE); mockGetPause.mockResolvedValue({ pause: { active: false } });
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const screen = renderPicker(client);
    await waitFor(() => expect(screen.getByTestId('calendar-day-2026-07-11').props.accessibilityLabel).toMatch(/completed/));
    expect(screen.getByTestId('calendar-day-2026-07-18').props.accessibilityLabel).not.toMatch(/paused/);
    screen.unmount(); client.clear(); mockOutbox.mutations = [];
});

it('shows durable calendar intent with honest missing-history labels after an uncached read failure', async () => {
    mockGetFoodDays.mockRejectedValue(new Error('offline')); mockGetPause.mockResolvedValue({ pause: { active: false } });
    mockOutbox.dayIntents = [{ namespace: createOutboxNamespace('https://example.test', 1), id: 'receipt:pause', operation: 'food-tracking-pause.start', payload: { starts_on: '2026-07-17' }, sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 }];
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    const screen = renderPicker(client);
    await waitFor(() => expect(screen.getByText('Showing saved tracking changes. Other history is unavailable.')).toBeTruthy());
    expect(screen.getByTestId('calendar-day-2026-07-17').props.accessibilityLabel).toMatch(/tracking paused/);
    expect(screen.getByTestId('calendar-day-2026-07-11').props.accessibilityLabel).toMatch(/tracking status unavailable/);
    mockGetFoodDays.mockResolvedValue(RANGE_RESPONSE);
    await act(async () => { await client.refetchQueries({ queryKey: ['mobile-food-days'] }); });
    await waitFor(() => expect(screen.queryByText('Showing saved tracking changes. Other history is unavailable.')).toBeNull());
    screen.unmount(); client.clear(); mockOutbox.dayIntents = [];
});
