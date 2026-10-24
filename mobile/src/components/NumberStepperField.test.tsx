/** @file Regression coverage for Number Stepper Field: NumberStepperField. */

import { fireEvent, render } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import { NumberStepperField } from './NumberStepperField';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

describe('NumberStepperField', () => {
    it('keeps a precise keyboard value visible and normalizes a localized decimal', () => {
        const onChangeText = jest.fn();
        const screen = render(
            <NumberStepperField
                label='Amount'
                value='0,125'
                onChangeText={onChangeText}
                step={0.25}
            />
        );

        const input = screen.UNSAFE_getByType(TextInput);
        expect(input.props.value).toBe('0,125');
        expect(input.props.selectTextOnFocus).toBe(true);
        fireEvent.changeText(input, '0,25');
        expect(onChangeText).toHaveBeenCalledWith('0.25');
    });

    it('preserves keyboard-entered precision when a step button is pressed', () => {
        const onChangeText = jest.fn();
        const screen = render(
            <NumberStepperField
                label='Amount'
                value='0.125'
                onChangeText={onChangeText}
                step={0.25}
                min={0.001}
            />
        );

        fireEvent.press(screen.getByRole('button', { name: 'Increase Amount by 0.25' }));
        expect(onChangeText).toHaveBeenCalledWith('0.375');
    });

    it('disables a decrement that would jump a precise amount below its minimum', () => {
        const screen = render(
            <NumberStepperField
                label='Amount'
                value='0.125'
                onChangeText={jest.fn()}
                step={0.25}
                min={0.001}
            />
        );

        expect(
            screen.getByRole('button', { name: 'Decrease Amount by 0.25' }).props.accessibilityState.disabled
        ).toBe(true);
    });
});
