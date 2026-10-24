/** @file Regression coverage for App Action Row: AppActionRow. */

import { fireEvent, render, within } from '@testing-library/react-native';
import { AppActionRow } from './AppActionRow';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { SectionHeader } from './SectionHeader';
import { themes } from '../theme';

describe('AppActionRow', () => {
    it('keeps the heading and secondary action outside the full-width primary target', () => {
        const open = jest.fn();
        const add = jest.fn();
        const screen = render(<AppActionRow accessibilityLabel="View log" onPress={open}
            heading={<SectionHeader title="Food log" />}
            secondaryAction={<AppButton title="Add food" onPress={add} />}>
            <AppText>Breakfast</AppText>
        </AppActionRow>);
        const target = screen.getByRole('link', { name: 'View log' });
        expect(within(target).queryByRole('header')).toBeNull();
        expect(within(target).queryByRole('button')).toBeNull();
        expect(target).toHaveStyle({ minHeight: 48 });
        fireEvent.press(screen.getByRole('button', { name: 'Add food' }));
        expect(add).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
        fireEvent.press(target);
        expect(open).toHaveBeenCalledTimes(1);
        fireEvent(target, 'hoverIn');
        expect(target).toHaveStyle({ backgroundColor: themes.light.colors.surfaceHovered });
    });

    it('disables activation and exposes busy state while an action is pending', () => {
        const open = jest.fn();
        const screen = render(<AppActionRow busy accessibilityLabel="Save ingredient" onPress={open}>
            <AppText>Oats</AppText>
        </AppActionRow>);
        const target = screen.getByRole('link', { name: 'Save ingredient' });
        expect(target).toBeDisabled();
        expect(target.props.accessibilityState.busy).toBe(true);
        fireEvent.press(target);
        expect(open).not.toHaveBeenCalled();
    });
});
