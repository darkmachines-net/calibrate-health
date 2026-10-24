/** @file App Button: Renders the shared action control with theme variants, focus feedback, and disabled busy semantics. */

import React from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    View,
    type PressableProps,
    type StyleProp,
    type TextStyle
} from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { AppText } from './AppText';
import { useFocusVisible } from './useFocusVisible';

type AppButtonProps = Omit<PressableProps, 'android_ripple'> & {
    title: string;
    buttonRef?: React.Ref<View>;
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
    textStyle?: StyleProp<TextStyle>;
    busy?: boolean;
    busyLabel?: string;
};

/** Renders the shared action control with theme variants, focus feedback, and disabled busy semantics. */
export const AppButton: React.FC<AppButtonProps> = ({
    title,
    buttonRef,
    variant = 'primary',
    leftIcon,
    rightIcon,
    textStyle,
    busy = false,
    busyLabel,
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
    const isBusy = Boolean(busy || accessibilityState?.busy);
    const inactive = Boolean(disabled || isBusy);
    const renderedTitle = isBusy && busyLabel ? busyLabel : title;
    let labelStyle: StyleProp<TextStyle> = styles.secondaryLabel;
    if (variant === 'primary') labelStyle = styles.primaryLabel;
    if (variant === 'danger') labelStyle = styles.dangerLabel;
    const renderedLeftIcon = disabled && React.isValidElement<{ color?: string }>(leftIcon)
        ? React.cloneElement(leftIcon, { color: theme.colors.onSurfaceVariant })
        : leftIcon;
    const renderedRightIcon = disabled && React.isValidElement<{ color?: string }>(rightIcon)
        ? React.cloneElement(rightIcon, { color: theme.colors.onSurfaceVariant })
        : rightIcon;
    let indicatorColor: string = theme.colors.onSurface;
    if (variant === 'primary') indicatorColor = theme.colors.onPrimary;
    if (variant === 'danger') indicatorColor = theme.colors.onDanger;
    if (disabled) indicatorColor = theme.colors.onSurfaceVariant;

    return <Pressable
        {...props}
        ref={buttonRef}
        disabled={inactive}
        accessibilityLabel={accessibilityLabel ?? renderedTitle}
        accessibilityRole={accessibilityRole ?? 'button'}
        accessibilityState={{
            ...accessibilityState,
            busy: isBusy,
            disabled: inactive
        }}
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
            hovered && !inactive && styles.hovered,
            pressed && !inactive && styles.pressed,
            focusVisible && styles.focusVisible,
            disabled && (variant === 'primary' || variant === 'danger' ? styles.disabledSolid : styles.disabled),
            isBusy && styles.busy,
            typeof style === 'function' ? style({ pressed }) : style
        ]}
    >
        <View style={styles.content}>
            {isBusy ? <ActivityIndicator color={indicatorColor} /> : renderedLeftIcon}
            <AppText
                style={[
                    styles.label,
                    labelStyle,
                    textStyle,
                    disabled && styles.disabledLabel
                ]}
            >
                {renderedTitle}
            </AppText>
            {renderedRightIcon}
        </View>
    </Pressable>;
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        base: {
            elevation: 0,
            shadowOpacity: 0,
            minHeight: theme.interaction.minimumTouchTarget,
            borderRadius: theme.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.sm
        },
        primary: {
            backgroundColor: theme.colors.primary
        },
        secondary: {
            backgroundColor: 'transparent',
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control
        },
        danger: {
            backgroundColor: theme.colors.danger
        },
        ghost: {
            backgroundColor: 'transparent'
        },
        hovered: {
            opacity: theme.interaction.hoveredOpacity
        },
        pressed: {
            transform: [{ translateY: 1 }],
            opacity: theme.interaction.pressedOpacity
        },
        focusVisible: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        disabled: {
            opacity: theme.interaction.disabledOpacity
        },
        disabledSolid: {
            backgroundColor: theme.colors.surfaceContainer,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control,
            shadowOpacity: 0,
            elevation: 0,
            opacity: 1
        },
        busy: {
            opacity: theme.interaction.busyOpacity
        },
        disabledLabel: {
            color: theme.colors.onSurfaceVariant
        },
        content: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            minWidth: 0
        },
        label: {
            flexShrink: 1,
            textAlign: 'center',
            ...theme.typography.styles.label,
            fontWeight: '600'
        },
        primaryLabel: {
            color: theme.colors.onPrimary
        },
        dangerLabel: {
            color: theme.colors.onDanger
        },
        secondaryLabel: {
            color: theme.colors.onSurface
        }
    });
}
