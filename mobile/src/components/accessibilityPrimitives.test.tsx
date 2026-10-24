/** @file Regression coverage for accessibility Primitives: mobile accessibility primitives. */

import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { AppButton } from './AppButton';
import { AppChip } from './AppChip';
import { AppIconButton } from './AppIconButton';
import { SectionHeader } from './SectionHeader';
import { TextField } from './TextField';
import { themes } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

describe('mobile accessibility primitives', () => {
    it('gives buttons a useful default role, label, and disabled state', async () => {
        const { getByRole } = await render(<AppButton title="Save meal" disabled />);
        const button = getByRole('button', { name: 'Save meal' });
        expect(button.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    });

    it('keeps a disabled button icon legible on its disabled surface', async () => {
        const TestIcon = ({ color }: { color: string }) => <Text testID="button-icon" style={{ color }}>icon</Text>;
        const { getByTestId } = await render(
            <AppButton title="Search" disabled leftIcon={<TestIcon color={themes.light.colors.onPrimary} />} />
        );

        expect(StyleSheet.flatten(getByTestId('button-icon').props.style)).toEqual(
            expect.objectContaining({ color: themes.light.colors.onSurfaceVariant })
        );
    });

    it('uses pressed styling without the clipped Android ripple that can hide labels', async () => {
        const { getByRole } = await render(<AppButton title="Create account" />);

        expect(getByRole('button', { name: 'Create account' }).props.android_ripple).toBeUndefined();
    });

    it('uses a text field label as its accessible name even when the visual label is hidden', async () => {
        const { getByLabelText } = await render(
            <TextField label="Search foods" hideLabel value="" onChangeText={jest.fn()} />
        );
        expect(getByLabelText('Search foods')).toBeTruthy();
    });

    it('preserves explicit accessible names supplied by feature screens', async () => {
        const { getByRole, getByLabelText } = await render(
            <>
                <AppButton title="Save" accessibilityLabel="Save today's weigh-in" />
                <TextField label="Server" accessibilityLabel="Self-hosted server URL" />
            </>
        );
        expect(getByRole('button', { name: "Save today's weigh-in" })).toBeTruthy();
        expect(getByLabelText('Self-hosted server URL')).toBeTruthy();
    });

    it('exposes selected filter chips as checked radios', async () => {
        const { getByRole } = await render(
            <AppChip label="All saved foods" accessibilityRole="radio" selected />
        );

        expect(getByRole('radio', { name: 'All saved foods' }).props.accessibilityState).toEqual(
            expect.objectContaining({ checked: true, selected: true })
        );
    });
    it('uses Android-sized touch targets for shared buttons and chips', async () => {
        const { getByRole } = await render(
            <>
                <AppButton title="Save" />
                <AppButton title="Retry" accessibilityState={{ busy: true }} />
                <AppChip label="Breakfast" selected />
            </>
        );

        expect(getByRole('button', { name: 'Save' })).toHaveStyle({ minHeight: 48 });
        expect(getByRole('button', { name: 'Retry' }).props.accessibilityState).toEqual(
            expect.objectContaining({ busy: true, disabled: true })
        );
        expect(getByRole('button', { name: 'Breakfast' })).toHaveStyle({ minHeight: 48 });
        expect(getByRole('button', { name: 'Breakfast' }).props.accessibilityState).toEqual(
            expect.objectContaining({ selected: true })
        );
    });

    it('announces and visually distinguishes busy, disabled, and selected states', async () => {
        const { getByRole } = await render(
            <>
                <AppButton title="Save" busy busyLabel="Saving..." />
                <AppButton title="Retry" accessibilityState={{ busy: true }} />
                <AppChip label="Breakfast" selected />
                <AppIconButton icon="refresh" accessibilityLabel="Refreshing trend" busy />
            </>
        );

        expect(getByRole('button', { name: 'Saving...' }).props.accessibilityState).toEqual(
            expect.objectContaining({ busy: true, disabled: true })
        );
        expect(getByRole('button', { name: 'Retry' }).props.accessibilityState).toEqual(
            expect.objectContaining({ busy: true, disabled: true })
        );
        expect(getByRole('button', { name: 'Breakfast' })).toHaveStyle({
            borderColor: themes.light.colors.selection,
            backgroundColor: themes.light.colors.selectionContainer
        });
        expect(getByRole('button', { name: 'Refreshing trend' }).props.accessibilityState).toEqual(
            expect.objectContaining({ busy: true, disabled: true })
        );
    });

    it('uses the contrast-safe outline for interactive control boundaries', async () => {
        const { getByRole } = await render(
            <>
                <AppButton title="Secondary action" variant="secondary" />
                <AppChip label="Dinner" />
                <AppIconButton icon="settings" accessibilityLabel="Open settings" />
            </>
        );

        expect(getByRole('button', { name: 'Secondary action' })).toHaveStyle({
            borderColor: themes.light.colors.outline
        });
        expect(getByRole('button', { name: 'Dinner' })).toHaveStyle({
            borderColor: themes.light.colors.outline
        });
        expect(getByRole('button', { name: 'Open settings' })).toHaveStyle({
            borderColor: themes.light.colors.outline
        });
    });

    it('shows the semantic focus ring when keyboard focus reaches a shared control', async () => {
        const { getByRole } = await render(<AppButton title="Continue" />);

        const button = getByRole('button', { name: 'Continue' });
        await fireEvent(button, 'focus');

        expect(button).toHaveStyle({
            outlineColor: themes.light.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: themes.light.interaction.focusRingWidth
        });
    });

    it('exposes section titles as level-two headings by default', async () => {
        const { getByRole } = await render(<SectionHeader title="Preferences" />);

        expect(getByRole('header', { name: 'Preferences' }).props['aria-level']).toBe(2);
    });
});
