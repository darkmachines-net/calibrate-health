/** @file Regression coverage for Today Food Preview: TodayFoodPreview. */

import { fireEvent, render, within } from '@testing-library/react-native';
import type { FoodLogEntry } from '@calibrate/api-client';
import { TodayFoodPreview } from './TodayFoodPreview';
import { themes } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

describe('TodayFoodPreview', () => {
    it('provides one growing navigation target with hover feedback and a date-neutral empty state', () => {
        const onPress = jest.fn();
        const screen = render(<TodayFoodPreview entries={[]} onPress={onPress} />);
        const preview = screen.getByRole('button', { name: /Food log\. 0 foods\./ });
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.getByTestId('today-food-scroll')).toBeTruthy();
        expect(screen.getByText('No food logged yet')).toBeTruthy();
        expect(screen.queryByText('No entries')).toBeNull();
        expect(preview).toHaveStyle({ flexGrow: 1, flexShrink: 0, flexBasis: 'auto', width: '100%' });
        fireEvent(preview, 'hoverIn');
        expect(preview).toHaveStyle({ backgroundColor: themes.light.colors.surfaceHovered });
        fireEvent.press(preview);
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('shows every meal total and empty slot, without individual foods or completion claims', () => {
        const entries: FoodLogEntry[] = [
            { id: 1, meal_period: 'DINNER', name: 'Salmon', calories: 300 },
            { id: 2, meal_period: 'BREAKFAST', name: 'Oatmeal', calories: 200 },
            { id: 3, meal_period: 'DINNER', name: 'Potatoes', calories: 210 },
            { id: 4, meal_period: 'AFTERNOON_SNACK', name: 'Tea', calories: 0 }
        ];
        const screen = render(<TodayFoodPreview entries={entries} onPress={jest.fn()} />);
        expect(screen.getByText('4 foods')).toBeTruthy();
        expect(screen.getAllByTestId(/^food-preview-meal-/).map((row) => row.props.testID)).toEqual([
            'food-preview-meal-BREAKFAST', 'food-preview-meal-MORNING_SNACK', 'food-preview-meal-LUNCH',
            'food-preview-meal-AFTERNOON_SNACK', 'food-preview-meal-DINNER', 'food-preview-meal-EVENING_SNACK'
        ]);
        expect(within(screen.getByTestId('food-preview-meal-DINNER')).getByText('510 kcal')).toBeTruthy();
        expect(within(screen.getByTestId('food-preview-meal-AFTERNOON_SNACK')).getByText('0 kcal')).toBeTruthy();
        expect(screen.getAllByText('No entries')).toHaveLength(3);
        for (const entry of entries) expect(screen.queryByText(entry.name)).toBeNull();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.getByRole('button').props.accessibilityLabel).toContain('Dinner, 510 kcal.');
        expect(screen.getByRole('button').props.accessibilityLabel).not.toContain('Salmon');
        expect(screen.queryByTestId('food-preview-measurements')).toBeNull();
    });
});
