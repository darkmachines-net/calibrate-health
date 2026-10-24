/** @file Regression coverage for App Choice Group: AppChoiceGroup. */

import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { AppChoiceGroup, type AppChoiceOption } from './AppChoiceGroup';
import type { FocusableFormControl } from './FormField';

const OPTIONS: AppChoiceOption<string>[] = [
    { value: 'gentle', label: 'Gentle', description: 'A smaller daily change.' },
    { value: 'blocked', label: 'Unavailable', description: 'A larger daily change.', disabled: true, disabledReason: 'Below your minimum target.' },
    { value: 'steady', label: 'Steady', description: 'A consistent daily change.' }
];

function Choices({ initialValue = null }: { initialValue?: string | null }) {
    const [value, onChange] = useState<string | null>(initialValue);
    return <AppChoiceGroup label="Pace" options={OPTIONS} value={value} onChange={onChange} />;
}

describe('AppChoiceGroup', () => {
    it('leaves a new selection unanswered and exposes descriptions and disabled reasons', async () => {
        const screen = await render(<Choices />);
        const radios = screen.getAllByRole('radio');
        expect(radios.map((radio) => radio.props.accessibilityState.checked)).toEqual([false, false, false]);
        expect(radios.map((radio) => radio.props.tabIndex)).toEqual([0, -1, -1]);
        expect(screen.getByLabelText('Pace').props['aria-orientation']).toBe('vertical');
        expect(screen.getByRole('radio', { name: 'Unavailable' })).toBeDisabled();
        expect(screen.getByRole('radio', { name: 'Unavailable' }).props.accessibilityHint).toBe(
            'A larger daily change. Below your minimum target.'
        );
        expect(screen.getByText('Below your minimum target.')).toBeOnTheScreen();
        expect(screen.getByText('A smaller daily change.').props.numberOfLines).toBeUndefined();
    });

    it('selects with touch and keyboard while skipping unavailable choices', async () => {
        const screen = await render(<Choices />);
        await fireEvent.press(screen.getByRole('radio', { name: 'Gentle' }));
        expect(screen.getByRole('radio', { name: 'Gentle' }).props.accessibilityState.checked).toBe(true);

        await fireEvent(screen.getByRole('radio', { name: 'Gentle' }), 'keyDown', { key: 'ArrowDown', preventDefault: jest.fn() });
        expect(screen.getByRole('radio', { name: 'Steady' }).props.accessibilityState.checked).toBe(true);
        expect(screen.getAllByRole('radio').map((radio) => radio.props.tabIndex)).toEqual([-1, -1, 0]);

        await fireEvent(screen.getByRole('radio', { name: 'Steady' }), 'keyDown', { key: 'ArrowDown', preventDefault: jest.fn() });
        expect(screen.getByRole('radio', { name: 'Gentle' }).props.accessibilityState.checked).toBe(true);
        await fireEvent(screen.getByRole('radio', { name: 'Gentle' }), 'keyDown', { key: 'End', preventDefault: jest.fn() });
        expect(screen.getByRole('radio', { name: 'Steady' }).props.accessibilityState.checked).toBe(true);
        await fireEvent(screen.getByRole('radio', { name: 'Steady' }), 'keyDown', { key: 'Home', preventDefault: jest.fn() });
        expect(screen.getByRole('radio', { name: 'Gentle' }).props.accessibilityState.checked).toBe(true);
        await fireEvent.press(screen.getByRole('radio', { name: 'Unavailable' }));
        expect(screen.getByRole('radio', { name: 'Gentle' }).props.accessibilityState.checked).toBe(true);
    });

    it('associates the group error and supplies a focusable control contract', async () => {
        const controlRef: { current: FocusableFormControl | null } = { current: null };
        const screen = await render(
            <AppChoiceGroup
                label="Pace"
                options={OPTIONS}
                value={null}
                onChange={jest.fn()}
                errorText="Choose a pace."
                controlRef={controlRef}
            />
        );
        const group = screen.getByLabelText('Pace');
        expect(group.props['aria-invalid']).toBe(true);
        expect(group.props['aria-describedby']).toContain('-error');
        expect(screen.getByRole('alert')).toHaveTextContent('Choose a pace.');
        expect(typeof controlRef.current?.focus).toBe('function');
    });

    it('requests focus and announces the group when validation fails', async () => {
        const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(jest.fn());
        const controlRef: { current: FocusableFormControl | null } = { current: null };
        const onChange = jest.fn();
        const screen = await render(
            <AppChoiceGroup label="Pace" options={OPTIONS} value="steady" onChange={onChange} controlRef={controlRef} />
        );
        const focus = jest.spyOn(controlRef.current!, 'focus');
        await screen.rerender(
            <AppChoiceGroup label="Pace" options={OPTIONS} value="steady" onChange={onChange} controlRef={controlRef} errorText="Review your pace." focusError />
        );
        expect(focus).toHaveBeenCalledTimes(1);
        expect(announce).toHaveBeenCalledWith('Review your pace.');
        announce.mockRestore();
    });
    it('keeps unavailable groups inert when no option is enabled', async () => {
        const onChange = jest.fn();
        const screen = await render(
            <AppChoiceGroup label="Pace" options={OPTIONS.map((option) => ({ ...option, disabled: true }))} value={null} onChange={onChange} />
        );
        expect(screen.getAllByRole('radio').map((radio) => radio.props.tabIndex)).toEqual([-1, -1, -1]);
        await fireEvent(screen.getByRole('radio', { name: 'Gentle' }), 'keyDown', { key: 'End', preventDefault: jest.fn() });
        expect(onChange).not.toHaveBeenCalled();
    });
});
