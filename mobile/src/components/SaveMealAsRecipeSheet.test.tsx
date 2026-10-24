/** @file Regression coverage for Save Meal As Recipe Sheet: SaveMealAsRecipeSheet. */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodLogEntry } from '@calibrate/api-client';
import { MEAL_PERIODS } from '@calibrate/shared';
import { SaveMealAsRecipeSheet } from './SaveMealAsRecipeSheet';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-haptics', () => ({
    notificationAsync: jest.fn(() => Promise.resolve()),
    NotificationFeedbackType: { Success: 'success' }
}));

const mockCreateRecipeFromFoodLogs = jest.fn();
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ api: { createRecipeFromFoodLogs: mockCreateRecipeFromFoodLogs } })
}));

jest.mock('./BottomSheetModal', () => {
    const ReactModule = require('react');
    const { View } = require('react-native');
    return {
        BottomSheetModal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
            visible ? ReactModule.createElement(View, null, children) : null
    };
});

const entries: FoodLogEntry[] = [
    {
        id: 11,
        meal_period: MEAL_PERIODS.EVENING_SNACK,
        name: 'Tequila',
        calories: 96,
        servings_consumed: 2,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'oz',
        calories_per_serving_snapshot: 48
    },
    {
        id: 12,
        meal_period: MEAL_PERIODS.EVENING_SNACK,
        name: 'Lime juice',
        calories: 12,
        servings_consumed: 30,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'g',
        calories_per_serving_snapshot: 0.4,
        grams_total_snapshot: 30
    }
];

function renderSheet(props: Partial<React.ComponentProps<typeof SaveMealAsRecipeSheet>> = {}) {
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
            <SaveMealAsRecipeSheet
                visible
                date="2026-08-03"
                meal={MEAL_PERIODS.EVENING_SNACK}
                entries={entries}
                onClose={onClose}
                onSaved={onSaved}
                {...props}
            />
        </QueryClientProvider>
    );
    return { ...screen, onClose, onSaved };
}

describe('SaveMealAsRecipeSheet', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateRecipeFromFoodLogs.mockResolvedValue({ id: 7, name: 'Margarita' });
    });

    it('preselects the meal and updates totals when an ingredient is excluded', () => {
        const screen = renderSheet();

        expect(screen.getByText('108 kcal total')).toBeTruthy();
        expect(screen.getByRole('checkbox', { name: 'Exclude Tequila' }).props.accessibilityState).toEqual(
            expect.objectContaining({ checked: true })
        );
        fireEvent.press(screen.getByRole('checkbox', { name: 'Exclude Lime juice' }));
        expect(screen.getByText('96 kcal total')).toBeTruthy();
        expect(screen.getByText(/1 item selected/)).toBeTruthy();
    });

    it('creates a recipe from selected log ids in their displayed order', async () => {
        const screen = renderSheet();
        fireEvent.changeText(screen.getByLabelText('Recipe name'), 'Margarita');
        fireEvent.changeText(screen.getByLabelText('These items make'), '2');
        fireEvent.press(screen.getByRole('button', { name: 'Save recipe' }));

        await waitFor(() => expect(mockCreateRecipeFromFoodLogs).toHaveBeenCalledWith({
            name: 'Margarita',
            yield_servings: 2,
            food_log_ids: [11, 12]
        }));
        await waitFor(() => expect(screen.onSaved).toHaveBeenCalledWith('Margarita'));
    });

    it('requires a name, positive yield, and at least one selected ingredient', () => {
        const screen = renderSheet();
        expect(screen.getByRole('button', { name: 'Save recipe' })).toBeDisabled();

        fireEvent.changeText(screen.getByLabelText('Recipe name'), 'Margarita');
        fireEvent.press(screen.getByRole('checkbox', { name: 'Exclude Tequila' }));
        fireEvent.press(screen.getByRole('checkbox', { name: 'Exclude Lime juice' }));
        expect(screen.getByText('Select at least one ingredient.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save recipe' })).toBeDisabled();
    });
});
