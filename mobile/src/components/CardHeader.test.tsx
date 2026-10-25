/** @file Regression coverage for Card Header: CardHeader. */

import { render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import { AppButton } from './AppButton';
import { CardHeader } from './CardHeader';
import { themes } from '../theme';

describe('CardHeader', () => {
    it('keeps card typography, metadata alignment, and actions consistent', async () => {
        const screen = await render(
            <CardHeader
                testID="card-header"
                title="Trend"
                metadata="Current trend: 79.2 kg"
                headingTestID="heading-line"
                action={(
                    <View testID="card-header-action-content">
                        <AppButton title="Details" variant="ghost" />
                    </View>
                )}
            />
        );

        const heading = screen.getByRole('header', { name: 'Trend' });
        expect(heading.props['aria-level']).toBe(2);
        expect(heading).toHaveStyle({
            color: themes.light.colors.onSurface,
            fontSize: 20,
            lineHeight: 26,
            fontWeight: '600'
        });
        expect(screen.getByText('Current trend: 79.2 kg')).toHaveStyle({
            color: themes.light.colors.onSurfaceVariant,
            fontSize: 12,
            lineHeight: 16
        });
        expect(screen.getByTestId('heading-line')).toHaveStyle({
            flexDirection: 'row',
            alignItems: 'baseline',
            flexWrap: 'wrap'
        });
        expect(screen.getByTestId('card-header')).toHaveStyle({
            minHeight: 22,
            alignItems: 'flex-start'
        });
        const detailsButton = screen.getByRole('button', { name: 'Details' });
        expect(detailsButton).toHaveStyle({ minHeight: 48 });
        const actionContent = screen.getByTestId('card-header-action-content');
        expect(StyleSheet.flatten(actionContent.parent?.props.style)?.minHeight).toBeUndefined();
    });

    it('supports comfortable density and explicit heading levels', async () => {
        const screen = await render(
            <CardHeader density="comfortable" headingLevel={3} testID="card-header" title="Security" />
        );

        expect(screen.getByTestId('card-header')).toHaveStyle({
            minHeight: 48,
            alignItems: 'center'
        });
        expect(screen.getByRole('header', { name: 'Security' }).props['aria-level']).toBe(3);
    });
});
