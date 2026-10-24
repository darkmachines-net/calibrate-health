/** @file Date Navigation: Renders an accessible date-navigation action with shared focus and disabled treatment. */

import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { type AppTheme, useAppTheme } from '../theme';
import { useFocusVisible } from './useFocusVisible';

type DateNavigationIconButtonProps = {
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    disabled: boolean;
    onPress: () => void;
    unified?: boolean;
};

/** Renders an accessible date-navigation action with shared focus and disabled treatment. */
export const DateNavigationIconButton: React.FC<DateNavigationIconButtonProps> = ({
    label,
    icon,
    disabled,
    onPress,
    unified = false
}) => {
    const { theme, styles } = useDateNavigationPresentation();
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            disabled={disabled}
            onPress={onPress}
            accessibilityState={{ disabled }}
            onFocus={handleFocus}
            onBlur={handleBlur}
            style={({ pressed }) => [
                styles.iconButton,
                unified && styles.unifiedControl,
                focusVisible && styles.focusVisible,
                disabled && styles.disabled,
                pressed && styles.pressed
            ]}
        >
            <Ionicons
                name={icon}
                size={22}
                color={disabled ? theme.colors.onSurfaceVariant : theme.colors.onSurface}
            />
        </Pressable>
    );
};

/** Memoizes themed date-navigation styles for the current application theme. */
export function useDateNavigationPresentation() {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createDateNavigationStyles(theme), [theme]);
    return { theme, styles };
}

function createDateNavigationStyles(theme: AppTheme) {
    return StyleSheet.create({
        container: {
            gap: theme.spacing.sm
        },
        root: {
            width: '100%',
            alignSelf: 'center',
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm
        },
        rootCompact: {
            gap: theme.spacing.sm
        },
        rootUnified: {
            gap: 0,
            borderWidth: theme.stroke.control,
            borderColor: theme.colors.outline,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.background
        },
        unifiedControl: { borderWidth: 0, backgroundColor: 'transparent' },
        iconButton: {
            width: theme.interaction.minimumTouchTarget,
            height: theme.interaction.minimumTouchTarget,
            borderRadius: theme.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.summaryContainer,
            borderColor: theme.colors.summaryOutline,
            borderWidth: theme.stroke.control,
            overflow: 'hidden'
        },
        datePill: {
            position: 'relative',
            flex: 1,
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            borderRadius: theme.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            backgroundColor: theme.colors.summaryContainer,
            borderColor: theme.colors.summaryOutline,
            borderWidth: theme.stroke.control,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
            overflow: 'hidden'
        },
        datePillCompact: {
            paddingHorizontal: theme.spacing.sm
        },
        dateText: {
            textAlign: 'center',
            flexShrink: 1
        },
        disabled: {
            opacity: 0.45
        },
        focusVisible: {
            outlineWidth: theme.interaction.focusRingWidth,
            outlineStyle: 'solid',
            outlineColor: theme.colors.focusRing
        },
        pressed: {
            backgroundColor: theme.colors.surfacePressed
        }
    });
}
