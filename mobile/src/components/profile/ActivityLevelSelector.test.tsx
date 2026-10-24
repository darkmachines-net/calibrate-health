/** @file Regression coverage for Activity Level Selector: ActivityLevelSelector. */

import { fireEvent, render } from '@testing-library/react-native';
import { ACTIVITY_LEVELS } from '@calibrate/shared';
import { ActivityLevelSelector } from './ActivityLevelSelector';

describe('ActivityLevelSelector', () => {
    it('explains every activity choice without guessing an initial answer', () => {
        const onChange = jest.fn();
        const screen = render(<ActivityLevelSelector value={null} onChange={onChange} />);
        expect(screen.getAllByRole('radio')).toHaveLength(5);
        expect(screen.getAllByRole('radio').every((radio) => radio.props.accessibilityState.checked === false)).toBe(true);
        expect(screen.getByText('Most of your day is seated, with little regular exercise.')).toBeOnTheScreen();
        expect(screen.getByText('Strenuous training combined with a highly physical routine.')).toBeOnTheScreen();
        fireEvent.press(screen.getByRole('radio', { name: 'Moderately active' }));
        expect(onChange).toHaveBeenCalledWith(ACTIVITY_LEVELS.MODERATE);
    });

    it('shows the same stored activity value and inline error when editing a profile', () => {
        const screen = render(
            <ActivityLevelSelector value={ACTIVITY_LEVELS.LIGHT} onChange={jest.fn()} errorText="Choose your usual activity." />
        );
        expect(screen.getByRole('radio', { name: 'Lightly active' }).props.accessibilityState.checked).toBe(true);
        expect(screen.getByRole('alert')).toHaveTextContent('Choose your usual activity.');
    });
});
