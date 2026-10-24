/** @file Regression coverage for Barcode Recovery Components: barcode recovery components. */

import { useState } from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { MEAL_PERIODS } from '@calibrate/shared';
import { BarcodeManualFoodForm } from './BarcodeManualFoodForm';
import { BarcodeManualInput } from './BarcodeManualInput';
import { BarcodeRecoveryActions } from './BarcodeRecoveryActions';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

describe('barcode recovery components', () => {
    it('exposes Search foods and Add manually as distinct recovery actions', async () => {
        const onSearchFoods = jest.fn();
        const onAddManually = jest.fn();
        const screen = await render(
            <BarcodeRecoveryActions onSearchFoods={onSearchFoods} onAddManually={onAddManually} />
        );

        await fireEvent.press(screen.getByRole('button', { name: 'Search foods' }));
        await fireEvent.press(screen.getByRole('button', { name: 'Add manually' }));
        expect(onSearchFoods).toHaveBeenCalledTimes(1);
        expect(onAddManually).toHaveBeenCalledTimes(1);
    });

    it('shows one manual barcode validation message and submits from the same input', async () => {
        const onSubmit = jest.fn();
        const screen = await render(
            <BarcodeManualInput
                value="123"
                error="EAN and UPC barcodes contain 6, 7, 8, 12, or 13 digits."
                onChange={jest.fn()}
                onSubmit={onSubmit}
            />
        );

        expect(screen.getAllByText('EAN and UPC barcodes contain 6, 7, 8, 12, or 13 digits.')).toHaveLength(1);
        await fireEvent.press(screen.getByRole('button', { name: 'Look up barcode' }));
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('builds a context-preserving manual food snapshot and ignores duplicate disabled presses', async () => {
        const onSubmit = jest.fn();
        function ManualFoodHarness({ meal }: { meal: typeof MEAL_PERIODS.DINNER | typeof MEAL_PERIODS.LUNCH }) {
            const [name, setName] = useState('');
            const [calories, setCalories] = useState('');
            return (
                <BarcodeManualFoodForm
                    date="2026-08-09"
                    meal={meal}
                    barcode="012345678905"
                    isSubmitting={false}
                    error={null}
                    name={name}
                    calories={calories}
                    onNameChange={setName}
                    onCaloriesChange={setCalories}
                    onCancel={jest.fn()}
                    onSubmit={onSubmit}
                />
            );
        }
        const screen = await render(<ManualFoodHarness meal={MEAL_PERIODS.DINNER} />);
        const [nameInput, calorieInput] = screen.container.queryAll((node) => node.type === 'TextInput');
        await fireEvent.changeText(nameInput, 'Market snack');
        await fireEvent.changeText(calorieInput, '245');
        await screen.rerender(<ManualFoodHarness meal={MEAL_PERIODS.LUNCH} />);
        await fireEvent.press(screen.getByRole('button', { name: 'Add and scan another' }));

        expect(onSubmit).toHaveBeenCalledWith({
            closeAfterLogging: false,
            payload: {
                date: '2026-08-09',
                meal_period: MEAL_PERIODS.LUNCH,
                name: 'Market snack',
                calories: 245,
                barcode: '012345678905'
            }
        });
    });
});
