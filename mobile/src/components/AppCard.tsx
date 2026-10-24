/** @file App Card: Provides intentional card containment with the requested theme density and caller styles. */

import React from 'react';
import { View, StyleSheet, type ViewProps, type ViewStyle } from 'react-native';
import { spacing, type AppTheme, useAppTheme } from '../theme';

type CardDensity = 'compact' | 'comfortable';

// Compact cards use smaller insets while retaining consistent spacing.
const compactCardContentStyle = {
    padding: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.sm
} satisfies ViewStyle;

type AppCardProps = ViewProps & {
    density?: CardDensity;
};

/** Provides intentional card containment with the requested theme density and caller styles. */
export const AppCard: React.FC<AppCardProps> = ({ density = 'comfortable', style, ...props }) => {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    return <View {...props} style={[styles.card, density === 'compact' && compactCardContentStyle, style]} />;
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        card: {
            ...theme.shadows.card,
            backgroundColor: theme.colors.surfaceContainerLow,
            borderColor: theme.colors.outlineVariant,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: theme.radius.lg,
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
            width: '100%'
        }
    });
}
