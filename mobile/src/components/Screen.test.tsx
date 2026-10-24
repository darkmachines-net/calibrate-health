/** @file Regression coverage for Screen: Screen. */

import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { AppText } from './AppText';
import { Screen } from './Screen';

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => mockSafeAreaInsets
}));

describe('Screen', () => {
    it('exposes the page as a main landmark and preserves view props', async () => {
        const view = await render(
            <Screen testID="responsive-screen">
                <AppText>Dashboard</AppText>
            </Screen>
        );

        expect(view.getByTestId('responsive-screen')).toHaveProp('role', 'main');
    });

    it('preserves an explicit tab stop for keyboard-scrollable content', async () => {
        const view = await render(
            <Screen testID="keyboard-scrollable-screen" tabIndex={0}>
                <AppText>Long diagnostics</AppText>
            </Screen>
        );

        expect(view.getByTestId('keyboard-scrollable-screen')).toHaveProp('tabIndex', 0);
    });
    it('uses the native viewport as the flex floor for scroll content', async () => {
        const view = await render(
            <Screen testID="responsive-screen">
                <AppText>Dashboard</AppText>
            </Screen>
        );
        const contentStyle = StyleSheet.flatten(view.getByTestId('responsive-screen').props.contentContainerStyle);

        expect(contentStyle).toEqual(expect.objectContaining({
            flexGrow: 1,
            width: '100%',
            maxWidth: 1040,
            alignSelf: 'center'
        }));
        expect(contentStyle.minHeight).toBeUndefined();
    });

    it('keeps non-scrolling content beyond horizontal display cutouts', async () => {
        mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 80 };
        try {
            const view = await render(
                <Screen scroll={false} testID="safe-screen">
                    <AppText>Landscape tablet</AppText>
                </Screen>
            );
            const style = StyleSheet.flatten(view.getByTestId('safe-screen').props.style);

            expect(style.paddingLeft).toBe(88);
            expect(style.paddingRight).toBeLessThan(style.paddingLeft);
        } finally {
            mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
        }
    });

    it('uses the shared keyboard-aware scroller for form content', async () => {
        const view = await render(
            <Screen testID="responsive-screen">
                <AppText>Account form</AppText>
            </Screen>
        );

        const scroller = view.container.queryAll((node) => node.type === 'RCTScrollView')[0];
        expect(scroller.props.keyboardDismissMode).toBe('on-drag');
        expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
    });
});
