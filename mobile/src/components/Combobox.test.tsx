/** @file Regression coverage for Combobox: Combobox. */

import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Combobox, Listbox } from './Combobox';
import { OverlaySelect } from './OverlaySelect';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));
jest.mock('../hooks/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => true }));

const options = [
    { value: 'america', label: 'America', description: 'North and South America' },
    { value: 'europe', label: 'Europe' },
    { value: 'disabled', label: 'Disabled', disabled: true },
    { value: 'pacific', label: 'Pacific' }
] as const;

describe('Combobox', () => {
    it('exposes selected value and opens its listbox from the keyboard', async () => {
        const screen = await render(
            <Combobox label="Region" value="europe" options={options} onChange={jest.fn()} />
        );

        const trigger = screen.getByRole('combobox', { name: 'Region' });
        expect(trigger).toHaveAccessibilityValue({ text: 'Europe' });
        expect(trigger.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));


        await fireEvent(trigger, 'keyDown', { key: 'ArrowDown', preventDefault: jest.fn() });
        expect(screen.getByTestId('combobox-listbox').props.nativeID).toBe('combobox-listbox');
        expect(trigger.props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));

    });

    it('filters searchable options and selects without duplicating field text', async () => {
        const onChange = jest.fn();
        const screen = await render(
            <Combobox label="Region" options={options} onChange={onChange} searchable />
        );

        await fireEvent.press(screen.getByRole('combobox', { name: 'Region' }));
        expect(screen.getByLabelText('Search Region')).toHaveProp('autoFocus', true);
        await fireEvent.changeText(screen.getByLabelText('Search Region'), 'pac');
        expect(screen.getByText('Pacific')).toBeTruthy();
        expect(screen.queryByText('Europe')).toBeNull();
        await fireEvent.press(screen.getByLabelText('Pacific'));
        expect(onChange).toHaveBeenCalledWith('pacific');
    });

    it('closes on Escape and marks invalid controls', async () => {
        const screen = await render(
            <Combobox label="Region" options={options} onChange={jest.fn()} errorText="Choose a region." />
        );

        const trigger = screen.getByRole('combobox', { name: 'Region' });
        expect(trigger.props.accessibilityHint).toContain('Choose a region.');
        await fireEvent.press(trigger);
        await fireEvent(screen.getByLabelText('America'), 'keyDown', {
            key: 'Escape',
            preventDefault: jest.fn()
        });
        expect(trigger.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    });
});

describe('OverlaySelect compatibility', () => {
    it('preserves controlled legacy selection while using the shared combobox', async () => {
        function Harness() {
            const [value, setValue] = useState('america');
            const [open, setOpen] = useState(false);
            return (
                <OverlaySelect
                    accessibilityLabel="Select region"
                    value={value}
                    options={[...options]}
                    isOpen={open}
                    onToggle={() => setOpen((current) => !current)}
                    onChange={(nextValue) => {
                        setValue(nextValue);
                        setOpen(false);
                    }}
                />
            );
        }

        const screen = await render(<Harness />);
        const trigger = screen.getByRole('combobox', { name: 'Select region' });
        await fireEvent.press(trigger);
        await fireEvent.press(screen.getByLabelText('Europe'));
        expect(trigger).toHaveAccessibilityValue({ text: 'Europe' });
        expect(trigger.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    });
});
describe('Listbox', () => {
    it('supports typeahead, Home/End, arrows, Enter, and disabled-option skipping', async () => {
        const onActiveChange = jest.fn();
        const onSelect = jest.fn();
        const screen = await render(
            <Listbox
                label="Regions"
                options={options}
                value="america"
                onActiveChange={onActiveChange}
                onSelect={onSelect}
                onDismiss={jest.fn()}
            />
        );

        const america = screen.getByLabelText('America');
        await fireEvent(america, 'keyDown', { key: 'p', preventDefault: jest.fn() });
        expect(onActiveChange).toHaveBeenLastCalledWith('pacific');
        await fireEvent(america, 'keyDown', { key: 'End', preventDefault: jest.fn() });
        expect(onActiveChange).toHaveBeenLastCalledWith('pacific');
        await fireEvent(america, 'keyDown', { key: 'ArrowUp', preventDefault: jest.fn() });
        expect(onActiveChange).toHaveBeenLastCalledWith('pacific');
        await fireEvent(america, 'keyDown', { key: 'Enter', preventDefault: jest.fn() });
        expect(onSelect).toHaveBeenCalledWith('america');
    });

    it('restores a keyboard-focusable option when filtering removes the active row', async () => {
        const onActiveChange = jest.fn();
        const screen = await render(
            <Listbox
                label="Regions"
                options={options}
                onActiveChange={onActiveChange}
                onSelect={jest.fn()}
                onDismiss={jest.fn()}
                focusInitialOption={false}
            />
        );
        await fireEvent(screen.getByLabelText('Pacific'), 'focus');
        expect(screen.getByLabelText('Pacific').props.tabIndex).toBe(0);

        await screen.rerender(
            <Listbox
                label="Regions"
                options={[options[1]]}
                onActiveChange={onActiveChange}
                onSelect={jest.fn()}
                onDismiss={jest.fn()}
                focusInitialOption={false}
            />
        );
        expect(screen.getByLabelText('Europe').props.tabIndex).toBe(0);
    });
});
