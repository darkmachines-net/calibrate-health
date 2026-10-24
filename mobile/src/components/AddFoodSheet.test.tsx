/** @file Regression coverage for Add Food Sheet: AddFoodSheet adaptive layout. */

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
import { recordFoodDayReceipt } from '../offline/foodDayReceipts';
import { createOutboxDispatch, type OutboxDispatch } from '../offline/mutationDispatch';
import type { QueuedMutation } from '../offline/queuedMutation';
import React from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MEAL_PERIODS, type MealPeriod } from '@calibrate/shared';
import type { RecentFoodSummary } from '@calibrate/api-client';
import { AddFoodSheet, usesCompactAddFoodLayout } from './AddFoodSheet';
import { getSavedFoodsLibraryQueryKey } from '../savedFoods/queryKeys';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'food-operation-id') }));
jest.mock('../utils/haptics', () => ({ triggerHapticFeedback: jest.fn() }));
const mockConfirmDiscardChanges = jest.fn(async () => true);
jest.mock('./confirmDiscardChanges', () => ({
    confirmDiscardChanges: () => mockConfirmDiscardChanges()
}));

const mockApi = {
    getFoodDay: jest.fn(),
    setFoodDayStatus: jest.fn(),
    getRecentFoods: jest.fn(),
    searchFood: jest.fn(),
    getMyFoods: jest.fn(),
    createFoodLog: jest.fn()
};

function createRecentFoodFixture() {
    return {
        id: 'recent-1',
        name: 'Greek yogurt',
        meal_period: MEAL_PERIODS.BREAKFAST,
        calories: 150,
        my_food_id: null,
        servings_consumed: 1,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'container',
        calories_per_serving_snapshot: 150,
        external_source: null,
        external_id: null,
        brand_snapshot: null,
        locale_snapshot: null,
        barcode_snapshot: null,
        measure_label_snapshot: null,
        grams_per_measure_snapshot: null,
        measure_quantity_snapshot: null,
        grams_total_snapshot: null,
        last_logged_at: '2026-08-08T12:00:00.000Z',
        times_logged: 1
    };
}

jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({
        api: mockApi,
        user: { id: 7, haptics_enabled: false }
    })
}));

const mockEnqueue = jest.fn();
let mockWithOutbox: OutboxDispatch | undefined;
jest.mock('../offline/provider', () => ({
    useOfflineOutbox: () => ({ enqueue: mockEnqueue, withOutbox: mockWithOutbox })
}));

jest.mock('./BottomSheetModal', () => {
    const ReactModule = require('react');
    const { View } = require('react-native');
    return {
        BottomSheetModal: ({
            visible,
            children,
            contentStyle
        }: {
            visible: boolean;
            children: React.ReactNode;
            contentStyle?: object;
        }) => visible
            ? ReactModule.createElement(View, { testID: 'add-food-sheet-content', style: contentStyle }, children)
            : null
    };
});

function recentFood(name: string, mealPeriod: MealPeriod): RecentFoodSummary {
    return {
        id: `recent:${name.toLocaleLowerCase().replaceAll(' ', '-')}`,
        name,
        meal_period: mealPeriod,
        calories: 150,
        my_food_id: null,
        servings_consumed: 1,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'serving',
        calories_per_serving_snapshot: 150,
        external_source: null,
        external_id: null,
        brand_snapshot: null,
        locale_snapshot: null,
        barcode_snapshot: null,
        measure_label_snapshot: null,
        grams_per_measure_snapshot: null,
        measure_quantity_snapshot: null,
        grams_total_snapshot: null,
        last_logged_at: '2026-08-08T12:00:00.000Z',
        times_logged: 1
    };
}

function renderSheet(seed?: (queryClient: QueryClient) => void) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 }
        }
    });
    seed?.(queryClient);
    return render(
        <QueryClientProvider client={queryClient}>
            <AddFoodSheet
                visible
                date="2026-08-08"
                initialMeal={MEAL_PERIODS.BREAKFAST}
                onClose={jest.fn()}
            />
        </QueryClientProvider>
    );
}

