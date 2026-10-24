/** @file App Action Row: A full-width action with a passive heading and independently focusable secondary controls. */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { useFocusVisible } from './useFocusVisible';

export type AppActionRowProps = Omit<PressableProps, 'children' | 'style' | 'testID'> & {
    accessibilityLabel: string;
    children: React.ReactNode;
    heading?: React.ReactNode;
    secondaryAction?: React.ReactNode;
    secondaryActionPlacement?: 'trailing' | 'footer';
    style?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    secondaryActionStyle?: StyleProp<ViewStyle>;
    selected?: boolean;
    busy?: boolean;
    testID?: string;
    primaryActionTestID?: string;
    secondaryActionTestID?: string;
};

/** A full-width action with a passive heading and independently focusable secondary controls. */
export function AppActionRow({
    children, heading, secondaryAction, secondaryActionPlacement = 'trailing', style,
    contentStyle, secondaryActionStyle, selected = false, busy = false, testID,
    primaryActionTestID, secondaryActionTestID, disabled, accessibilityState,
    accessibilityRole = 'link', onFocus, onBlur, onHoverIn, onHoverOut, ...props
}: AppActionRowProps) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const [hovered, setHovered] = React.useState(false);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible(onFocus, onBlur);
    const inactive = Boolean(disabled || busy);
    const footer = secondaryActionPlacement === 'footer';

    return <View testID={testID} style={[styles.root, style]}>
        {heading}
        <View style={[styles.actions, footer && styles.footer]}>
            <Pressable
                {...props}
                testID={primaryActionTestID}
                accessibilityRole={accessibilityRole}
                accessibilityState={{ ...accessibilityState, selected, busy, disabled: inactive }}
                disabled={inactive}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onHoverIn={(event) => { setHovered(true); onHoverIn?.(event); }}
                onHoverOut={(event) => { setHovered(false); onHoverOut?.(event); }}
                style={({ pressed }) => [
                    styles.primary,
                    selected && styles.selected,
                    hovered && !inactive && styles.hovered,
                    pressed && !inactive && styles.pressed,
                    focusVisible && styles.focusVisible,
                    inactive && styles.inactive,
                    contentStyle
                ]}
            >
                {children}
                {busy && <ActivityIndicator color={theme.colors.onSurfaceVariant} />}
            </Pressable>
            {secondaryAction && <View testID={secondaryActionTestID} style={[
                styles.secondary, footer && styles.secondaryFooter, secondaryActionStyle
            ]}>{secondaryAction}</View>}
        </View>
    </View>;
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        root: { width: '100%', gap: theme.spacing.sm },
        actions: { flexDirection: 'row', alignItems: 'stretch', gap: theme.spacing.sm },
        footer: { flexDirection: 'column' },
        primary: {
            flex: 1, minWidth: 0, minHeight: theme.interaction.minimumTouchTarget,
            paddingVertical: theme.spacing.md, gap: theme.spacing.sm,
            justifyContent: 'center', borderRadius: theme.radius.sm
        },
        secondary: { minHeight: theme.interaction.minimumTouchTarget, justifyContent: 'center' },
        secondaryFooter: { alignItems: 'stretch' },
        selected: { backgroundColor: theme.colors.selectionContainer },
        hovered: { backgroundColor: theme.colors.surfaceHovered },
        pressed: { backgroundColor: theme.colors.surfacePressed },
        inactive: { opacity: theme.interaction.disabledOpacity },
        focusVisible: {
            outlineWidth: theme.interaction.focusRingWidth,
            outlineStyle: 'solid', outlineColor: theme.colors.focusRing
        }
    });
}
