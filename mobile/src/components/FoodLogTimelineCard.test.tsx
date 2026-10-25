/** @file Regression coverage for Food Log Timeline Card: FoodLogTimelineCard. */

import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { FoodLogEntry } from '@calibrate/api-client';
import { FoodLogTimelineCard } from './FoodLogTimelineCard';
import { spacing } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const MORNING_SNACK_ENTRY: FoodLogEntry = {
    id: 1,
    meal_period: 'MORNING_SNACK',
    name: 'Oatmeal',
    calories: 350
};

const LEGACY_GRAMS_ENTRY: FoodLogEntry = {
    id: 2,
    meal_period: 'DINNER',
    name: 'Greek yogurt',
    calories: 84,
    servings_consumed: 1.42,
    serving_unit_label_snapshot: '100g',
    calories_per_serving_snapshot: 59,
    measure_label_snapshot: 'per 100g',
    grams_per_measure_snapshot: 100,
    measure_quantity_snapshot: 1.42,
    grams_total_snapshot: 142
};

describe('FoodLogTimelineCard', () => {
    it('uses the detailed page pane directly instead of adding a second card surface', async () => {
        const screen = await render(
            <FoodLogTimelineCard
                testID="food-log-content"
                entries={[]}
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
            />
        );
        const style = StyleSheet.flatten(screen.getByTestId('food-log-content').props.style);

        expect(style).toEqual(expect.objectContaining({ width: '100%', gap: spacing.md }));
        expect(style).not.toHaveProperty('padding');
        expect(style).not.toHaveProperty('borderRadius');
        expect(style).not.toHaveProperty('backgroundColor');
    });

    it.each([350, 0])('shows empty meal rows alongside a logged %i kcal meal', async (calories) => {
        const { queryByLabelText, getAllByText, getByLabelText, getByText } = await render(
            <FoodLogTimelineCard
                entries={[{ ...MORNING_SNACK_ENTRY, calories }]}
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
            />
        );

        expect(queryByLabelText(/Add food to/)).toBeNull();
        expect(getByLabelText('Collapse Morning Snack')).toBeTruthy();
        expect(getByText('Oatmeal')).toBeTruthy();
        expect(queryByLabelText('Expand Breakfast')).toBeNull();
        for (const meal of ['Breakfast', 'Morning Snack', 'Lunch', 'Afternoon Snack', 'Dinner', 'Evening Snack']) {
            expect(getByText(meal)).toBeTruthy();
        }
        expect(getAllByText('No entries')).toHaveLength(5);
        expect(getAllByText(`${calories} kcal`)).toHaveLength(2);
    });

    it('shows all six empty periods without disclosure or copy actions on an empty day', async () => {
        const { getAllByText, queryAllByRole } = await render(
            <FoodLogTimelineCard
                entries={[]}
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
                onCopyMeal={jest.fn()}
                onCopyDay={jest.fn()}
                onSaveMealAsRecipe={jest.fn()}
            />
        );

        expect(getAllByText('No entries')).toHaveLength(6);
        expect(queryAllByRole('button')).toHaveLength(0);
    });

    it('shows the real snapshot amount after expanding a meal', async () => {
        const { getByLabelText, getByText } = await render(
            <FoodLogTimelineCard
                entries={[LEGACY_GRAMS_ENTRY]}
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
            />
        );

        expect(getByLabelText('Collapse Dinner')).toBeTruthy();
        expect(getByText('142 g')).toBeTruthy();
    });

    it('offers an independently enabled save-recipe action under an expanded meal', async () => {
        const onSaveMealAsRecipe = jest.fn();
        const { getByText } = await render(
            <FoodLogTimelineCard
                entries={[MORNING_SNACK_ENTRY]}
                disabled
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
                onSaveMealAsRecipe={onSaveMealAsRecipe}
            />
        );

        await fireEvent.press(getByText('Save as recipe'));

        expect(onSaveMealAsRecipe).toHaveBeenCalledWith('MORNING_SNACK', [MORNING_SNACK_ENTRY]);
    });

    it('exposes accessible meal and day copy actions only for populated content', async () => {
        const onCopyMeal = jest.fn();
        const onCopyDay = jest.fn();
        const { getByRole, queryByLabelText } = await render(
            <FoodLogTimelineCard
                entries={[MORNING_SNACK_ENTRY]}
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
                onCopyMeal={onCopyMeal}
                onCopyDay={onCopyDay}
            />
        );

        await fireEvent.press(getByRole('button', { name: 'Copy Morning Snack' }));
        await fireEvent.press(getByRole('button', { name: 'Copy day' }));

        expect(onCopyMeal).toHaveBeenCalledWith('MORNING_SNACK');
        expect(onCopyDay).toHaveBeenCalledTimes(1);
        expect(queryByLabelText('Copy Breakfast')).toBeNull();
    });

    it('disables online-only copy without blocking queued edit and delete actions', async () => {
        const { getByRole } = await render(
            <FoodLogTimelineCard
                entries={[MORNING_SNACK_ENTRY]}
                copyDisabled
                onEditEntry={jest.fn()}
                onDeleteEntry={jest.fn()}
                onCopyMeal={jest.fn()}
                onCopyDay={jest.fn()}
            />
        );

        expect(getByRole('button', { name: 'Copy Morning Snack' })).toBeDisabled();
        expect(getByRole('button', { name: 'Copy day' })).toBeDisabled();
        expect(getByRole('button', { name: 'Edit Oatmeal' })).toBeEnabled();
        expect(getByRole('button', { name: 'Delete Oatmeal' })).toBeEnabled();
    });
});