describe('AddFoodSheet adaptive layout', () => {
    it('keeps phone search focused while retaining full controls on tablets', () => {
        expect(usesCompactAddFoodLayout(719)).toBe(true);
        expect(usesCompactAddFoodLayout(720)).toBe(false);
        expect(usesCompactAddFoodLayout(1_024)).toBe(false);
    });
});

describe('AddFoodSheet async resource states', () => {
    beforeEach(() => {
        const phoneDimensions = {
            width: 390,
            height: 844,
            scale: 3,
            fontScale: 1
        };
        Dimensions.set({ window: phoneDimensions, screen: phoneDimensions });
        jest.clearAllMocks();
        mockApi.getFoodDay.mockResolvedValue({ date: '2026-08-08', status: 'OPEN' });
        mockApi.setFoodDayStatus.mockReset().mockResolvedValue({ date: '2026-08-08', status: 'OPEN' });
        mockApi.createFoodLog.mockReset().mockResolvedValue({});
        mockEnqueue.mockReset().mockResolvedValue(undefined);
        mockWithOutbox = undefined;
        mockApi.getRecentFoods.mockResolvedValue({ items: [] });
        mockApi.searchFood.mockResolvedValue({ items: [] });
        mockApi.getMyFoods.mockResolvedValue([]);
        onlineManager.setOnline(false);
    });

    afterEach(() => {
        cleanup();
        onlineManager.setOnline(true);
    });

    // The first sheet render also initializes React Native on a cold Jest cache.
    it.each(['COMPLETE', 'INCOMPLETE'])('reopens a %s day only when food is submitted', async (status) => {
        onlineManager.setOnline(true);
        mockApi.getFoodDay.mockResolvedValue({ date: '2026-08-08', status });
        const screen = renderSheet();
        await screen.findByText('Adding food reopens this day so you can complete it again.');
        expect(mockApi.setFoodDayStatus).not.toHaveBeenCalled();
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        await waitFor(() => expect(mockApi.createFoodLog).toHaveBeenCalled());
        expect(mockApi.setFoodDayStatus).toHaveBeenCalledWith({ date: '2026-08-08', status: 'OPEN' }, expect.any(String));
        expect(mockApi.setFoodDayStatus.mock.invocationCallOrder[0]).toBeLessThan(mockApi.createFoodLog.mock.invocationCallOrder[0]);
    }, 10_000);

    it('queues the food after its reopen when the connection fails', async () => {
        onlineManager.setOnline(true);
        mockApi.getFoodDay.mockResolvedValue({ date: '2026-08-08', status: 'COMPLETE' });
        mockApi.setFoodDayStatus.mockRejectedValue(new TypeError('Network request failed'));
        const screen = renderSheet();
        await screen.findByText('Adding food reopens this day so you can complete it again.');
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        await waitFor(() => expect(mockEnqueue).toHaveBeenCalledTimes(2));
        expect(mockEnqueue.mock.calls[0]).toEqual(['food-day.set-status', { date: '2026-08-08', status: 'OPEN' }, expect.any(String)]);
        expect(mockEnqueue.mock.calls[1]).toEqual(['food.create', expect.objectContaining({ date: '2026-08-08', calories: 120 })]);
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
    });

    it('keeps queued reopen and food ahead of a competing day completion', async () => {
        onlineManager.setOnline(true);
        mockApi.getFoodDay.mockResolvedValue({ date: '2026-08-08', status: 'COMPLETE' });
        const rows: QueuedMutation[] = []; const order: string[] = [];
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const write = async (operation: string, payload: unknown) => {
            const status = (payload as { status?: string }).status;
            order.push(status ?? operation);
            rows.push({ operation, payload } as QueuedMutation);
            if (status === 'OPEN') await barrier;
        };
        const dispatch = createOutboxDispatch('reopen-regression', async () => rows, write, () => true);
        mockWithOutbox = dispatch;
        mockEnqueue.mockImplementation((operation: string, payload: unknown) => dispatch(enqueue => enqueue(operation, payload)));
        const screen = renderSheet();
        await screen.findByText('Adding food reopens this day so you can complete it again.');
        onlineManager.setOnline(false);
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        await waitFor(() => expect(order).toEqual(['OPEN']));
        const competing = dispatch(enqueue => enqueue('food-day.set-status', { date: '2026-08-08', status: 'COMPLETE' }));
        release(); await competing;
        await waitFor(() => expect(order).toEqual(['OPEN', 'food.create', 'COMPLETE']));
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
    });

    it.each(['food-day.set-status', 'food-day.update'])('reopens after durable %s completion despite a cached OPEN day', async operation => {
        const rows = [{ id: 'prior-day', namespace: 'test', sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1, operation, payload: { date: '2026-08-08', status: 'COMPLETE', is_complete: true } } as QueuedMutation];
        mockWithOutbox = createOutboxDispatch('stale-open-' + operation, async () => rows, async (kind, payload) => { rows.push({ operation: kind, payload } as QueuedMutation); }, () => true);
        const screen = renderSheet(client => client.setQueryData(['mobile-food-day', '2026-08-08'], { date: '2026-08-08', status: 'OPEN' }));
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        await waitFor(() => expect(rows.map(row => (row.payload as { status?: string }).status ?? row.operation)).toEqual(['COMPLETE', 'OPEN', 'food.create']));
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
    });

    it('does not add food when a durable day pause supersedes cached OPEN', async () => {
        const rows = [{ id: 'prior-day', namespace: 'test', sequence: 1, state: 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1, operation: 'food-tracking-pause.start', payload: { starts_on: '2026-08-08' } } as QueuedMutation];
        const write = jest.fn(async () => undefined);
        mockWithOutbox = createOutboxDispatch('stale-paused', async () => rows, write, () => true);
        const screen = renderSheet(client => client.setQueryData(['mobile-food-day', '2026-08-08'], { date: '2026-08-08', status: 'OPEN' }));
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        await screen.findByRole('alert');
        expect(write).not.toHaveBeenCalled();
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
    });

    it.each([
        ['pending', '2026-08-07', true], ['pending', '2026-08-08', true], ['pending', '2026-08-09', false],
        ['receipt', '2026-08-07', true], ['receipt', '2026-08-08', true], ['receipt', '2026-08-09', false],
        ['failed', '2026-08-08', false], ['later-pause', '2026-08-08', false]
    ] as const)('consults locked %s resume on %s before rejecting cached PAUSED food', async (kind, resumedOn, allowed) => {
        const rows: QueuedMutation[] = [{ id: kind === 'receipt' ? 'receipt:resume' : 'resume', namespace: 'test', sequence: 1, state: kind === 'failed' ? 'failed' : 'pending', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1, operation: 'food-tracking-pause.resume', payload: { resumed_on: resumedOn } }];
        if (kind === 'later-pause') rows.push({ ...rows[0], id: 'later-pause', sequence: 2, operation: 'food-tracking-pause.start', payload: { starts_on: '2026-08-08' } });
        const write = jest.fn(async () => undefined);
        const namespace = 'resume-boundary-' + kind + resumedOn;
        if (kind === 'receipt') {
            await recordFoodDayReceipt(namespace, 'food-tracking-pause.resume', { resumed_on: resumedOn }, 'applied-resume');
        }
        mockWithOutbox = createOutboxDispatch(namespace, async () => kind === 'receipt' ? [] : rows, write, () => true, true);
        const screen = renderSheet(client => client.setQueryData(['mobile-food-day', '2026-08-08'], { date: '2026-08-08', status: 'PAUSED' }));
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        if (allowed) await waitFor(() => expect(write).toHaveBeenCalledWith('food.create', expect.objectContaining({ date: '2026-08-08', calories: 120 }), 'food-operation-id'));
        else { await screen.findByRole('alert'); expect(write).not.toHaveBeenCalled(); }
        expect(mockApi.setFoodDayStatus).not.toHaveBeenCalled();
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
    });

    it('does not add food when reopening is rejected', async () => {
        onlineManager.setOnline(true);
        mockApi.getFoodDay.mockResolvedValue({ date: '2026-08-08', status: 'COMPLETE' });
        mockApi.setFoodDayStatus.mockRejectedValue(new Error('Unable to reopen day'));
        const screen = renderSheet();
        await screen.findByText('Adding food reopens this day so you can complete it again.');
        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        fireEvent.changeText(screen.getByLabelText('Calories'), '120');
        fireEvent.press(screen.getByRole('button', { name: 'Add & close' }));
        await screen.findByRole('alert');
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('preloads meal-aware recent foods before typing and refreshes them when the meal changes', async () => {
        onlineManager.setOnline(true);
        mockApi.getRecentFoods.mockImplementation(({ meal_period }: { meal_period?: MealPeriod }) => Promise.resolve({
            items: meal_period === MEAL_PERIODS.AFTERNOON_SNACK
                ? [recentFood('Snack yogurt', MEAL_PERIODS.AFTERNOON_SNACK)]
                : [recentFood('Breakfast oats', MEAL_PERIODS.BREAKFAST)]
        }));
        const screen = renderSheet();

        expect(await screen.findByText('Breakfast oats')).toBeTruthy();
        expect(mockApi.getRecentFoods).toHaveBeenCalledWith({
            q: undefined,
            limit: 8,
            meal_period: MEAL_PERIODS.BREAKFAST
        });
        expect(mockApi.searchFood).not.toHaveBeenCalled();

        fireEvent.press(screen.getByLabelText('Select meal'));
        fireEvent.press(screen.getByLabelText('Afternoon Snack'));

        expect(await screen.findByText('Snack yogurt')).toBeTruthy();
        expect(mockApi.getRecentFoods).toHaveBeenLastCalledWith({
            q: undefined,
            limit: 8,
            meal_period: MEAL_PERIODS.AFTERNOON_SNACK
        });
    }, 10_000);

    it('does not describe an uncached offline food search as having no matches', async () => {
        const screen = renderSheet();
        const searchField = screen.getByLabelText('Search foods');
        fireEvent.changeText(searchField, 'apple');
        fireEvent(searchField, 'submitEditing');

        await waitFor(() => expect(screen.getByText('Connect to the internet to load food search.')).toBeTruthy());
        expect(screen.queryByText('No matching foods found.')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(mockApi.searchFood).not.toHaveBeenCalled();
    });

    it('keeps the empty web search result region keyboard reachable', () => {
        const replacedPlatform = jest.replaceProperty(Platform, 'OS', 'web');
        try {
            const screen = renderSheet();
            expect(screen.getByTestId('food-search-results').props.tabIndex).toBe(0);
        } finally {
            replacedPlatform.restore();
        }
    });

    it('keeps results visible and actionable while the mobile search field is focused', () => {
        const dismissKeyboard = jest.spyOn(Keyboard, 'dismiss');

        try {
            const screen = renderSheet((queryClient) => {
                queryClient.setQueryData(['mobile-recent-foods', MEAL_PERIODS.BREAKFAST, 'browse'], {
                    items: [createRecentFoodFixture()]
                });
                queryClient.setQueryData(['mobile-my-foods'], []);
            });
            const searchField = screen.getByLabelText('Search foods');

            fireEvent(searchField, 'focus');

            expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Saved foods' })).toBeNull();
            expect(screen.queryByLabelText('Select meal')).toBeNull();
            expect(screen.queryByRole('radio', { name: 'Quick' })).toBeNull();
            expect(screen.getByTestId('food-search-results')).toBeTruthy();

            fireEvent(searchField, 'blur');
            expect(screen.getByTestId('food-search-results')).toBeTruthy();
            fireEvent.press(screen.getByLabelText('Choose amount for Greek yogurt'));

            expect(dismissKeyboard).toHaveBeenCalled();
            expect(screen.queryByTestId('food-search-results')).toBeNull();
        } finally {
            dismissKeyboard.mockRestore();
        }
    });

    it('removes the Android bottom inset only while the search workspace is focused', () => {
        const replacedPlatform = jest.replaceProperty(Platform, 'OS', 'android');
        try {
            const screen = renderSheet();

            expect(screen.getByTestId('add-food-sheet-content').props.style).toBeUndefined();
            fireEvent(screen.getByLabelText('Search foods'), 'focus');
            expect(screen.getByTestId('add-food-sheet-content').props.style).toMatchObject({
                paddingBottom: 0
            });
        } finally {
            replacedPlatform.restore();
        }
    });

    it('finds cached library recipes offline and opens quantity confirmation without logging', async () => {
        const screen = renderSheet((queryClient) => {
            queryClient.setQueryData(getSavedFoodsLibraryQueryKey('', 'RECIPE'), {
                pages: [{ items: [{
                    id: 14, type: 'RECIPE', name: 'Overnight oats', is_pinned: false,
                    serving_size_quantity: 1, serving_unit_label: 'serving',
                    calories_per_serving: 320, recipe_total_calories: 640, yield_servings: 2
                }], next_cursor: null }], pageParams: [undefined]
            });
        });
        const searchField = screen.getByLabelText('Search foods');
        fireEvent.changeText(searchField, 'oats');
        fireEvent(searchField, 'submitEditing');
        expect(await screen.findByText('Overnight oats')).toBeTruthy();
        expect(screen.getByText('Offline - showing saved information')).toBeTruthy();
        fireEvent.press(screen.getByLabelText('Choose amount for Overnight oats'));
        expect(screen.getByLabelText('Amount')).toBeTruthy();
        expect(mockApi.getMyFoods).not.toHaveBeenCalled();
        expect(mockApi.createFoodLog).not.toHaveBeenCalled();
    });

    it('offers only Quick and Search while keeping saved recipes discoverable in Search', async () => {
        onlineManager.setOnline(true);
        mockApi.getMyFoods.mockResolvedValue([{
            id: 14,
            type: 'RECIPE',
            name: 'Overnight oats',
            is_pinned: false,
            serving_size_quantity: 1,
            serving_unit_label: 'serving',
            calories_per_serving: 320,
            recipe_total_calories: 640,
            yield_servings: 2
        }]);
        const screen = renderSheet();

        expect(screen.getByRole('radio', { name: 'Quick' })).toBeTruthy();
        expect(screen.getByRole('radio', { name: 'Search' })).toBeTruthy();
        expect(screen.queryByRole('radio', { name: 'Recipes' })).toBeNull();
        expect(screen.queryByLabelText('Search recipes')).toBeNull();

        const searchField = screen.getByLabelText('Search foods');
        fireEvent.changeText(searchField, '  oats  ');
        fireEvent(searchField, 'submitEditing');

        expect(await screen.findByText('Overnight oats')).toBeTruthy();
        expect(screen.getByText('Recipe | 320 kcal per serving')).toBeTruthy();
    });

    it('links to Saved foods from the Add Food sheet', () => {
        const screen = renderSheet();

        fireEvent.press(screen.getByRole('button', { name: 'Saved foods' }));

        const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
        expect(router.push).toHaveBeenCalledWith('/my-foods');

        fireEvent.press(screen.getByRole('radio', { name: 'Quick' }));
        expect(screen.queryByRole('button', { name: 'Saved foods' })).toBeNull();
    });

    it('confirms before Saved foods or Scan discards a selected food draft', async () => {
        onlineManager.setOnline(true);
        mockConfirmDiscardChanges.mockResolvedValue(false);
        const recentFood = createRecentFoodFixture();
        mockApi.getRecentFoods.mockResolvedValue({ items: [recentFood] });
        const screen = renderSheet();
        const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };

        fireEvent.press(await screen.findByLabelText('Choose amount for Greek yogurt'));
        fireEvent.press(screen.getByRole('button', { name: 'Saved foods' }));
        fireEvent.press(screen.getByRole('button', { name: 'Scan' }));

        await waitFor(() => expect(mockConfirmDiscardChanges).toHaveBeenCalledTimes(2));
        expect(router.push).not.toHaveBeenCalled();

        mockConfirmDiscardChanges.mockResolvedValue(true);
        fireEvent.press(screen.getByRole('button', { name: 'Saved foods' }));

        await waitFor(() => expect(router.push).toHaveBeenCalledWith('/my-foods'));
    });
});
