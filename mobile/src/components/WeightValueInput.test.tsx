/** @file Regression coverage for Weight Value Input: WeightValueInput. */

import { act, fireEvent, render } from '@testing-library/react-native';
import { Dimensions, StyleSheet } from 'react-native';
import { WeightValueInput } from './WeightValueInput';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

describe('WeightValueInput', () => {
    const originalWindow = Dimensions.get('window');
    beforeEach(() => {
        act(() => Dimensions.set({ window: { ...originalWindow, width: 320, fontScale: 1 } }));
    });

    afterEach(() => act(() => Dimensions.set({ window: originalWindow })));
    it('makes the measurement visually dominant and keeps native-sized controls', () => {
        const screen = render(
            <WeightValueInput
                value="170.5"
                unit="LB"
                step={0.1}
                min={0.1}
                editable
                onChangeText={jest.fn()}
            />
        );

        const input = screen.getByLabelText('Weight in pounds');
        expect(StyleSheet.flatten(input.props.style)).toEqual(expect.objectContaining({
            fontSize: 52,
            minHeight: 96,
            textAlign: 'center',
            textAlignVertical: 'center'
        }));
        expect(screen.getByTestId('weight-value-surface')).toHaveStyle({
            minHeight: 96,
            alignItems: 'center',
            justifyContent: 'center'
        });
        expect(screen.getByRole('button', { name: 'Decrease weight by 0.1 pounds' })).toHaveStyle({ minHeight: 56 });
        expect(screen.getByRole('button', { name: 'Increase weight by 0.1 pounds' })).toHaveStyle({ minHeight: 56 });
    });

    it('supports goal-specific labeling without changing the control geometry', () => {
        const screen = render(
            <WeightValueInput
                label="Target"
                value="165"
                unit="LB"
                step={0.1}
                min={0.1}
                editable
                onChangeText={jest.fn()}
            />
        );

        expect(screen.getByText('Target')).toBeTruthy();
        expect(screen.getByLabelText('Target in pounds')).toHaveProp('value', '165');
        expect(screen.getByTestId('weight-value-surface')).toHaveStyle({ minHeight: 96 });
        expect(screen.getByRole('button', { name: 'Decrease target by 0.1 pounds' })).toBeTruthy();
    });

    it('normalizes a decimal comma and steps at one tenth', () => {
        const onChangeText = jest.fn();
        const onStep = jest.fn();
        const screen = render(
            <WeightValueInput
                value="170.5"
                unit="LB"
                step={0.1}
                min={0.1}
                editable
                onChangeText={onChangeText}
                onStep={onStep}
            />
        );

        fireEvent.changeText(screen.getByLabelText('Weight in pounds'), '171,2');
        expect(onChangeText).toHaveBeenCalledWith('171.2');
        fireEvent.press(screen.getByRole('button', { name: 'Increase weight by 0.1 pounds' }));
        expect(onChangeText).toHaveBeenCalledWith('170.6');
        expect(onStep).toHaveBeenCalledTimes(1);
    });

    it('makes room for 200% native text and moves the unit out of the numeric input', () => {
        act(() => Dimensions.set({ window: { ...originalWindow, width: 320, fontScale: 2 } }));
        const screen = render(<WeightValueInput value="170.5" unit="LB" step={0.1} min={0.1} editable onChangeText={jest.fn()} />);

        expect(screen.getByLabelText('Weight in pounds')).toHaveStyle({ fontSize: 52, minHeight: 136, paddingHorizontal: 16 });
        expect(screen.getByTestId('weight-unit-slot')).toHaveStyle({ position: 'relative' });
        expect(StyleSheet.flatten(screen.getByTestId('weight-value-surface').props.style).overflow).toBeUndefined();
        expect(screen.getByRole('button', { name: 'Increase weight by 0.1 pounds' })).toHaveStyle({ minHeight: 56 });
    });
});
