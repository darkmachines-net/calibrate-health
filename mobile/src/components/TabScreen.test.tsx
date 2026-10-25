/** @file Regression coverage for Tab Screen: TabScreen. */

import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { AppText } from './AppText';
import { TabScreen } from './TabScreen';

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 32, left: 0 })
}));

describe('TabScreen', () => {
    it('does not duplicate the bottom inset already owned by the tab bar', async () => {
        const view = await render(
            <TabScreen testID="tab-screen">
                <AppText>Progress</AppText>
            </TabScreen>
        );
        const contentStyle = StyleSheet.flatten(view.getByTestId('tab-screen').props.contentContainerStyle);

        expect(contentStyle.paddingBottom).toBe(16);
    });

    it('reserves clearance only when the route has a FAB', async () => {
        const view = await render(
            <TabScreen testID="tab-screen" reserveFab>
                <AppText>Food log</AppText>
            </TabScreen>
        );
        const contentStyle = StyleSheet.flatten(view.getByTestId('tab-screen').props.contentContainerStyle);

        expect(contentStyle.paddingBottom).toBe(88);
    });
});
