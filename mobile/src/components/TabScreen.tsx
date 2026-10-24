/** @file Tab Screen: Screen layout for routes whose tab bar already owns the device bottom inset. */

import React from 'react';
import { StyleSheet } from 'react-native';
import { spacing } from '../theme';
import { Screen } from './Screen';

type TabScreenProps = React.ComponentProps<typeof Screen> & {
    reserveFab?: boolean;
};

const TAB_FAB_CLEARANCE = 88; // Expanded FAB height plus two gaps above the tab bar.

/**
 * Screen layout for routes whose tab bar already owns the device bottom inset.
 */
export const TabScreen: React.FC<TabScreenProps> = ({
    reserveFab = false,
    style,
    ...screenProps
}) => (
    <Screen
        {...screenProps}
        style={[
            reserveFab ? styles.contentWithFab : styles.content,
            style
        ]}
    />
);

const styles = StyleSheet.create({
    content: {
        paddingBottom: spacing.lg
    },
    contentWithFab: {
        paddingBottom: TAB_FAB_CLEARANCE
    }
});
