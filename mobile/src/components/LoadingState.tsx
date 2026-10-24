/** @file Loading State: Displays a themed activity indicator with a readable loading label. */

import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { spacing, useAppTheme } from '../theme';
import { AppText } from './AppText';

/** Displays a themed activity indicator with a readable loading label. */
export const LoadingState: React.FC<{ label?: string }> = ({ label = 'Loading...' }) => {
    const { colors } = useAppTheme();

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            <ActivityIndicator color={colors.primary} />
            <AppText variant="muted">{label}</AppText>
        </View>
    );
};

const styles = StyleSheet.create({
    root: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md
    }
});
