/** @file Regression coverage for Segmented Control: SegmentedControl. */

import { useState } from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SegmentedControl } from './SegmentedControl';
import { themes } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const OPTIONS = [
    { value: 'quick', label: 'Quick' },
    { value: 'search', label: 'Search' },
    { value: 'recipes', label: 'Recipes' }
] as const;
type OptionValue = (typeof OPTIONS)[number]['value'];

function TestControl() {
    const [value, setValue] = useState<OptionValue>('quick');
    return (
        <SegmentedControl<OptionValue>
            accessibilityLabel="Add food method"
            testID="segmented-control"
            options={OPTIONS}
            value={value}
            onChange={setValue}
        />
    );
}

describe('SegmentedControl', () => {
    afterAll(() => {
        Dimensions.set({
            window: { width: 1_024, height: 768, scale: 1, fontScale: 1 },
            screen: { width: 1_024, height: 768, scale: 1, fontScale: 1 }
        });
    });

    it('keeps previously selected labels visible when the selection changes', async () => {
        const { getByRole, getByText } = await render(<TestControl />);

        await fireEvent.press(getByRole('radio', { name: 'Search' }));
        expect(StyleSheet.flatten(getByText('Quick').props.style)).toEqual(
            expect.objectContaining({ color: themes.light.colors.onSurfaceVariant })
        );

        await fireEvent.press(getByRole('radio', { name: 'Recipes' }));
        expect(StyleSheet.flatten(getByText('Search').props.style)).toEqual(
            expect.objectContaining({ color: themes.light.colors.onSurfaceVariant })
        );

        expect(getByRole('radio', { name: 'Recipes' }).props.accessibilityState).toEqual(
            expect.objectContaining({ checked: true })
        );
        expect(getByText('Quick')).toBeTruthy();
        expect(getByText('Search')).toBeTruthy();
        expect(getByText('Recipes')).toBeTruthy();
    });

    it('uses one named roving tab stop and selects with arrow, Home, and End keys', async () => {
        Dimensions.set({
            window: { width: 1_024, height: 768, scale: 1, fontScale: 1 },
            screen: { width: 1_024, height: 768, scale: 1, fontScale: 1 }
        });
        const { getAllByRole, getByRole, getByTestId } = await render(<TestControl />);
        const group = getByTestId('segmented-control');
        expect(group.props.accessibilityLabel).toBe('Add food method');
        expect(group.props.accessibilityRole).toBe('radiogroup');
        expect(group.props['aria-orientation']).toBe('horizontal');

        let radios = getAllByRole('radio');
        expect(radios.map((radio) => radio.props.tabIndex)).toEqual([0, -1, -1]);

        await fireEvent(radios[0], 'keyDown', { key: 'ArrowRight', preventDefault: jest.fn() });
        radios = getAllByRole('radio');
        expect(radios.map((radio) => radio.props.accessibilityState.checked)).toEqual([false, true, false]);
        expect(radios.map((radio) => radio.props.tabIndex)).toEqual([-1, 0, -1]);

        await fireEvent(radios[1], 'keyDown', { key: 'End', preventDefault: jest.fn() });
        expect(getByRole('radio', { name: 'Recipes' }).props.accessibilityState.checked).toBe(true);

        await fireEvent(getByRole('radio', { name: 'Recipes' }), 'keyDown', { key: 'Home', preventDefault: jest.fn() });
        expect(getByRole('radio', { name: 'Quick' }).props.accessibilityState.checked).toBe(true);
    });

    it('stacks three options at compact width so labels remain whole', async () => {
        Dimensions.set({
            window: { width: 320, height: 568, scale: 1, fontScale: 2 },
            screen: { width: 320, height: 568, scale: 1, fontScale: 2 }
        });
        const { getByTestId, getByText } = await render(<TestControl />);

        expect(StyleSheet.flatten(getByTestId('segmented-control').props.style)).toEqual(
            expect.objectContaining({ flexDirection: 'column' })
        );
        for (const label of OPTIONS.map((option) => option.label)) {
            expect(getByText(label).props.numberOfLines).toBeUndefined();
        }
    });

    it('keeps a saving form inert for pointer and keyboard input', async () => {
        const onChange = jest.fn();
        const screen = await render(
            <SegmentedControl accessibilityLabel="Goal direction" options={OPTIONS} value="quick" onChange={onChange} disabled />
        );
        const radios = screen.getAllByRole('radio');
        expect(radios.map((radio) => radio.props.tabIndex)).toEqual([-1, -1, -1]);
        for (const radio of radios) expect(radio).toBeDisabled();
        await fireEvent.press(screen.getByRole('radio', { name: 'Search' }));
        await fireEvent(radios[0], 'keyDown', { key: 'ArrowRight', preventDefault: jest.fn() });
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('radio', { name: 'Quick' }).props.accessibilityState.checked).toBe(true);
    });});
