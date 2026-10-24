/** @file App Section: Groups related page content without implying a separate surface or action. */

import { StyleSheet, View, type ViewProps } from 'react-native';
import { useAppTheme } from '../theme';

type AppSectionProps = ViewProps & {
    density?: 'compact' | 'comfortable';
    divider?: boolean;
};

/** Groups related page content without implying a separate surface or action. */
export function AppSection({ density = 'comfortable', divider = false, style, ...props }: AppSectionProps) {
    const theme = useAppTheme();
    return <View {...props} style={[
        { width: '100%', gap: density === 'compact' ? theme.spacing.sm : theme.spacing.md },
        divider && {
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.outlineVariant,
            paddingTop: theme.spacing.xl
        },
        style
    ]} />;
}
