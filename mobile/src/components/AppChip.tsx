/** @file App Chip: Native chip used for meal periods and compact option sets. */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps } from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { AppText } from './AppText';
import { useFocusVisible } from './useFocusVisible';

type AppChipProps = Omit<PressableProps, 'android_ripple'> & {
    label: string;
    selected?: boolean;
    busy?: boolean;
};

/** Native chip used for meal periods and compact option sets. */
export const AppChip: React.FC<AppChipProps> = ({
    label,
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
    const isRadio = accessibilityRole === 'radio';

    return <Pressable
        {...props}
        aria-checked={isRadio ? selected : undefined}
        disabled={inactive}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityRole={accessibilityRole ?? 'button'}
        accessibilityState={{
            ...accessibilityState,
            busy,
            checked: isRadio ? selected : accessibilityState?.checked,
            disabled: inactive,
            selected
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
            styles.root,
            selected && styles.selected,
            hovered && !inactive && (selected ? styles.hoveredSelected : styles.hovered),
            pressed && !inactive && styles.pressed,
            focusVisible && styles.focusVisible,
            disabled && styles.disabled,
            busy && styles.busy,
            typeof style === 'function' ? style({ pressed }) : style
        ]}
    >
        <View style={styles.content}>
            {busy ? <ActivityIndicator color={selected ? theme.colors.onSelectionContainer : theme.colors.onSurface} /> : null}
            <AppText numberOfLines={2} style={[styles.label, selected && styles.selectedLabel]}>
                {label}
            </AppText>
        </View>
    </Pressable>;
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        root: {
            minHeight: theme.interaction.minimumTouchTarget,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control,
            borderRadius: theme.radius.pill,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            backgroundColor: theme.colors.surfaceContainerLow,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden'
        },
        selected: {
            borderColor: theme.colors.selection,
            backgroundColor: theme.colors.selectionContainer
        },
        hovered: {
            backgroundColor: theme.colors.surfaceHovered
        },
        hoveredSelected: {
            opacity: theme.interaction.hoveredOpacity
        },
        pressed: {
            backgroundColor: theme.colors.surfacePressed,
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
        busy: {
            opacity: theme.interaction.busyOpacity
        },
        content: {
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.xs
        },
        label: {
            color: theme.colors.onSurface,
            textAlign: 'center',
            ...theme.typography.styles.label
        },
        selectedLabel: {
            color: theme.colors.onSelectionContainer
        }
    });
}
