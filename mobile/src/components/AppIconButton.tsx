/** @file App Icon Button: Consistent icon-only control with an accessible 48dp interaction target. */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { type AppTheme, useAppTheme } from '../theme';
import { useFocusVisible } from './useFocusVisible';

type AppIconButtonProps = Omit<PressableProps, 'accessibilityLabel' | 'children'> & {
    accessibilityLabel: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    iconSize?: number;
    variant?: 'surface' | 'container' | 'ghost';
    selected?: boolean;
    busy?: boolean;
};

/** Consistent icon-only control with an accessible 48dp interaction target. */
export const AppIconButton: React.FC<AppIconButtonProps> = ({
    icon,
    iconColor,
    iconSize = 20,
    variant = 'surface',
    selected = false,
    busy = false,
    disabled,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    style,
    onBlur,
    onFocus,
    onHoverIn,
    onHoverOut,
    ...props
}) => {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const [hovered, setHovered] = React.useState(false);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible(onFocus, onBlur);
    const inactive = Boolean(disabled || busy);
    let defaultIconColor: string = variant === 'container' ? theme.colors.primary : theme.colors.onSurface;
    if (selected) defaultIconColor = theme.colors.onSelectionContainer;
    if (disabled) defaultIconColor = theme.colors.onSurfaceVariant;

    return (
        <Pressable
            {...props}
            accessibilityLabel={accessibilityLabel}
            accessibilityRole={accessibilityRole ?? 'button'}
            accessibilityState={{
                ...accessibilityState,
                busy,
                disabled: inactive,
                selected
            }}
            disabled={inactive}
            onBlur={handleBlur}
            onFocus={handleFocus}
            onHoverIn={(event) => {
                setHovered(true);
                onHoverIn?.(event);
            }}
            onHoverOut={(event) => {
                setHovered(false);
                onHoverOut?.(event);
            }}
            style={({ pressed }) => [
                styles.base,
                styles[variant],
                selected && styles.selected,
                hovered && !inactive && (selected ? styles.hoveredSelected : styles.hovered),
                pressed && !inactive && styles.pressed,
                focusVisible && styles.focusVisible,
                disabled && styles.disabled,
                busy && styles.busy,
                typeof style === 'function' ? style({ pressed }) : style
            ]}
        >
            <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
            >
                {busy
                    ? <ActivityIndicator color={defaultIconColor} />
                    : <Ionicons name={icon} size={iconSize} color={iconColor ?? defaultIconColor} />}
            </View>
        </Pressable>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        base: {
            width: theme.interaction.minimumTouchTarget,
            height: theme.interaction.minimumTouchTarget,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.md
        },
        surface: {
            backgroundColor: theme.colors.surfaceContainerLow,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control
        },
        container: {
            backgroundColor: theme.colors.primaryContainer,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control
        },
        ghost: {
            backgroundColor: 'transparent'
        },
        selected: {
            backgroundColor: theme.colors.selectionContainer,
            borderColor: theme.colors.selection,
            borderWidth: theme.stroke.control
        },
        hovered: {
            backgroundColor: theme.colors.surfaceHovered
        },
        hoveredSelected: {
            opacity: theme.interaction.hoveredOpacity
        },
        pressed: {
            backgroundColor: theme.colors.surfacePressed,
            opacity: theme.interaction.pressedOpacity,
            transform: [{ translateY: 1 }]
        },
        focusVisible: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        disabled: {
            opacity: theme.interaction.disabledOpacity
        },
        busy: {
            opacity: theme.interaction.busyOpacity
        }
    });
}
