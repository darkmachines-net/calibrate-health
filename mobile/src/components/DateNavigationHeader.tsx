/** @file Date Navigation Header: Anchors compact day navigation between the app navbar and scrolling route content. */

import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LogDateNavigation } from '../hooks/useLogDateNavigation';
import { resolveSafeHorizontalPadding } from '../layout/adaptiveLayout';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import {
    SCREEN_CONTENT_WIDTHS,
    SCREEN_WIDE_LAYOUT_BREAKPOINT
} from './Screen';
import { DateNavigation } from './DateNavigation';

type DateNavigationHeaderProps = {
    navigation: LogDateNavigation;
    contentWidth?: 'overview' | 'wide';
};

/** Anchors compact day navigation between the app navbar and scrolling route content. */
export function DateNavigationHeader({ navigation, contentWidth = 'wide' }: DateNavigationHeaderProps) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { width } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const usesWideContentPadding = width >= SCREEN_WIDE_LAYOUT_BREAKPOINT;
    const horizontalPadding = resolveSafeHorizontalPadding(
        usesWideContentPadding ? spacing.xl : spacing.lg,
        insets.left,
        insets.right,
        spacing.sm
    );

    return (
        <View testID="date-navigation-header" style={styles.shell}>
            <View
                testID="date-navigation-header-content"
                style={[
                    styles.content,
                    usesWideContentPadding && styles.contentWide,
                    usesWideContentPadding && { maxWidth: SCREEN_CONTENT_WIDTHS[contentWidth] },
                    horizontalPadding
                ]}
            >
                <DateNavigation navigation={navigation} compact unified />
            </View>
        </View>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        shell: {
            backgroundColor: theme.colors.summaryContainer
        },
        content: {
            width: '100%',
            paddingTop: spacing.xs,
            paddingBottom: spacing.sm
        },
        contentWide: {
            alignSelf: 'center'
        }
    });
}
