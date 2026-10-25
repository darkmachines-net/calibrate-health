/** @file Regression coverage for Date Picker Field: confirms an iOS draft only on Done and forwards local date bounds. */

import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import * as ReactNative from 'react-native';
import type { FocusableFormControl } from './FormField';
import { DatePickerField } from './DatePickerField';


const mockNativeDateElement = { focus: jest.fn() };
jest.mock('react-native/Libraries/Components/Pressable/Pressable', () => {
    const ReactActual = require('react');
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: ReactActual.forwardRef((props: Record<string, any>, ref: unknown) => {
            ReactActual.useImperativeHandle(ref, () => mockNativeDateElement);
            return <View {...props} accessible style={typeof props.style === 'function' ? props.style({ pressed: false }) : props.style} />;
        })
    };
});jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('@react-native-community/datetimepicker', () => {
    const { View } = require('react-native');
    return (props: Record<string, unknown>) => <View {...props} testID="native-date-picker" />;
});

afterEach(() => jest.restoreAllMocks());

async function renderDateField(platform: 'ios' | 'android') {
    jest.replaceProperty(Platform, 'OS', platform);
    const onChangeDate = jest.fn();
    const screen = await render(
        <DatePickerField
            label="date of birth"
            value="1990-06-15"
            minimumDate="1900-01-01"
            maximumDate="2026-09-05"
            onChangeDate={onChangeDate}
        />
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Choose date of birth' }));
    return { screen, onChangeDate };
}

it('confirms an iOS draft only on Done and forwards local date bounds', async () => {
    const { screen, onChangeDate } = await renderDateField('ios');
    const picker = screen.getByTestId('native-date-picker');
    expect(picker.props.display).toBe('inline');
    expect(picker.props.minimumDate).toEqual(new Date(1900, 0, 1));
    expect(picker.props.maximumDate).toEqual(new Date(2026, 8, 5));

    await fireEvent(picker, 'change', { type: 'set' }, new Date(1991, 6, 16));
    expect(onChangeDate).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(onChangeDate).toHaveBeenCalledWith('1991-07-16');
    expect(screen.queryByTestId('native-date-picker')).toBeNull();
});

it('discards a canceled iOS draft and reopens the committed value', async () => {
    const { screen, onChangeDate } = await renderDateField('ios');
    await fireEvent(screen.getByTestId('native-date-picker'), 'change', { type: 'set' }, new Date(1991, 6, 16));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChangeDate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('native-date-picker')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Choose date of birth' }));
    expect(screen.getByTestId('native-date-picker').props.value).toEqual(new Date(1990, 5, 15));
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(onChangeDate).toHaveBeenCalledWith('1990-06-15');
});

it.each(['set', 'dismissed'])('preserves Android dialog behavior for %s', async (type) => {
    const { screen, onChangeDate } = await renderDateField('android');
    expect(screen.getByTestId('native-date-picker').props.display).toBe('calendar');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    await fireEvent(screen.getByTestId('native-date-picker'), 'change', { type }, new Date(1991, 6, 16));
    expect(screen.queryByTestId('native-date-picker')).toBeNull();
    if (type === 'set') {
        expect(onChangeDate).toHaveBeenCalledWith('1991-07-16');
    } else {
        expect(onChangeDate).not.toHaveBeenCalled();
    }
});

it('announces its selected value and keeps enlarged date text untruncated', async () => {
    const screen = await render(
        <DatePickerField label="date of birth" value="1990-06-15" onChangeDate={jest.fn()} errorText="Review your date of birth." />
    );
    const button = screen.getByRole('button', { name: 'Choose date of birth' });
    expect(button.props.accessibilityValue).toEqual({ text: 'Jun 15, 1990' });
    expect(button.props['aria-invalid']).toBe(true);
    expect(button.props.accessibilityHint).toBe('Review your date of birth.');
    expect(screen.getByText('Jun 15, 1990').props.numberOfLines).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent('Review your date of birth.');
});

it.each(['android', 'ios'] as const)('moves %s accessibility focus to the date button without opening its picker', async (platform) => {
    jest.replaceProperty(Platform, 'OS', platform);
    const findHandle = jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(73);
    const accessibilityFocus = jest.spyOn(ReactNative.AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(jest.fn());
    const controlRef: { current: FocusableFormControl | null } = { current: null };
    const screen = await render(
        <DatePickerField label="date of birth" value="" onChangeDate={jest.fn()} controlRef={controlRef} />
    );
    mockNativeDateElement.focus.mockClear();
    controlRef.current!.focus();
    expect(mockNativeDateElement.focus).toHaveBeenCalledTimes(1);
    expect(findHandle).toHaveBeenCalledWith(mockNativeDateElement);
    expect(accessibilityFocus).toHaveBeenCalledWith(73);
    expect(screen.queryByTestId('native-date-picker')).toBeNull();
});